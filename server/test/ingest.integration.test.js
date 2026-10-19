// Runs ingestDocument against a live Chroma (docker compose up chroma) with
// synthetic embeddings, so no API calls are made. Skipped if Chroma is down or
// the demo PDF hasn't been downloaded (sh server/scripts/fetch-demo-doc.sh).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "crypto";
import { existsSync } from "fs";
import { ChromaClient } from "chromadb";
import { ingestDocument } from "../ingest.js";
import { countVectors, deleteVectors } from "../lib/vectors.js";

const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8000";
const PDF = new URL("../uploads/gpt-4.pdf", import.meta.url).pathname;

const chromaUp = await fetch(`${CHROMA_URL}/api/v2/heartbeat`)
  .then((r) => r.ok)
  .catch(() => false);
const skip = !chromaUp ? "Chroma not reachable" : !existsSync(PDF) ? "demo PDF not downloaded" : false;

const documentId = `test-${randomUUID()}`;
// Deterministic fake: 16 numbers from a hash of the text. (LangChain's
// SyntheticEmbeddings returns an empty vector for text shorter than its vector
// size, and this PDF yields 1-character chunks such as a stray page number "9".)
const fakeVector = (text) => [...createHash("sha256").update(text).digest().subarray(0, 16)].map((b) => b / 255);
const embeddings = {
  embedDocuments: async (texts) => texts.map(fakeVector),
  embedQuery: async (text) => fakeVector(text),
};

after(() => !skip && deleteVectors(documentId));

test("re-ingesting the same document is idempotent", { skip }, async () => {
  const first = await ingestDocument(documentId, PDF, "gpt-4.pdf", { embeddings });
  assert.ok(first.chunkCount > 0);
  assert.equal(await countVectors(documentId), first.chunkCount);

  // A retry (e.g. BullMQ attempt 2) must not append duplicates.
  const second = await ingestDocument(documentId, PDF, "gpt-4.pdf", { embeddings });
  assert.equal(second.chunkCount, first.chunkCount);
  assert.equal(await countVectors(documentId), first.chunkCount);
});

test("stores a flat page number on every chunk", { skip }, async () => {
  const url = new URL(CHROMA_URL);
  const client = new ChromaClient({ host: url.hostname, port: Number(url.port) || 8000 });
  const collection = await client.getCollection({ name: documentId });
  const { metadatas } = await collection.get({ include: ["metadatas"] });
  assert.ok(metadatas.length > 0);
  for (const m of metadatas) assert.equal(typeof m.page, "number");
});

test("missing collection counts as zero vectors", { skip }, async () => {
  assert.equal(await countVectors(`missing-${randomUUID()}`), 0);
});
