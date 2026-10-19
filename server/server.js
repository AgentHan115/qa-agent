import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { initDb } from "./db/postgres.js";
import {
  insertDocument,
  markFailed,
  markProcessing,
  findDocument,
  findDocumentByFilename,
  listDocumentsByStatus,
} from "./db/documents.js";
import {
  answerQuestion,
  streamAnswer,
  MODES,
  WebSearchUnavailableError,
  RetrievalUnavailableError,
  NoSourcesError,
} from "./pipeline/answer.js";
import { ContextOverflowError } from "./lib/guards.js";
import { enqueueIngestion } from "./lib/queue.js";
import { countVectors, VectorsMissingError } from "./lib/vectors.js";
import { reconcileReadyDocuments, vectorsMissingReason } from "./lib/reconcile.js";
import { describeRuntime } from "./lib/runtime-info.js";
import client from "prom-client";

dotenv.config();

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const queryLatency = new client.Histogram({
  name: "query_latency_ms",
  help: "RAG query latency in milliseconds",
  labelNames: ["endpoint"],
  buckets: [500, 1000, 3000, 5000, 10000, 15000, 20000, 30000],
});
register.registerMetric(queryLatency);

const chatOutcomes = new client.Counter({
  name: "chat_requests_total",
  help: "Chat requests by outcome (ok, client_aborted, or the error type)",
  labelNames: ["endpoint", "outcome"],
});
register.registerMetric(chatOutcomes);

// A query found no vectors for a "ready" document: record why, so the status
// endpoint and later queries report it instead of answering from empty context.
const handleVectorsMissing = async (documentId) => {
  const reason = vectorsMissingReason(null, 0);
  console.error(`[chat] ${documentId}: ${reason}`);
  await markFailed(documentId, reason);
  return reason;
};

// Forwards async handler rejections to the error middleware (Express 4 doesn't).
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// POST /upload
// Saves the file, inserts a row in postgres, kicks off async ingestion.
// Returns 202 immediately — client polls GET /documents/:id for status.
app.post("/upload", upload.single("file"), route(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided" });
  }

  const documentId = randomUUID();
  const { path: filePath, originalname: filename } = req.file;

  await insertDocument(documentId, filename, filePath);

  // Enqueue ingestion — BullMQ worker processes it with retries and crash recovery
  await enqueueIngestion(documentId, filePath, filename);

  res.status(202).json({ documentId, status: "processing", filename });
}));

// GET /documents/default
// Returns the default document (DEFAULT_DOCUMENT). The frontend uses this
// on mount so the user can start asking questions without uploading anything.
app.get("/documents/default", route(async (req, res) => {
  const doc = await findDocumentByFilename(DEFAULT_DOCUMENT.filename);
  if (!doc) return res.status(404).json({ error: "Default document not ready yet" });
  const { file_path, ...safe } = doc;
  res.json(safe);
}));

// GET /documents/:documentId
// Poll this to check ingestion status before querying.
app.get("/documents/:documentId", route(async (req, res) => {
  const doc = await findDocument(req.params.documentId);
  if (!doc) {
    return res.status(404).json({ error: "Document not found" });
  }
  // Strip internal file_path before sending to client
  const { file_path, ...safe } = doc;
  res.json(safe);
}));

// POST /documents/:documentId/reingest
// Re-embeds a document from its stored file (e.g. after its vectors went
// missing). Explicit rather than automatic because it costs embedding calls.
app.post("/documents/:documentId/reingest", route(async (req, res) => {
  const doc = await findDocument(req.params.documentId);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  if (doc.status === "processing") {
    return res.status(409).json({ error: "Document is already being processed" });
  }
  await markProcessing(doc.id);
  await enqueueIngestion(doc.id, doc.file_path, doc.filename);
  res.status(202).json({ documentId: doc.id, status: "processing", filename: doc.filename });
}));

// GET /runtime — exact model/runtime configuration (no secrets), for
// reproducibility. Eval runs store this alongside their results.
app.get("/runtime", route(async (req, res) => {
  res.json(await describeRuntime());
}));

// GET /metrics — Prometheus scrape endpoint
app.get("/metrics", route(async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
}));

