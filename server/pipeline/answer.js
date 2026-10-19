// The answer pipeline: gather sources, build one grounded prompt, make one LLM call.
//
// Modes:
//   docs   — document chunks only
//   web    — web results only (no document needed)
//   hybrid — both, in parallel. Each side degrades independently:
//            - search fails / exceeds SEARCH_TIMEOUT_MS / finds nothing
//              -> answer from the document alone, `web.status` says why
//            - retrieval fails (Chroma or embeddings down)
//              -> answer from the web alone, `retrieval.status` says why
//            - both fail -> NoSourcesError
//            Missing vectors are never papered over: they mark the document
//            failed (VectorsMissingError propagates).
//
// Cancellation: callers pass `signal` (the server aborts it when the client
// disconnects). It stops the search — including inside the MCP server — and
// the LLM call, so abandoned requests stop using the model.

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { createChatModel, invokeGuarded, streamGuarded } from "../lib/llm.js";
import { usageFrom } from "../lib/usage.js";
import { VectorsMissingError } from "../lib/vectors.js";
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

export class RetrievalUnavailableError extends Error {
  constructor(detail) {
    super(`Document retrieval failed: ${detail}`);
    this.name = "RetrievalUnavailableError";
  }
}

export class NoSourcesError extends Error {
  constructor(retrievalError, webStatus) {
    super(`No sources available (retrieval: ${retrievalError}; web search: ${webStatus})`);
    this.name = "NoSourcesError";
  }
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw signal.reason;
};

// Runs the search within its time budget and records what happened. Failures
// become a status; only a cancelled request (caller's signal) throws.
const searchWithBudget = async (question, meta, search, signal) => {
  const { timeoutMs } = searchConfig();
  const budget = AbortSignal.timeout(timeoutMs);
  const searchSignal = signal ? AbortSignal.any([signal, budget]) : budget;
  const t = Date.now();
  try {
    const { results, attempts } = await search(question, { signal: searchSignal });
    meta.search_ms = Date.now() - t;
    meta.attempts = attempts;
    meta.results = results.length;
    meta.status = results.length ? "ok" : "empty";
    return results;
  } catch (err) {
    meta.search_ms = Date.now() - t;
    throwIfAborted(signal);
    if (budget.aborted) {
      meta.status = "timeout";
    } else {
      meta.status = "error";
      meta.error = err.message;
      if (err.attempts) meta.attempts = err.attempts;
    }
    return [];
  }
};

// Retrieval for hybrid mode: failures become a status (except missing vectors).
const retrieveOrRecord = async (retrieve, question, documentId, meta) => {
  try {
    const docs = await retrieve(question, documentId, meta);
    meta.status = "ok";
    return docs;
  } catch (err) {
    if (err instanceof VectorsMissingError) throw err;
    meta.status = "error";
    meta.error = err.message;
    return [];
  }
};

// Gathers sources for the mode and builds the prompt.
// `deps` is for tests: substitute the retriever and search function.
export const prepareContext = async (
  { question, documentId, mode, signal },
  { retrieve = retrieveDocuments, search = searchWeb } = {}
) => {
  const meta = { mode, retrieval: null, web: null };
  const t = Date.now();

  const docsPromise =
    mode === "web"
      ? Promise.resolve([])
      : mode === "docs"
        ? retrieve(question, documentId, (meta.retrieval = {})).then(
            (docs) => {
              meta.retrieval.status = "ok";
              return docs;
            },
            (err) => {
              if (err instanceof VectorsMissingError) throw err;
              throw new RetrievalUnavailableError(err.message);
            }
          )
        : retrieveOrRecord(retrieve, question, documentId, (meta.retrieval = {}));
  const webPromise = mode === "docs" ? Promise.resolve([]) : searchWithBudget(question, (meta.web = {}), search, signal);
  const [docs, web] = await Promise.all([docsPromise, webPromise]);
  throwIfAborted(signal);

  if (mode === "web" && meta.web.status !== "ok") {
    throw new WebSearchUnavailableError(meta.web.status, meta.web.error);
  }
  if (mode === "hybrid" && meta.retrieval.status === "error" && meta.web.status !== "ok") {
    throw new NoSourcesError(meta.retrieval.error, meta.web.status);
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
export const answerQuestion = async ({ question, documentId, mode, signal }) => {
  const { context, meta } = await prepareContext({ question, documentId, mode, signal });

  const t = Date.now();
  const { message, check } = await invokeGuarded(createChatModel(), messagesFor(context), context.promptText, { signal });
  meta.llm = { ms: Date.now() - t, usage: usageFrom(message), check };

  const answer = typeof message.content === "string" ? message.content : "";
  return { answer, sources: context.sources, citations: parseCitations(answer, context.sources), meta };
};

// Streaming: yields { sources } once the prompt is built, then { token } chunks.
// `meta` is filled in as the request progresses (citations at the end).
export async function* streamAnswer({ question, documentId, mode, signal }, meta) {
  const prepared = await prepareContext({ question, documentId, mode, signal });
  Object.assign(meta, prepared.meta);
  const { context } = prepared;
  yield { sources: context.sources, web: meta.web, retrieval: meta.retrieval };

  const llmMeta = {};
  let answer = "";
  const t = Date.now();
  const model = createChatModel({ streaming: true });
  for await (const chunk of streamGuarded(model, messagesFor(context), llmMeta, context.promptText, { signal })) {
    if (llmMeta.ttft_ms === undefined) llmMeta.ttft_ms = Date.now() - t;
    answer += chunk.content;
    yield { token: chunk.content };
  }
  meta.llm = { ms: Date.now() - t, ttft_ms: llmMeta.ttft_ms, usage: llmMeta.usage, check: llmMeta.check };
  meta.citations = parseCitations(answer, context.sources);
}
