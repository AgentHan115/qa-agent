// Runs ingestDocument against a live Chroma (docker compose up chroma) with
// synthetic embeddings, so no API calls are made. Skipped if Chroma is down.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { SyntheticEmbeddings } from "@langchain/core/utils/testing";
import { ChromaClient } from "chromadb";
import { ingestDocument } from "../ingest.js";
import { countVectors, deleteVectors } from "../lib/vectors.js";

const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8000";
const PDF = new URL("../uploads/hbs-lean-startup.pdf", import.meta.url).pathname;

const chromaUp = await fetch(`${CHROMA_URL}/api/v2/heartbeat`)
  .then((r) => r.ok)
  .catch(() => false);

const documentId = `test-${randomUUID()}`;
const embeddings = new SyntheticEmbeddings({ vectorSize: 16 });

after(() => chromaUp && deleteVectors(documentId));

test("re-ingesting the same document is idempotent", { skip: !chromaUp && "Chroma not reachable" }, async () => {
  const first = await ingestDocument(documentId, PDF, "hbs-lean-startup.pdf", { embeddings });
  assert.ok(first.chunkCount > 0);
  assert.equal(await countVectors(documentId), first.chunkCount);

  // A retry (e.g. BullMQ attempt 2) must not append duplicates.
  const second = await ingestDocument(documentId, PDF, "hbs-lean-startup.pdf", { embeddings });
  assert.equal(second.chunkCount, first.chunkCount);
  assert.equal(await countVectors(documentId), first.chunkCount);
});

test("stores a flat page number on every chunk", { skip: !chromaUp && "Chroma not reachable" }, async () => {
  const url = new URL(CHROMA_URL);
  const client = new ChromaClient({ host: url.hostname, port: Number(url.port) || 8000 });
  const collection = await client.getCollection({ name: documentId });
  const { metadatas } = await collection.get({ include: ["metadatas"] });
  assert.ok(metadatas.length > 0);
  for (const m of metadatas) assert.equal(typeof m.page, "number");
});

test("missing collection counts as zero vectors", { skip: !chromaUp && "Chroma not reachable" }, async () => {
  assert.equal(await countVectors(`missing-${randomUUID()}`), 0);
});
