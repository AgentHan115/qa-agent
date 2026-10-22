// Layer-2 sweep: for each dataset question, how many of the gold evidence
// quotes are in the top-k retrieved chunks, for several k. No model calls,
// no search, no re-ingestion: it queries the existing Chroma collection the
// same way pipeline/retrieve.js does (same embedding model, same query
// instruction), embedding each question once and running one Chroma query
// per k, so approximate-search differences between k values are measured
// rather than assumed away.
//
//   node eval/retrieval-sweep.js --documentId=<uuid> [--ks=5,8,10] [--compare=results/eval-<ts>.json]
//
// --compare checks that the smallest k reproduces the pages an earlier eval
// retrieved. Writes results/retrieval-sweep-<timestamp>.json (pages, ranks and
// chunk lengths only; no chunk text).

import dotenv from "dotenv";
dotenv.config();

import { execSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { createEmbeddings, embeddingConfig, formatQuery } from "../lib/llm.js";

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const documentId = argValue("documentId");
if (!documentId) {
  console.error("Usage: node eval/retrieval-sweep.js --documentId=<uuid> [--ks=5,8,10] [--compare=results/eval-<ts>.json]");
  process.exit(1);
}
const ks = (argValue("ks") || "5,8,10").split(",").map(Number).sort((a, b) => a - b);
const datasetPath = argValue("dataset") || "eval/datasets/gpt4-report.v1.json";
const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const compare = argValue("compare") && JSON.parse(readFileSync(argValue("compare"), "utf8"));

const squash = (s) => s.toLowerCase().replace(/\s+/g, "");
const store = new Chroma(createEmbeddings(), { collectionName: documentId, url: process.env.CHROMA_URL || "http://localhost:8000" });

// Only questions whose answer needs the document have gold evidence quotes.
const questions = dataset.questions.filter((q) => q.needs !== "web" && q.evidence?.length);

const records = [];
for (const q of questions) {
  const vector = await store.embeddings.embedQuery(formatQuery(q.question));
  const byK = {};
  for (const k of ks) {
    const hits = (await store.similaritySearchVectorWithScore(vector, k)).map(([doc, distance]) => ({
      page: doc.metadata?.page ?? null,
      chars: doc.pageContent.length,
      distance,
      text: squash(doc.pageContent),
    }));
    // Rank (1-based) of the first chunk containing each quote, or null.
    const quoteRanks = q.evidence.map((quote) => {
      const i = hits.findIndex((h) => h.text.includes(squash(quote)));
      return i === -1 ? null : i + 1;
    });
    const foundRanks = quoteRanks.filter((r) => r !== null);
    const found = foundRanks.length;
    byK[k] = {
      pages: hits.map((h) => h.page),
      chunk_chars: hits.reduce((n, h) => n + h.chars, 0),
      quote_ranks: quoteRanks,
      evidence: found === q.evidence.length ? "sufficient" : found ? "partial" : "missing",
      first_evidence_rank: found ? Math.min(...foundRanks) : null,
      gold_page_hit: hits.some((h) => q.gold_pages.includes(h.page)),
    };
  }
  const record = { id: q.id, category: q.category, needs: q.needs, by_k: byK };
  if (compare) {
    const saved = compare.cases.find((c) => c.id === q.id)?.meta?.retrieval?.hits?.map((h) => h.page);
    record.matches_compare = JSON.stringify(saved) === JSON.stringify(byK[ks[0]].pages);
  }
  records.push(record);
  console.log(
    `${q.id.padEnd(4)} ${ks.map((k) => `k=${k}: ${byK[k].evidence.padEnd(10)}`).join(" ")} first evidence rank (k=${ks.at(-1)}): ${byK[ks.at(-1)].first_evidence_rank ?? "-"}`
  );
}

const summarize = (rows, k) => {
  const r = rows.map((x) => x.by_k[k]);
  const ranks = r.map((x) => x.first_evidence_rank);
  return {
    n: r.length,
    sufficient: r.filter((x) => x.evidence === "sufficient").length,
    partial: r.filter((x) => x.evidence === "partial").length,
    missing: r.filter((x) => x.evidence === "missing").length,
    // Chunk-level MRR of the first evidence chunk, 0 when none is retrieved.
    evidence_mrr: Math.round((ranks.reduce((s, x) => s + (x ? 1 / x : 0), 0) / r.length) * 1000) / 1000,
    gold_page_hit: r.filter((x) => x.gold_page_hit).length,
    median_chunk_chars: [...r.map((x) => x.chunk_chars)].sort((a, b) => a - b)[Math.floor(r.length / 2)],
  };
};
const categories = [...new Set(records.map((r) => r.category))];
const summary = Object.fromEntries(
  ks.map((k) => [
    k,
    { all: summarize(records, k), by_category: Object.fromEntries(categories.map((c) => [c, summarize(records.filter((r) => r.category === c), k)])) },
  ])
);

console.log(`\n${records.length} questions need the document`);
for (const k of ks) {
  const s = summary[k].all;
  console.log(
    `k=${String(k).padEnd(3)} evidence sufficient ${s.sufficient}/${s.n} (partial ${s.partial}, missing ${s.missing}) | evidence MRR ${s.evidence_mrr} | gold page hit ${s.gold_page_hit}/${s.n} | median chunk chars ${s.median_chunk_chars}`
  );
}
for (const c of categories) {
  console.log(`  ${c.padEnd(16)} ${ks.map((k) => `k=${k}: ${summary[k].by_category[c].sufficient}/${summary[k].by_category[c].n}`).join("  ")}`);
}
if (compare) {
  const same = records.filter((r) => r.matches_compare).length;
  console.log(`k=${ks[0]} reproduces the compared eval's pages for ${same}/${records.length} questions`);
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
      dataset: { path: datasetPath, version: dataset.version },
      embedding: embeddingConfig(),
      ks,
      compared_with: argValue("compare") ?? null,
      summary,
      questions: records,
    },
    null,
    2
  ) + "\n"
);
console.log(`Wrote ${outPath}`);
