// Ingestion pipeline: load PDF -> chunk -> embed -> store in Chroma
// This runs ONCE per document on upload, not on every query.
// Each document gets its own Chroma collection (named by documentId),
// so queries hit the right collection directly — no cross-document leakage.

import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Chroma } from "@langchain/community/vectorstores/chroma";

const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8000";

// Flatten metadata to primitives only. Nested objects are JSON-stringified,
// arrays are dropped (Chroma typed arrays aren't needed here).
const sanitizeMetadata = (metadata) =>
  Object.fromEntries(
    Object.entries(metadata)
      .map(([k, v]) => {
        if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          return [k, v];
        }
        if (typeof v === "object" && !Array.isArray(v)) {
          return [k, JSON.stringify(v)]; // flatten nested objects to a string
        }
        return null; // drop arrays and anything else unexpected
      })
      .filter(Boolean)
  );

export const ingestDocument = async (documentId, filePath, filename) => {
  // Step 1: Load PDF
  const loader = new PDFLoader(filePath);
  const docs = await loader.load();

  // Step 2: Chunk the text
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
  });
  const chunks = await splitter.splitDocuments(docs);

  // Step 3: Sanitize metadata — Chroma only accepts string, number, boolean, or null.
  // PDFLoader injects nested objects (e.g. pdf: { info: {...} }) that Chroma rejects.
  const sanitizedChunks = chunks.map((chunk) => ({
    ...chunk,
    metadata: sanitizeMetadata(chunk.metadata),
  }));

  // Step 4: Embed and persist into a dedicated Chroma collection for this document.
  // Using documentId as the collection name gives us free, perfect isolation
  // without any metadata filtering at query time.
  const embeddings = new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
  });

  await Chroma.fromDocuments(sanitizedChunks, embeddings, {
    collectionName: documentId,
    url: CHROMA_URL,
  });

  return { chunkCount: sanitizedChunks.length };
};
