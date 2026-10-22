// Layer-2 sweep: for each dataset question that needs the document, how many
// of the gold evidence quotes are in the top-k chunks, for several retrieval
// methods and k. No model calls, no search, no re-ingestion, and the
// pipeline is unchanged: it reads the existing Chroma collection.
//
// Methods (--methods, default vector):
//   vector      what pipeline/retrieve.js does: the question with the embedding
//               query instruction, nearest chunks in Chroma. One Chroma query
//               per k, so approximate-search differences between k values are
//               measured rather than assumed away.
//   bm25        keyword retrieval (eval/bm25.js) over the same chunks.
//   rrf         reciprocal rank fusion of the vector and BM25 top-50.
//   interleave  alternating vector and BM25 results, duplicates skipped.
//
//   node eval/retrieval-sweep.js --documentId=<uuid> [--ks=5,8,10] [--methods=vector,bm25,rrf,interleave]
//                                [--compare=results/eval-<ts>.json]
//
// --compare checks that vector at the smallest k reproduces the pages an
// earlier eval retrieved. Writes results/retrieval-sweep-<timestamp>.json
// (pages, ranks and chunk lengths only; no chunk text).

import dotenv from "dotenv";
dotenv.config();

import { execSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { ChromaClient } from "chromadb";
import { createEmbeddings, embeddingConfig, formatQuery } from "../lib/llm.js";
import { createBm25, interleave, reciprocalRankFusion } from "./bm25.js";

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const documentId = argValue("documentId");
if (!documentId) {
  console.error("Usage: node eval/retrieval-sweep.js --documentId=<uuid> [--ks=5,8,10] [--methods=vector,bm25,rrf,interleave] [--compare=results/eval-<ts>.json]");
  process.exit(1);
}
const ks = (argValue("ks") || "5,8,10").split(",").map(Number).sort((a, b) => a - b);
const METHODS = ["vector", "bm25", "rrf", "interleave"];
const methods = (argValue("methods") || "vector").split(",");
const unknown = methods.filter((m) => !METHODS.includes(m));
if (unknown.length) {
  console.error(`Unknown methods: ${unknown.join(", ")} (expected: ${METHODS.join(", ")})`);
  process.exit(1);
}
const FUSION_DEPTH = 50; // candidates taken from each list before fusing

const datasetPath = argValue("dataset") || "eval/datasets/gpt4-report.v1.json";
const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const compare = argValue("compare") && JSON.parse(readFileSync(argValue("compare"), "utf8"));

const squash = (s) => s.toLowerCase().replace(/\s+/g, "");
const chromaUrl = process.env.CHROMA_URL || "http://localhost:8000";
const store = new Chroma(createEmbeddings(), { collectionName: documentId, url: chromaUrl });

// All chunks, by index, for BM25 and to give vector hits a stable identity.
const u = new URL(chromaUrl);
const collection = await new ChromaClient({ host: u.hostname, port: Number(u.port) || 8000, ssl: u.protocol === "https:" }).getCollection({
  name: documentId,
});
const all = await collection.get({ include: ["documents", "metadatas"] });
const chunks = all.ids.map((id, i) => ({ id, text: all.documents[i], page: all.metadatas[i]?.page ?? null }));
const indexByText = new Map();
chunks.forEach((c, i) => indexByText.has(c.text) || indexByText.set(c.text, i));
const bm25 = createBm25(chunks.map((c) => c.text));

const vectorIndices = async (vector, k) =>
  (await store.similaritySearchVectorWithScore(vector, k)).map(([doc]) => {
    const i = indexByText.get(doc.pageContent);
    if (i === undefined) throw new Error("A vector hit doesn't match any stored chunk text");
    return i;
  });

// Ranked chunk indices for each method and k.
const rankings = async (question) => {
  const maxK = ks.at(-1);
  const out = {};
  const vector = await store.embeddings.embedQuery(formatQuery(question));
  if (methods.includes("vector")) {
    out.vector = {};
    for (const k of ks) out.vector[k] = await vectorIndices(vector, k);
  }
  const needFusion = methods.includes("rrf") || methods.includes("interleave");
  const keyword = bm25(question, Math.max(maxK, needFusion ? FUSION_DEPTH : 0)).map((h) => h.index);
  if (methods.includes("bm25")) out.bm25 = Object.fromEntries(ks.map((k) => [k, keyword.slice(0, k)]));
  if (needFusion) {
    const dense = await vectorIndices(vector, FUSION_DEPTH);
    const lists = [dense, keyword.slice(0, FUSION_DEPTH)];
    if (methods.includes("rrf")) {
      const fused = reciprocalRankFusion(lists);
      out.rrf = Object.fromEntries(ks.map((k) => [k, fused.slice(0, k)]));
    }
    if (methods.includes("interleave")) {
      const mixed = interleave(lists);
      out.interleave = Object.fromEntries(ks.map((k) => [k, mixed.slice(0, k)]));
    }
  }
  return out;
};

const score = (q, indices) => {
  const hits = indices.map((i) => chunks[i]);
  const quoteRanks = q.evidence.map((quote) => {
    const i = hits.findIndex((h) => squash(h.text).includes(squash(quote)));
    return i === -1 ? null : i + 1;
  });
  const found = quoteRanks.filter((r) => r !== null);
  return {
    pages: hits.map((h) => h.page),
    chunk_chars: hits.reduce((n, h) => n + h.text.length, 0),
    quote_ranks: quoteRanks,
    evidence: found.length === q.evidence.length ? "sufficient" : found.length ? "partial" : "missing",
    first_evidence_rank: found.length ? Math.min(...found) : null,
    gold_page_hit: hits.some((h) => q.gold_pages.includes(h.page)),
  };
};

// Only questions whose answer needs the document have gold evidence quotes.
const questions = dataset.questions.filter((q) => q.needs !== "web" && q.evidence?.length);

const records = [];
for (const q of questions) {
  const ranked = await rankings(q.question);
  const byMethod = Object.fromEntries(methods.map((m) => [m, Object.fromEntries(ks.map((k) => [k, score(q, ranked[m][k])]))]));
  const record = { id: q.id, category: q.category, needs: q.needs, by_method: byMethod };
  if (compare && byMethod.vector) {
    const saved = compare.cases.find((c) => c.id === q.id)?.meta?.retrieval?.hits?.map((h) => h.page);
    record.matches_compare = JSON.stringify(saved) === JSON.stringify(byMethod.vector[ks[0]].pages);
  }
  records.push(record);
  const cell = (m, k) => {
    const s = byMethod[m][k];
    return s.evidence === "sufficient" ? `✓${s.first_evidence_rank}` : s.evidence === "partial" ? "½" : "·";
  };
  console.log(`${q.id.padEnd(4)} ${methods.map((m) => `${m.padEnd(10)} ${ks.map((k) => cell(m, k).padEnd(4)).join("")}`).join(" ")}`);
}

const summarize = (rows, m, k) => {
  const r = rows.map((x) => x.by_method[m][k]);
  return {
    n: r.length,
    sufficient: r.filter((x) => x.evidence === "sufficient").length,
    partial: r.filter((x) => x.evidence === "partial").length,
    missing: r.filter((x) => x.evidence === "missing").length,
    // Chunk-level MRR of the first evidence chunk, 0 when none is retrieved.
    evidence_mrr: Math.round((r.reduce((s, x) => s + (x.first_evidence_rank ? 1 / x.first_evidence_rank : 0), 0) / r.length) * 1000) / 1000,
    gold_page_hit: r.filter((x) => x.gold_page_hit).length,
    median_chunk_chars: [...r.map((x) => x.chunk_chars)].sort((a, b) => a - b)[Math.floor(r.length / 2)],
  };
};
const categories = [...new Set(records.map((r) => r.category))];
const summary = Object.fromEntries(
  methods.map((m) => [
    m,
    Object.fromEntries(
      ks.map((k) => [
        k,
        { all: summarize(records, m, k), by_category: Object.fromEntries(categories.map((c) => [c, summarize(records.filter((r) => r.category === c), m, k)])) },
      ])
    ),
  ])
);

console.log(`\n${records.length} questions need the document (✓n = all evidence retrieved, first at rank n; ½ = some; · = none)`);
for (const m of methods) {
  for (const k of ks) {
    const s = summary[m][k].all;
    console.log(
      `${m.padEnd(10)} k=${String(k).padEnd(3)} evidence sufficient ${s.sufficient}/${s.n} (partial ${s.partial}) | evidence MRR ${s.evidence_mrr} | gold page hit ${s.gold_page_hit}/${s.n} | median chunk chars ${s.median_chunk_chars}`
    );
  }
}
for (const c of categories) {
  const n = summary[methods[0]][ks[0]].by_category[c].n;
  console.log(`  ${`${c} (${n})`.padEnd(20)} ${methods.map((m) => `${m} ${ks.map((k) => `k${k}=${summary[m][k].by_category[c].sufficient}`).join(" ")}`).join("  ")}`);
}
if (compare && methods.includes("vector")) {
  const same = records.filter((r) => r.matches_compare).length;
  console.log(`vector k=${ks[0]} reproduces the compared eval's pages for ${same}/${records.length} questions`);
}

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
const runAt = new Date().toISOString();
mkdirSync("results", { recursive: true });
const outPath = `results/retrieval-sweep-${runAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(
  outPath,
  JSON.stringify(
    {
      runAt,
      git,
      documentId,
      chunks: chunks.length,
      dataset: { path: datasetPath, version: dataset.version },
      embedding: embeddingConfig(),
      ks,
      methods,
      fusion_depth: FUSION_DEPTH,
      compared_with: argValue("compare") ?? null,
      summary,
      questions: records,
    },
    null,
    2
  ) + "\n"
);
console.log(`Wrote ${outPath}`);
