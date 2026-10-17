import { Queue, Worker } from "bullmq";
import { markReady, markFailed } from "../db/documents.js";
import { ingestDocument } from "../ingest.js";

const connection = {
  url: process.env.REDIS_URL || "redis://localhost:6379",
};

export const ingestionQueue = new Queue("ingestion", { connection });

// Worker processes one job at a time — concurrency=1 keeps Chroma writes safe.
// Failed jobs are retried up to 3 times with exponential backoff.
export const ingestionWorker = new Worker(
  "ingestion",
  async (job) => {
    const { documentId, filePath, filename } = job.data;
    const { chunkCount } = await ingestDocument(documentId, filePath, filename);
    await markReady(documentId, chunkCount);
    console.log(`[queue] ${filename} ready — ${chunkCount} chunks`);
  },
  {
    connection,
    concurrency: 1,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
    },
  }
);

ingestionWorker.on("failed", async (job, err) => {
  console.error(`[queue] ${job.data.filename} failed (attempt ${job.attemptsMade}):`, err.message);
  if (job.attemptsMade >= job.opts.attempts) {
    await markFailed(job.data.documentId, err.message);
  }
});