// Shared request validation for /chat and /chat/stream. Responds and returns
// null if the request can't be served; otherwise returns the parsed options.
const parseChatRequest = async (req, res) => {
  const { question, documentId } = req.query;
  const mode = req.query.mode || "hybrid";

  if (!question) return res.status(400).json({ error: "question is required" }) && null;
  if (!MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of ${MODES.join(", ")}` }) && null;
  }
  // Web-only answers don't touch a document.
  if (mode === "web") return { question, documentId: null, mode };

  if (!documentId) return res.status(400).json({ error: "documentId is required" }) && null;
  const doc = await findDocument(documentId);
  if (!doc) return res.status(404).json({ error: "Document not found" }) && null;
  if (doc.status === "processing") {
    return res.status(409).json({ error: "Document is still being processed" }) && null;
  }
  if (doc.status === "failed") {
    return res.status(422).json({ error: "Document ingestion failed", detail: doc.error }) && null;
  }
  return { question, documentId, mode };
};

// Maps pipeline failures to HTTP responses. Missing vectors also mark the
// document failed, so later requests get a 422 before doing any work.
const errorResponse = async (err, opts) => {
  if (err instanceof VectorsMissingError) {
    return { status: 422, error: "Document ingestion failed", detail: await handleVectorsMissing(opts.documentId) };
  }
  if (err instanceof ContextOverflowError) {
    return { status: 422, error: "Prompt too large for the model's context window", detail: err.message };
  }
  if (err instanceof WebSearchUnavailableError) return { status: 502, error: "Web search unavailable", detail: err.message };
  if (err instanceof RetrievalUnavailableError || err instanceof NoSourcesError) {
    return { status: 503, error: "No sources available", detail: err.message };
  }
  return { status: 500, error: "Failed to generate answer", detail: err.message };
};

// Aborts when the client goes away before the response is complete. Uses the
// response's "close" event: the request's "close" can fire as soon as a GET
// has been read, which would cancel healthy requests.
const abortOnDisconnect = (res) => {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort(Object.assign(new Error("Client disconnected"), { name: "AbortError" }));
  });
  return controller.signal;
};

// GET /chat?question=...&documentId=...&mode=docs|web|hybrid (default hybrid)
// One grounded answer citing document sources [D#] and web sources [W#].
// documentId is required except in web mode.
app.get("/chat", route(async (req, res) => {
  const opts = await parseChatRequest(req, res);
  if (!opts) return;
  const signal = abortOnDisconnect(res);

  const t0 = Date.now();
  try {
    const { answer, sources, citations, meta } = await answerQuestion({ ...opts, signal });
    const totalMs = Date.now() - t0;
    queryLatency.observe({ endpoint: "/chat" }, totalMs);
    chatOutcomes.inc({ endpoint: "/chat", outcome: "ok" });
    res.json({
      answer,
      mode: opts.mode,
      sources,
      citations,
      web: meta.web && { status: meta.web.status, error: meta.web.error },
      retrieval: meta.retrieval && { status: meta.retrieval.status, error: meta.retrieval.error },
      meta: { ...meta, total_ms: totalMs },
    });
  } catch (err) {
    if (signal.aborted) {
      chatOutcomes.inc({ endpoint: "/chat", outcome: "client_aborted" });
      console.warn(`[chat] client disconnected after ${Date.now() - t0}ms; work cancelled`);
      return;
    }
    const { status, ...body } = await errorResponse(err, opts);
    chatOutcomes.inc({ endpoint: "/chat", outcome: err.name || "Error" });
    console.error(`[chat] ${status}: ${err.message}`);
    res.status(status).json(body);
  }
}));

// GET /chat/stream — same parameters as /chat, as Server-Sent Events:
//   event "sources" { sources, web, retrieval }   once retrieval/search finish
//   data { token }                                answer tokens
//   data { done: true, citations, meta }
//   event "apierror" { status, error, detail }
app.get("/chat/stream", route(async (req, res) => {
  const opts = await parseChatRequest(req, res);
  if (!opts) return;
  const signal = abortOnDisconnect(res);

  // SSE headers — must be set before any write
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const t0 = Date.now();
  const meta = {};
  let ttftMs;

  try {
    for await (const event of streamAnswer({ ...opts, signal }, meta)) {
      if (event.sources) {
        meta.sources_sent_ms = Date.now() - t0;
        res.write(`event: sources\ndata: ${JSON.stringify(event)}\n\n`);
      } else {
        if (ttftMs === undefined) ttftMs = Date.now() - t0;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
    const totalMs = Date.now() - t0;
    queryLatency.observe({ endpoint: "/chat/stream" }, totalMs);
    chatOutcomes.inc({ endpoint: "/chat/stream", outcome: "ok" });
    const { citations, ...rest } = meta;
    res.write(
      `data: ${JSON.stringify({ done: true, citations, meta: { ...rest, ttft_ms: ttftMs, total_ms: totalMs } })}\n\n`
    );
  } catch (err) {
    if (signal.aborted) {
      chatOutcomes.inc({ endpoint: "/chat/stream", outcome: "client_aborted" });
      console.warn(`[stream] client disconnected after ${Date.now() - t0}ms; work cancelled`);
      return;
    }
    const body = await errorResponse(err, opts);
    chatOutcomes.inc({ endpoint: "/chat/stream", outcome: err.name || "Error" });
    console.error(`[stream] ${body.status}: ${err.message}`);
    res.write(`event: apierror\ndata: ${JSON.stringify(body)}\n\n`);
  } finally {
    res.end();
  }
}));

// Last-resort handler for errors thrown outside the chat pipeline (e.g. the
// database is down). Express 4 doesn't catch rejected promises itself, and an
// unhandled rejection would crash the process; route() forwards them here.
app.use((err, req, res, next) => {
  // e.g. pg reports a refused connection as an AggregateError with an empty message
  const detail = err.message || err.code || err.name;
  console.error(`[http] ${req.method} ${req.path}: ${detail}`);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: "Internal server error", detail });
});

const PORT = process.env.PORT || 5001;

// Demo document ingested on startup: "GPT-4 Technical Report", arXiv:2303.08774v3,
// downloaded by scripts/fetch-demo-doc.sh (not committed; see that script).
const DEFAULT_DOCUMENT = { filename: "gpt-4.pdf", path: "uploads/gpt-4.pdf" };

// Ingest the default PDF on startup if it hasn't been ingested yet, or retry
// it (once per boot) if its last ingestion failed — e.g. after reconcile found
// its vectors missing. Other failed documents are re-ingested only on request.
const seedDefaultDocument = async () => {
  const { filename, path } = DEFAULT_DOCUMENT;
  const existing = await findDocumentByFilename(filename);
  if (existing?.status === "failed") {
    console.log(`[seed] default document failed previously (${existing.error}); re-ingesting`);
    await markProcessing(existing.id);
    await enqueueIngestion(existing.id, existing.file_path, existing.filename);
    return;
  }
  if (existing) {
    console.log(`[seed] default document already in DB (status: ${existing.status})`);
    return;
  }

  // The demo PDF isn't committed (see scripts/fetch-demo-doc.sh).
  if (!existsSync(path)) {
    console.warn(`[seed] ${path} not found; run "sh server/scripts/fetch-demo-doc.sh" to download the demo document`);
    return;
  }

  const documentId = randomUUID();
  await insertDocument(documentId, filename, path);
  console.log(`[seed] ingesting default document ${filename}...`);

  await enqueueIngestion(documentId, path, filename);
};

// Initialize DB schema, reconcile Postgres status with Chroma, then start.
initDb()
  .then(async () => {
    const { checked, drifted } = await reconcileReadyDocuments({
      listDocumentsByStatus,
      countVectors,
      markFailed,
    });
    console.log(`[reconcile] checked ${checked} ready documents, ${drifted.length} missing vectors`);
    const server = app.listen(PORT, () => console.log(`server running on port ${PORT}`));
    // Node closes requests after 300s by default; local models can be slower
    // than that on long prompts (the baseline web path took ~290s on a Mac).
    server.requestTimeout = parseInt(process.env.SERVER_REQUEST_TIMEOUT_MS || "900000", 10);
    await seedDefaultDocument();
  })
  .catch((err) => {
    console.error("[db] failed to initialize:", err.message);
    process.exit(1);
  });
