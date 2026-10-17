// Query pipeline: embed question -> retrieve from Chroma -> call LLM
// Each document has its own Chroma collection — no filtering needed.

import { Chroma } from "@langchain/community/vectorstores/chroma";
import { OpenAIEmbeddings } from "@langchain/openai";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";

const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8000";

// Shared helper — embeds the question and retrieves context from Chroma.
// Used by both the blocking and streaming query paths.
const retrieveContext = async (question, documentId) => {
  const embeddings = new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const vectorStore = new Chroma(embeddings, {
    collectionName: documentId,
    url: CHROMA_URL,
  });

  const retriever = vectorStore.asRetriever({ k: 5 });
  const relevantDocs = await retriever.invoke(question);
  return relevantDocs.map((doc) => doc.pageContent).join("\n\n");
};

const PROMPT_TEMPLATE = `Use the following pieces of context to answer the question at the end.
If you don't know the answer, say you don't know. Do not make up information.
Use three sentences maximum and keep the answer concise.

{context}
Question: {question}
Helpful Answer:`;

// Blocking query — used by GET /chat (kept for benchmarking).
export const queryDocument = async (question, documentId) => {
  const context = await retrieveContext(question, documentId);

  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    apiKey: process.env.OPENAI_API_KEY,
  });

  const prompt = PromptTemplate.fromTemplate(PROMPT_TEMPLATE);
  const formattedPrompt = await prompt.format({ context, question });
  const response = await model.invoke(formattedPrompt);

  return { text: response.content };
};

// Streaming query — used by GET /chat/stream.
// Retrieves context upfront (fast), then yields LLM tokens one by one.
export async function* streamQueryDocument(question, documentId) {
  const context = await retrieveContext(question, documentId);

  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    apiKey: process.env.OPENAI_API_KEY,
    streaming: true,
  });

  const prompt = PromptTemplate.fromTemplate(PROMPT_TEMPLATE);
  const formattedPrompt = await prompt.format({ context, question });

  const stream = await model.stream(formattedPrompt);
  for await (const chunk of stream) {
    if (chunk.content) yield chunk.content;
  }
}
