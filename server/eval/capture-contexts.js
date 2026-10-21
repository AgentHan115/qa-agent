// Captures the exact prompts the pipeline builds for every dataset question,
// once, so later experiments can replay identical evidence to different models
// without re-running retrieval or search.
//
// Per question it runs prepareContext (the production code, unchanged) with
// substituted dependencies:
//   1. hybrid, live: real retrieval and one real search. SerpAPI is called
//      through its normal adapter with a recording fetch, so the raw response
//      metadata (search_information, ai_overview, related_questions, ...) is
//      kept, along with every attempt's timing and status.
//   2. docs and web: replays of what step 1 retrieved and found, so all three
//      modes share one search per question (as the 2026-10-20 runs did via
//      SerpAPI's cache).
//   3. oracle: the same three modes with the gold evidence guaranteed present:
//      document chunks containing each evidence quote replace the lowest-ranked
//      retrieved chunks, and the reviewed web excerpt replaces the lowest-ranked
//      web result. Retrieved chunks that already contain evidence are kept.
//   4. none: no sources at all, to measure answers from model memory.
//
// Search goes through the provider directly (as SEARCH_TRANSPORT=direct does),
// with the same retries and time budgets as production; the MCP hop doesn't
// change results, only latency.
//
// Usage (from server/, with Chroma and the embedding model running):
//   node eval/capture-contexts.js --documentId=<uuid>
//
// Options:
//   --dataset=<path>        default eval/datasets/gpt4-report.v1.json
//   --web-evidence=<path>   default eval/datasets/gpt4-report.v1.web-evidence.json
//   --ids=P01,W05           only these questions
//   --allow-draft           accept a dataset or web-evidence file that isn't APPROVED
//   --out=<path>            default eval/frozen/contexts-<timestamp>.json
//
// SEARCH_PROVIDER=fake runs everything without spending search quota.
// The output contains document text and third-party snippets, so eval/frozen/
// is git-ignored; results that use it should record its SHA-256.

import dotenv from "dotenv";
dotenv.config();

import { createHash } from "crypto";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { ChromaClient } from "chromadb";

import { prepareContext } from "../pipeline/answer.js";
import { retrieveDocuments, TOP_K } from "../pipeline/retrieve.js";
import { INSTRUCTIONS } from "../pipeline/context.js";
import { normalizeResult } from "../search/provider.js";
import { createSerpApiProvider } from "../search/serpapi.js";
import { createSearchProvider, searchConfig, searchWithRetries } from "../search/index.js";
import { embeddingConfig, llmConfig } from "../lib/llm.js";

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const allowDraft = process.argv.includes("--allow-draft");

const documentId = argValue("documentId");
if (!documentId) {
  console.error("Usage: node eval/capture-contexts.js --documentId=<uuid> [--ids=P01,W05] [--allow-draft] [--out=<path>]");
  process.exit(1);
}

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const squash = (s) => s.toLowerCase().replace(/\s+/g, "");

const loadJson = (path, what) => {
  const text = readFileSync(path, "utf8");
  const json = JSON.parse(text);
  if (json.status !== "APPROVED" && !allowDraft) {
    console.error(`${what} ${path} has status "${json.status}", not APPROVED. Pass --allow-draft to use it anyway.`);
    process.exit(1);
  }
  return { json, path, sha1: sha1(text) };
};

const dataset = loadJson(argValue("dataset") || "eval/datasets/gpt4-report.v1.json", "Dataset");
const webEvidence = loadJson(argValue("web-evidence") || "eval/datasets/gpt4-report.v1.web-evidence.json", "Web evidence");
const excerptsById = new Map(webEvidence.json.evidence.map((e) => [e.id, e]));

