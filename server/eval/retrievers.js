// Experimental document retrievers for eval/capture-contexts.js. Each has the
// signature of pipeline/retrieve.js's retrieveDocuments(question, documentId,
// meta) and returns [{ text, page, distance }], so it can be passed to the
// production prepareContext without changing the pipeline.

import { Chroma } from "@langchain/community/vectorstores/chroma";
import { ChromaClient } from "chromadb";
import { createEmbeddings, formatQuery } from "../lib/llm.js";
import { createBm25 } from "./bm25.js";

// Vector top-k exactly as production retrieves it, then the best BM25 chunks
// not already included, until keywordK more are added. The vector results
// always come first and are never dropped, so the context only grows.
export const createVectorPlusKeywordRetriever = ({
  vectorK = 5,
  keywordK = 3,
  chromaUrl = process.env.CHROMA_URL || "http://localhost:8000",
} = {}) => {
  const indexes = new Map(); // documentId -> { store, chunks, byText, bm25 }

  const indexFor = async (documentId) => {
    if (!indexes.has(documentId)) {
      const store = new Chroma(createEmbeddings(), { collectionName: documentId, url: chromaUrl });
      const u = new URL(chromaUrl);
      const collection = await new ChromaClient({ host: u.hostname, port: Number(u.port) || 8000, ssl: u.protocol === "https:" }).getCollection({
        name: documentId,
      });
      const all = await collection.get({ include: ["documents", "metadatas"] });
      const chunks = all.ids.map((id, i) => ({ id, text: all.documents[i], page: all.metadatas[i]?.page ?? null }));
      const byText = new Map();
      chunks.forEach((c, i) => byText.has(c.text) || byText.set(c.text, i));
      indexes.set(documentId, { store, chunks, byText, bm25: createBm25(chunks.map((c) => c.text)) });
    }
    return indexes.get(documentId);
  };

  return async (question, documentId, meta) => {
    const { store, chunks, byText, bm25 } = await indexFor(documentId);

    let t = Date.now();
    const queryVector = await store.embeddings.embedQuery(formatQuery(question));
    meta.embed_ms = Date.now() - t;

    t = Date.now();
    const dense = await store.similaritySearchVectorWithScore(queryVector, vectorK);
    meta.chroma_ms = Date.now() - t;

    const docs = dense.map(([doc, distance]) => ({
      text: doc.pageContent,
      page: typeof doc.metadata?.page === "number" ? doc.metadata.page : null,
      distance,
    }));
    const taken = new Set(dense.map(([doc]) => byText.get(doc.pageContent)));
    const hits = docs.map(({ page, distance }) => ({ page, distance, source: "vector" }));

    t = Date.now();
    for (const { index, score } of bm25(question, vectorK + keywordK + 20)) {
      if (docs.length >= vectorK + keywordK) break;
      if (taken.has(index)) continue;
      taken.add(index);
      docs.push({ text: chunks[index].text, page: chunks[index].page, distance: null });
      hits.push({ page: chunks[index].page, bm25: score, source: "bm25" });
    }
    meta.bm25_ms = Date.now() - t;
    meta.chunks = docs.length;
    meta.hits = hits;
    meta.method = `vector${vectorK}+bm25${keywordK}`;
    return docs;
  };
};
