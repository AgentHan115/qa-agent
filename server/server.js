import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import { randomUUID } from "crypto";
import { initDb } from "./db/postgres.js";
import { insertDocument, markReady, markFailed, findDocument, findDocumentByFilename } from "./db/documents.js";
import { ingestDocument } from "./ingest.js";
import { queryDocument, streamQueryDocument } from "./query.js";
import { ingestionQueue } from "./lib/queue.js";
import chatMCP from "./chat-mcp.js";
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

// Resolves fn() and records its wall-clock duration on the result's meta.
const timed = async (fn) => {
  const t = Date.now();
  const result = await fn();
  result.meta = { ...result.meta, path_ms: Date.now() - t };
  return result;
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
  await ingestionQueue.add("ingest", { documentId, filePath, filename });

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

// GET /metrics — Prometheus scrape endpoint
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// GET /chat?question=...&documentId=...
// documentId is required — each document has its own Chroma collection.
app.get("/chat", async (req, res) => {
  const { question, documentId } = req.query;

  if (!question) {
    return res.status(400).json({ error: "question is required" });
  }
  if (!documentId) {
    return res.status(400).json({ error: "documentId is required" });
  }

  const doc = await findDocument(documentId);
  if (!doc) {
    return res.status(404).json({ error: "Document not found" });
  }
  if (doc.status === "processing") {
    return res.status(409).json({ error: "Document is still being processed" });
  }
  if (doc.status === "failed") {
    return res.status(422).json({ error: "Document ingestion failed", detail: doc.error });
  }

  const t0 = Date.now();
  try {
    const [ragResp, mcpResp] = await Promise.all([
      timed(() => queryDocument(question, documentId)),
      timed(() => chatMCP(question)),
    ]);

    const totalMs = Date.now() - t0;
    queryLatency.observe({ endpoint: "/chat" }, totalMs);
    res.json({
      ragAnswer: ragResp.text,
      mcpAnswer: mcpResp.text,
      meta: { total_ms: totalMs, doc: ragResp.meta, web: mcpResp.meta },
    });
  } catch (err) {
    console.error("[chat] error:", err.message);
    res.status(500).json({ error: "Failed to generate answer", detail: err.message });
  }
});

// GET /chat/stream?question=...&documentId=...
// SSE endpoint — streams RAG tokens as they are generated, then sends the
// MCP answer as a final event. First token arrives in ~300ms instead of ~14s.
app.get("/chat/stream", async (req, res) => {
  const { question, documentId } = req.query;

  if (!question) return res.status(400).json({ error: "question is required" });
  if (!documentId) return res.status(400).json({ error: "documentId is required" });

  const doc = await findDocument(documentId);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  if (doc.status === "processing") return res.status(409).json({ error: "Document is still being processed" });
  if (doc.status === "failed") return res.status(422).json({ error: "Document ingestion failed", detail: doc.error });

  // SSE headers — must be set before any write
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const t0 = Date.now();
  const docMeta = {};
  let ttftMs;

  // Start MCP in parallel — it isn't streamed, arrives as a final event.
  // Timeout after 8s so a slow/hanging MCP call never blocks the done event.
  const MCP_TIMEOUT_MS = 8000;
  const mcpPromise = Promise.race([
    timed(() => chatMCP(question)).catch((err) => {
      console.error("[stream] MCP error:", err.message);
      return { text: "", meta: { status: "error", error: err.message } };
    }),
    new Promise((resolve) =>
      setTimeout(() => {
        console.warn("[stream] MCP timed out");
        resolve({ text: "", meta: { status: "timeout" } });
      }, MCP_TIMEOUT_MS)
    ),
  ]);

  try {
    for await (const token of streamQueryDocument(question, documentId, docMeta)) {
      if (ttftMs === undefined) ttftMs = Date.now() - t0;
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }
    const docDoneMs = Date.now() - t0;
    const mcpResp = await mcpPromise;
    const totalMs = Date.now() - t0;
    queryLatency.observe({ endpoint: "/chat/stream" }, totalMs);
    const meta = {
      ttft_ms: ttftMs, // first token written, measured from request arrival
      doc_done_ms: docDoneMs, // RAG stream finished
      total_ms: totalMs, // done event (includes waiting on the web path)
      doc: docMeta,
      web: mcpResp.meta,
    };
    res.write(`data: ${JSON.stringify({ done: true, mcpAnswer: mcpResp.text, meta })}\n\n`);
  } catch (err) {
    console.error("[stream] RAG error:", err.message);
    res.write(`event: apierror\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 5001;

// Ingest the default PDF on startup if it hasn't been ingested yet.
const seedDefaultDocument = async () => {
  const DEFAULT_FILENAME = "hbs-lean-startup.pdf";
  const DEFAULT_PATH = "uploads/hbs-lean-startup.pdf";

  const existing = await findDocumentByFilename(DEFAULT_FILENAME);
  if (existing) {
    console.log(`[seed] default document already in DB (status: ${existing.status})`);
    return;
  }

  const documentId = randomUUID();
  await insertDocument(documentId, DEFAULT_FILENAME, DEFAULT_PATH);
  console.log("[seed] ingesting default document...");

  await ingestionQueue.add("ingest", { documentId, filePath: DEFAULT_PATH, filename: DEFAULT_FILENAME });
};

// Initialize DB schema then start the server
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`server running on port ${PORT}`));
    seedDefaultDocument();
  })
  .catch((err) => {
    console.error("[db] failed to initialize:", err.message);
    process.exit(1);
  });
