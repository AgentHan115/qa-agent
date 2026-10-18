import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import { randomUUID } from "crypto";
import { initDb } from "./db/postgres.js";
import {
  insertDocument,
  markFailed,
  markProcessing,
  findDocument,
  findDocumentByFilename,
  listDocumentsByStatus,
} from "./db/documents.js";
import { answerQuestion, streamAnswer, MODES, WebSearchUnavailableError } from "./pipeline/answer.js";
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

// A query found no vectors for a "ready" document: record why, so the status
// endpoint and later queries report it instead of answering from empty context.
const handleVectorsMissing = async (documentId) => {
  const reason = vectorsMissingReason(null, 0);
  console.error(`[chat] ${documentId}: ${reason}`);
  await markFailed(documentId, reason);
  return reason;
};

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
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided" });
  }

  const documentId = randomUUID();
  const { path: filePath, originalname: filename } = req.file;

  await insertDocument(documentId, filename, filePath);

  // Enqueue ingestion — BullMQ worker processes it with retries and crash recovery
  await enqueueIngestion(documentId, filePath, filename);

  res.status(202).json({ documentId, status: "processing", filename });
});

// GET /documents/default
// Returns the default document (hbs-lean-startup.pdf). The frontend uses this
// on mount so the user can start asking questions without uploading anything.
app.get("/documents/default", async (req, res) => {
  const doc = await findDocumentByFilename("hbs-lean-startup.pdf");
  if (!doc) return res.status(404).json({ error: "Default document not ready yet" });
  const { file_path, ...safe } = doc;
  res.json(safe);
});

// GET /documents/:documentId
// Poll this to check ingestion status before querying.
app.get("/documents/:documentId", async (req, res) => {
  const doc = await findDocument(req.params.documentId);
  if (!doc) {
    return res.status(404).json({ error: "Document not found" });
  }
  // Strip internal file_path before sending to client
  const { file_path, ...safe } = doc;
  res.json(safe);
});

// POST /documents/:documentId/reingest
// Re-embeds a document from its stored file (e.g. after its vectors went
// missing). Explicit rather than automatic because it costs embedding calls.
app.post("/documents/:documentId/reingest", async (req, res) => {
  const doc = await findDocument(req.params.documentId);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  if (doc.status === "processing") {
    return res.status(409).json({ error: "Document is already being processed" });
  }
  await markProcessing(doc.id);
  await enqueueIngestion(doc.id, doc.file_path, doc.filename);
  res.status(202).json({ documentId: doc.id, status: "processing", filename: doc.filename });
});

// GET /runtime — exact model/runtime configuration (no secrets), for
// reproducibility. Eval runs store this alongside their results.
app.get("/runtime", async (req, res) => {
  res.json(await describeRuntime());
});

// GET /metrics — Prometheus scrape endpoint
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

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

// GET /chat?question=...&documentId=...&mode=docs|web|hybrid (default hybrid)
// One grounded answer citing document sources [D#] and web sources [W#].
// documentId is required except in web mode.
app.get("/chat", async (req, res) => {
  const opts = await parseChatRequest(req, res);
  if (!opts) return;

  const t0 = Date.now();
  try {
    const { answer, sources, citations, meta } = await answerQuestion(opts);
    const totalMs = Date.now() - t0;
    queryLatency.observe({ endpoint: "/chat" }, totalMs);
    res.json({
      answer,
      mode: opts.mode,
      sources,
      citations,
      web: meta.web && { status: meta.web.status, error: meta.web.error },
      meta: { ...meta, total_ms: totalMs },
    });
  } catch (err) {
    if (err instanceof VectorsMissingError) {
      const reason = await handleVectorsMissing(opts.documentId);
      return res.status(422).json({ error: "Document ingestion failed", detail: reason });
    }
    if (err instanceof WebSearchUnavailableError) {
      return res.status(502).json({ error: "Web search unavailable", detail: err.message });
    }
    console.error("[chat] error:", err.message);
    res.status(500).json({ error: "Failed to generate answer", detail: err.message });
  }
});

// GET /chat/stream — same parameters as /chat, as Server-Sent Events:
//   event "sources" { sources, web }   once retrieval/search finish
//   data { token }                     answer tokens
//   data { done: true, citations, meta }
//   event "apierror" { error }
app.get("/chat/stream", async (req, res) => {
  const opts = await parseChatRequest(req, res);
  if (!opts) return;

  // SSE headers — must be set before any write
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const t0 = Date.now();
  const meta = {};
  let ttftMs;

  try {
    for await (const event of streamAnswer(opts, meta)) {
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
    const { citations, ...rest } = meta;
    res.write(
      `data: ${JSON.stringify({ done: true, citations, meta: { ...rest, ttft_ms: ttftMs, total_ms: totalMs } })}\n\n`
    );
  } catch (err) {
    const message =
      err instanceof VectorsMissingError ? await handleVectorsMissing(opts.documentId) : err.message;
    console.error("[stream] error:", message);
    res.write(`event: apierror\ndata: ${JSON.stringify({ error: message })}\n\n`);
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 5001;

// Ingest the default PDF on startup if it hasn't been ingested yet, or retry
// it (once per boot) if its last ingestion failed — e.g. after reconcile found
// its vectors missing. Other failed documents are re-ingested only on request.
const seedDefaultDocument = async () => {
  const DEFAULT_FILENAME = "hbs-lean-startup.pdf";
  const DEFAULT_PATH = "uploads/hbs-lean-startup.pdf";

  const existing = await findDocumentByFilename(DEFAULT_FILENAME);
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

  const documentId = randomUUID();
  await insertDocument(documentId, DEFAULT_FILENAME, DEFAULT_PATH);
  console.log("[seed] ingesting default document...");

  await enqueueIngestion(documentId, DEFAULT_PATH, DEFAULT_FILENAME);
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