const onlyIds = argValue("ids")?.split(",");
const questions = onlyIds ? dataset.json.questions.filter((q) => onlyIds.includes(q.id)) : dataset.json.questions;
if (onlyIds && questions.length !== onlyIds.length) {
  console.error(`Unknown question ids in --ids=${onlyIds.join(",")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Search with a recording fetch. The API key is only in the request URL, which
// is never stored; responses are scrubbed of any api_key field as well.
// ---------------------------------------------------------------------------
const { provider: providerName, num, attemptTimeoutMs, retries, timeoutMs } = searchConfig();
let searchLog = [];

const scrub = (value) => {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "api_key").map(([k, v]) => [k, scrub(v)]));
  }
  return value;
};

const recordingFetch = async (url, options) => {
  const entry = { attempt: searchLog.length + 1, started_at: new Date().toISOString() };
  searchLog.push(entry);
  const t = Date.now();
  try {
    const res = await fetch(url, options);
    entry.ms = Date.now() - t;
    entry.http_status = res.status;
    const body = await res.clone().json().catch(() => null);
    if (body) {
      const { search_metadata, search_parameters, search_information, organic_results, error, ...rest } = body;
      entry.response = scrub({
        search_metadata,
        search_parameters,
        search_information,
        error,
        organic_results,
        // Everything the adapter discards, kept to study what it costs us.
        discarded: rest,
      });
    }
    return res;
  } catch (err) {
    entry.ms = Date.now() - t;
    entry.error = `${err.name}: ${err.message}`;
    throw err;
  }
};

const provider =
  providerName === "serpapi"
    ? createSerpApiProvider({ fetchImpl: recordingFetch, attemptTimeoutMs })
    : createSearchProvider(providerName);
const liveSearch = (query, { signal }) => searchWithRetries(provider, query, { num, signal });

// ---------------------------------------------------------------------------
// Replays for prepareContext. A captured timeout is replayed as a hang, so the
// pipeline's own budget produces the same "timeout" status it did live.
// ---------------------------------------------------------------------------
const replayRetrieve = (docs) => async (q, id, meta) => {
  meta.embed_ms = 0;
  meta.chroma_ms = 0;
  meta.chunks = docs.length;
  meta.replayed = true;
  return docs;
};
const noRetrieve = async () => {
  throw new Error("retrieval must not run in this replay");
};
const replaySearch = (web) => async (q, { signal }) => {
  if (web.status === "ok" || web.status === "empty") return { results: web.results, attempts: 0 };
  if (web.status === "timeout") {
    // AbortSignal.timeout doesn't keep Node alive, so hold the loop open until it fires.
    return new Promise((_, reject) => {
      const keepAlive = setInterval(() => {}, 1000);
      signal.addEventListener(
        "abort",
        () => {
          clearInterval(keepAlive);
          reject(signal.reason);
        },
        { once: true }
      );
    });
  }
  throw Object.assign(new Error(web.error ?? "replayed search failure"), { attempts: 0 });
};
const noSearch = async () => {
  throw new Error("search must not run in this replay");
};

// Runs prepareContext and keeps what an experiment needs to replay the prompt.
const capture = async (question, mode, deps) => {
  try {
    const { context, meta } = await prepareContext({ question, documentId, mode }, deps);
    return {
      user: context.user,
      sources: context.sources,
      prompt_sha1: sha1(context.promptText),
      meta,
    };
  } catch (err) {
    return { error: err.name, message: err.message };
  }
};

// ---------------------------------------------------------------------------
// Oracle document evidence: the chunks (by deterministic id) whose text
// contains each evidence quote. A quote split across two chunks is matched
// against the pair joined with their 50-character overlap removed.
// ---------------------------------------------------------------------------
const chroma = (() => {
  const u = new URL(process.env.CHROMA_URL || "http://localhost:8000");
  return new ChromaClient({ host: u.hostname, port: Number(u.port) || 8000, ssl: u.protocol === "https:" });
})();
const collection = await chroma.getCollection({ name: documentId });
const all = await collection.get({ include: ["documents", "metadatas"] });
const chunks = all.ids
  .map((id, i) => ({ id, index: Number(id.split(":").pop()), text: all.documents[i], page: all.metadatas[i]?.page ?? null }))
  .sort((a, b) => a.index - b.index);

// Joins a and b, dropping the longest suffix of a that b starts with.
const joinOverlapping = (a, b) => {
  for (let n = Math.min(a.length, b.length, 200); n > 0; n--) {
    if (a.endsWith(b.slice(0, n))) return a + b.slice(n);
  }
  return a + b;
};

const evidenceChunks = (quote) => {
  const target = squash(quote);
  const single = chunks.filter((c) => squash(c.text).includes(target));
  if (single.length) return single.map((c) => ({ ids: [c.id], page: c.page, text: c.text, how: "single" }));
  for (let i = 0; i + 1 < chunks.length; i++) {
    const [a, b] = [chunks[i], chunks[i + 1]];
    const joined = joinOverlapping(a.text, b.text);
    if (squash(joined).includes(target)) return [{ ids: [a.id, b.id], page: a.page, text: joined, how: "joined" }];
  }
  return [];
};

// Replace from the bottom up, never dropping a chunk that already holds evidence.
const withOracleDocs = (retrieved, quotes) => {
  const docs = [...retrieved];
  const inserted = [];
  const unresolved = [];
  const holdsEvidence = (d) => quotes.some((q) => squash(d.text).includes(squash(q)));
  for (const quote of quotes) {
    if (docs.some((d) => squash(d.text).includes(squash(quote)))) continue;
    const [best] = evidenceChunks(quote);
    if (!best) {
      unresolved.push(quote);
      continue;
    }
    const slot = docs.findLastIndex((d) => !holdsEvidence(d));
    const doc = { text: best.text, page: best.page, distance: null };
    if (slot === -1) docs.push(doc);
    else docs[slot] = doc;
    inserted.push({ quote, chunk_ids: best.ids, page: best.page, how: best.how, slot: slot === -1 ? docs.length : slot + 1 });
  }
  return { docs, inserted, unresolved };
};

const withOracleWeb = (web, excerpt) => {
  if (!excerpt) return { web, inserted: null };
  const result = normalizeResult(
    { title: excerpt.title, url: excerpt.url, snippet: excerpt.excerpt, position: null, date: excerpt.date },
    "oracle"
  );
  const results = web.status === "ok" ? [...web.results] : [];
  const slot = results.length >= num ? results.length - 1 : results.length;
  results[slot] = result;
  return { web: { status: "ok", results }, inserted: { id: excerpt.id, url: excerpt.url, kind: excerpt.kind, slot: slot + 1 } };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const git = (() => {
  try {
    return {
      commit: execSync("git rev-parse HEAD").toString().trim(),
      dirty: execSync("git status --porcelain --untracked-files=no").toString().trim().length > 0,
    };
  } catch {
    return null;
  }
})();

console.log(`Capturing ${questions.length} questions (search: ${providerName}, budget ${timeoutMs} ms, ${attemptTimeoutMs} ms per attempt, ${retries} retries)`);
const records = [];
for (const q of questions) {
  searchLog = [];
  let retrieved = [];
  let web = { status: "error", results: [] };
  const recordRetrieve = async (question, id, meta) => (retrieved = await retrieveDocuments(question, id, meta));
  const recordSearch = async (query, opts) => {
    try {
      const out = await liveSearch(query, opts);
      web = { status: out.results.length ? "ok" : "empty", results: out.results };
      return out;
    } catch (err) {
      web = { status: opts.signal?.aborted ? "timeout" : "error", results: [], error: err.message };
      throw err;
    }
  };

  const hybrid = await capture(q.question, "hybrid", { retrieve: recordRetrieve, search: recordSearch });
  // The pipeline decides "timeout" from its own budget; use its verdict.
  if (hybrid.meta?.web?.status) web.status = hybrid.meta.web.status;

  const quotes = q.needs === "web" ? [] : q.evidence ?? [];
  const oracleDocs = withOracleDocs(retrieved, quotes);
  const oracleWeb = withOracleWeb(web, q.needs === "doc" ? null : excerptsById.get(q.id));

  const record = {
    id: q.id,
    category: q.category,
    needs: q.needs,
    question: q.question,
    search: { query: q.question, status: web.status, attempts: searchLog },
    retrieved: { docs: retrieved, web: web.results },
    contexts: {
      retrieved: {
        hybrid,
        docs: await capture(q.question, "docs", { retrieve: replayRetrieve(retrieved), search: noSearch }),
        web: await capture(q.question, "web", { retrieve: noRetrieve, search: replaySearch(web) }),
      },
      oracle: {
        hybrid: await capture(q.question, "hybrid", { retrieve: replayRetrieve(oracleDocs.docs), search: replaySearch(oracleWeb.web) }),
        docs: await capture(q.question, "docs", { retrieve: replayRetrieve(oracleDocs.docs), search: noSearch }),
        web: await capture(q.question, "web", { retrieve: noRetrieve, search: replaySearch(oracleWeb.web) }),
      },
      none: await capture(q.question, "docs", { retrieve: replayRetrieve([]), search: noSearch }),
    },
    oracle: {
      docs_inserted: oracleDocs.inserted,
      docs_unresolved: oracleDocs.unresolved,
      docs_changed: oracleDocs.inserted.length > 0,
      web_inserted: oracleWeb.inserted,
    },
  };
  records.push(record);

  const attempts = searchLog.map((a) => `${a.http_status ?? a.error?.split(":")[0]}/${a.ms}ms`).join(" ");
  console.log(
    `${q.id.padEnd(4)} web ${web.status.padEnd(7)} ${attempts || "(no attempts)"} | oracle docs +${oracleDocs.inserted.length}` +
      `${oracleDocs.unresolved.length ? ` UNRESOLVED ${oracleDocs.unresolved.length}` : ""}${oracleWeb.inserted ? " | oracle web +1" : ""}`
  );
}

const output = {
  created: new Date().toISOString(),
  git,
  documentId,
  dataset: { path: dataset.path, version: dataset.json.version, status: dataset.json.status, sha1: dataset.sha1 },
  web_evidence: { path: webEvidence.path, version: webEvidence.json.version, status: webEvidence.json.status, sha1: webEvidence.sha1 },
  config: {
    llm_model: llmConfig().model,
    embedding: embeddingConfig(),
    top_k: TOP_K,
    search: { provider: providerName, transport: "direct (capture)", num, timeoutMs, attemptTimeoutMs, retries },
  },
  system: INSTRUCTIONS,
  system_sha1: sha1(INSTRUCTIONS),
  questions: records,
};
const text = JSON.stringify(output, null, 2);
if (process.env.SERPAPI_KEY && text.includes(process.env.SERPAPI_KEY)) {
  console.error("Refusing to write: the output contains the SerpAPI key.");
  process.exit(1);
}
const outPath = argValue("out") || `eval/frozen/contexts-${output.created.replace(/[:.]/g, "-")}.json`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, text);
console.log(`\nWrote ${outPath} (sha256 ${createHash("sha256").update(text).digest("hex")})`);
