// Query pipeline: embed question -> retrieve from Chroma -> call LLM
// Each document has its own Chroma collection — no filtering needed.

import { Chroma } from "@langchain/community/vectorstores/chroma";
import { OpenAIEmbeddings } from "@langchain/openai";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { usageFrom } from "./lib/usage.js";
import { VectorsMissingError } from "./lib/vectors.js";

const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8000";
const TOP_K = 5;

// Shared helper — embeds the question and retrieves context from Chroma.
// Used by both the blocking and streaming query paths. Embedding and vector
// search are timed separately (same calls asRetriever({ k }) makes internally).
const retrieveContext = async (question, documentId, meta) => {
  const embeddings = new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const vectorStore = new Chroma(embeddings, {
    collectionName: documentId,
    url: CHROMA_URL,
  });

  let t = Date.now();
  const queryVector = await embeddings.embedQuery(question);
  meta.embed_ms = Date.now() - t;

  t = Date.now();
  const results = await vectorStore.similaritySearchVectorWithScore(queryVector, TOP_K);
  meta.chroma_ms = Date.now() - t;
  meta.chunks = results.length;

  // A ready document always has at least one chunk, so zero hits means the
  // vectors are gone (the wrapper's getOrCreateCollection hides a missing
  // collection by creating an empty one). Fail loudly instead of answering
  // from empty context.
  if (results.length === 0) throw new VectorsMissingError(documentId);

  return results.map(([doc]) => doc.pageContent).join("\n\n");
};

const PROMPT_TEMPLATE = `Use the following pieces of context to answer the question at the end.
If you don't know the answer, say you don't know. Do not make up information.
Use three sentences maximum and keep the answer concise.

{context}
Question: {question}
Helpful Answer:`;

// Blocking query — used by GET /chat (kept for benchmarking).
export const queryDocument = async (question, documentId) => {
  const meta = {};
  const context = await retrieveContext(question, documentId, meta);

  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    apiKey: process.env.OPENAI_API_KEY,
  });

  const prompt = PromptTemplate.fromTemplate(PROMPT_TEMPLATE);
  const formattedPrompt = await prompt.format({ context, question });

  const t = Date.now();
  const response = await model.invoke(formattedPrompt);
  meta.llm_ms = Date.now() - t;
  meta.usage = usageFrom(response);

  return { text: response.content, meta };
};

// Streaming query — used by GET /chat/stream.
// Retrieves context upfront (fast), then yields LLM tokens one by one.
// Timings and token usage are written into the caller-supplied `meta` object.
export async function* streamQueryDocument(question, documentId, meta = {}) {
  const context = await retrieveContext(question, documentId, meta);

  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    apiKey: process.env.OPENAI_API_KEY,
    streaming: true,
  });

  const prompt = PromptTemplate.fromTemplate(PROMPT_TEMPLATE);
  const formattedPrompt = await prompt.format({ context, question });

  const t = Date.now();
  const stream = await model.stream(formattedPrompt);
  for await (const chunk of stream) {
    if (chunk.usage_metadata) meta.usage = usageFrom(chunk);
    if (chunk.content) {
      if (meta.llm_ttft_ms === undefined) meta.llm_ttft_ms = Date.now() - t;
      yield chunk.content;
    }
  }
  meta.llm_ms = Date.now() - t;
}
