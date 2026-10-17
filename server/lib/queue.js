import { Queue, Worker, UnrecoverableError } from "bullmq";
import { markReady, markFailed } from "../db/documents.js";
import { ingestDocument } from "../ingest.js";
import { isPermanentProviderError } from "./errors.js";

const connection = {
  url: process.env.REDIS_URL || "redis://localhost:6379",
};

// Retry policy is a Queue option (BullMQ ignores defaultJobOptions on a Worker):
// up to 3 attempts in total, with exponential backoff (3s, 6s).
export const ingestionQueue = new Queue("ingestion", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
  },
});

// Enqueue (re-)ingestion of a document.
export const enqueueIngestion = (documentId, filePath, filename) =>
  ingestionQueue.add("ingest", { documentId, filePath, filename });

// Worker processes one job at a time — concurrency=1 keeps Chroma writes safe.
export const ingestionWorker = new Worker(
  "ingestion",
  async (job) => {
    const { documentId, filePath, filename } = job.data;
    let chunkCount;
    try {
      ({ chunkCount } = await ingestDocument(documentId, filePath, filename));
    } catch (err) {
      // e.g. no API credits or a bad key: fail now instead of burning retries
      if (isPermanentProviderError(err)) throw new UnrecoverableError(err.message);
      throw err;
    }
    await markReady(documentId, chunkCount);
    console.log(`[queue] ${filename} ready — ${chunkCount} chunks`);
  },
  { connection, concurrency: 1 }
);

ingestionWorker.on("failed", async (job, err) => {
  console.error(`[queue] ${job.data.filename} failed (attempt ${job.attemptsMade}):`, err.message);
  // Mark failed once retries are exhausted, or immediately for permanent errors
  if (err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts || 1)) {
    await markFailed(job.data.documentId, err.message);
  }
});
