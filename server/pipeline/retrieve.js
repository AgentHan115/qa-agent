// Document retrieval: embed the question, take the top-k chunks from the
// document's Chroma collection, keep their page numbers for citations.

import { Chroma } from "@langchain/community/vectorstores/chroma";
import { createEmbeddings, formatQuery } from "../lib/llm.js";
import { VectorsMissingError } from "../lib/vectors.js";

const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8000";
export const TOP_K = parseInt(process.env.RETRIEVAL_TOP_K || "5", 10);

// One vector-store wrapper per document. The wrapper resolves its collection
// on first use and keeps it, so later queries skip the collection lookup.
const stores = new Map();

const storeFor = (documentId) => {
  if (!stores.has(documentId)) {
    stores.set(documentId, new Chroma(createEmbeddings(), { collectionName: documentId, url: CHROMA_URL }));
  }
  return stores.get(documentId);
};

// Re-ingestion replaces the collection, so a cached handle would point at the old one.
export const forgetDocumentStore = (documentId) => stores.delete(documentId);

// Returns [{ text, page, distance }], best match first. Timings go into `meta`.
export const retrieveDocuments = async (question, documentId, meta) => {
  const store = storeFor(documentId);

  let t = Date.now();
  // Instruction-tuned embedders get a query prefix; stored chunks have none.
  const queryVector = await store.embeddings.embedQuery(formatQuery(question));
  meta.embed_ms = Date.now() - t;

  t = Date.now();
  let results;
  try {
    results = await store.similaritySearchVectorWithScore(queryVector, TOP_K);
  } catch (err) {
    forgetDocumentStore(documentId);
    throw err;
  }
  meta.chroma_ms = Date.now() - t;
  meta.chunks = results.length;

  // A ready document always has at least one chunk, so zero hits means the
  // vectors are gone (the wrapper's getOrCreateCollection hides a missing
  // collection by creating an empty one). Fail loudly instead of answering
  // from empty context.
  if (results.length === 0) {
    forgetDocumentStore(documentId);
    throw new VectorsMissingError(documentId);
  }

  return results.map(([doc, distance]) => ({
    text: doc.pageContent,
    page: typeof doc.metadata?.page === "number" ? doc.metadata.page : null,
    distance,
  }));
};
