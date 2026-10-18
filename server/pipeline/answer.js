// The answer pipeline: gather sources, build one grounded prompt, make one LLM call.
//
// Modes:
//   docs   — document chunks only
//   web    — web results only (no document needed)
//   hybrid — both; retrieval and search run in parallel. The search is bounded
//            by SEARCH_TIMEOUT_MS; if it fails, times out, or finds nothing the
//            answer is built from the document alone and `web.status` says why.
//
// Unlike the old design (two pipelines, two LLM calls, two answers), document
// and web sources reach the model together and the answer cites both.

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { createChatModel, invokeGuarded, streamGuarded } from "../lib/llm.js";
import { usageFrom } from "../lib/usage.js";
import { searchWeb, searchConfig } from "../search/index.js";
import { retrieveDocuments } from "./retrieve.js";
import { buildContext } from "./context.js";
import { parseCitations } from "./citations.js";

export const MODES = ["docs", "web", "hybrid"];

export class WebSearchUnavailableError extends Error {
  constructor(status, detail) {
    super(`Web search ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "WebSearchUnavailableError";
    this.status = status;
  }
}

const TIMED_OUT = Symbol("timeout");
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms))),
  ]).finally(() => clearTimeout(timer));
};

// Runs the search within its time budget and records what happened.
// Never throws: failures become a status. (The search itself is not cancelled
// on timeout yet; it finishes in the background.)
const searchWithBudget = async (question, meta, search) => {
  const { timeoutMs } = searchConfig();
  const t = Date.now();
  try {
    const result = await withTimeout(search(question), timeoutMs);
    meta.search_ms = Date.now() - t;
    if (result === TIMED_OUT) {
      meta.status = "timeout";
      return [];
    }
    meta.results = result.length;
    meta.status = result.length ? "ok" : "empty";
    return result;
  } catch (err) {
    meta.search_ms = Date.now() - t;
    meta.status = "error";
    meta.error = err.message;
    return [];
  }
};

// Gathers sources for the mode and builds the prompt. Throws for unusable
// states (missing vectors; web-only mode with no web results).
// `deps` is for tests: substitute the retriever and search function.
export const prepareContext = async (
  { question, documentId, mode },
  { retrieve = retrieveDocuments, search = searchWeb } = {}
) => {
  const meta = { mode, retrieval: null, web: null };
  const t = Date.now();

  const docsPromise =
    mode === "web" ? Promise.resolve([]) : retrieve(question, documentId, (meta.retrieval = {}));
  const webPromise = mode === "docs" ? Promise.resolve([]) : searchWithBudget(question, (meta.web = {}), search);
  const [docs, web] = await Promise.all([docsPromise, webPromise]);

  if (mode === "web" && meta.web.status !== "ok") {
    throw new WebSearchUnavailableError(meta.web.status, meta.web.error);
  }

  meta.prepare_ms = Date.now() - t;
  const context = buildContext({ question, docs, web });
  meta.sources = {
    documents: context.sources.filter((s) => s.type === "document").length,
    web: context.sources.filter((s) => s.type === "web").length,
  };
  meta.prompt = { system_chars: context.system.length, user_chars: context.user.length };
  return { context, meta };
};

const messagesFor = (context) => [new SystemMessage(context.system), new HumanMessage(context.user)];

// Blocking: one LLM call, returns the answer with its sources and citation check.
export const answerQuestion = async ({ question, documentId, mode }) => {
  const { context, meta } = await prepareContext({ question, documentId, mode });

  const t = Date.now();
  const { message, check } = await invokeGuarded(createChatModel(), messagesFor(context), context.promptText);
  meta.llm = { ms: Date.now() - t, usage: usageFrom(message), check };

  const answer = typeof message.content === "string" ? message.content : "";
  return { answer, sources: context.sources, citations: parseCitations(answer, context.sources), meta };
};

// Streaming: yields { sources } once the prompt is built, then { token } chunks.
// `meta` is filled in as the request progresses (citations at the end).
export async function* streamAnswer({ question, documentId, mode }, meta) {
  const prepared = await prepareContext({ question, documentId, mode });
  Object.assign(meta, prepared.meta);
  const { context } = prepared;
  yield { sources: context.sources, web: meta.web };

  const llmMeta = {};
  let answer = "";
  const t = Date.now();
  for await (const chunk of streamGuarded(createChatModel({ streaming: true }), messagesFor(context), llmMeta, context.promptText)) {
    if (llmMeta.ttft_ms === undefined) llmMeta.ttft_ms = Date.now() - t;
    answer += chunk.content;
    yield { token: chunk.content };
  }
  meta.llm = { ms: Date.now() - t, ttft_ms: llmMeta.ttft_ms, usage: llmMeta.usage, check: llmMeta.check };
  meta.citations = parseCitations(answer, context.sources);
}
