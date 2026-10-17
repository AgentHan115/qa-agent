// Direct Chroma access for bookkeeping that LangChain's wrapper doesn't expose
// (existence checks, counts, deletes). LangChain's Chroma uses
// getOrCreateCollection, which silently creates an empty collection for a
// missing one — so we never use it to check whether vectors exist.

import { ChromaClient, ChromaNotFoundError } from "chromadb";

const CHROMA_URL = new URL(process.env.CHROMA_URL || "http://localhost:8000");

const client = new ChromaClient({
  host: CHROMA_URL.hostname,
  port: Number(CHROMA_URL.port) || (CHROMA_URL.protocol === "https:" ? 443 : 8000),
  ssl: CHROMA_URL.protocol === "https:",
});

// Thrown by the query path when a document marked ready has no vectors.
export class VectorsMissingError extends Error {
  constructor(documentId) {
    super(`No vectors found in Chroma for document ${documentId}`);
    this.name = "VectorsMissingError";
    this.documentId = documentId;
  }
}

// Number of vectors stored for a document; 0 if its collection doesn't exist.
export const countVectors = async (documentId) => {
  try {
    const collection = await client.getCollection({ name: documentId });
    return await collection.count();
  } catch (err) {
    if (err instanceof ChromaNotFoundError) return 0;
    throw err;
  }
};

// Drop a document's collection so re-ingestion starts clean. No-op if missing.
export const deleteVectors = async (documentId) => {
  try {
    await client.deleteCollection({ name: documentId });
  } catch (err) {
    if (!(err instanceof ChromaNotFoundError)) throw err;
  }
};
