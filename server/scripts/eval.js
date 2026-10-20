// Eval harness: asks every question of a labelled dataset through /chat and
// grades the answers. Default dataset: eval/datasets/gpt4-report.v1.json
// (35 questions about the GPT-4 Technical Report, approved 2026-10-19).
//
// Per question it records:
//   - correctness: an LLM judge compares the answer with the reference, using the
//     question's `grading` notes when it has them
//   - retrieval: rank of the first retrieved chunk on a gold page, recall@k
//     (hit@k: gold pages are alternatives) and reciprocal rank, from the raw
//     ranked hits in meta.retrieval.hits (needs a server with that field)
//   - whether the answer cited a document source on a gold page
//   - whether the mode's sources can answer it at all (`answerable_in_mode`):
//     `docs` can't answer web questions, `web` can't answer document ones
// and summarizes them overall, by category and by complexity, plus P50/P95
// per pipeline stage. See eval/metrics.js for the definitions.
//
// Grading modes (EVAL_GRADING):
//   judge (default) — every answer is graded by the LLM judge. The embedding
//     similarity is still recorded, but not used to decide.
//   layered — the original scheme below. Its similarity band was tuned for
//     OpenAI ada-002 embeddings and must be recalibrated for any other model.
//
// Layered grading:
//   1. Embed the reference answer and the candidate answer, compare cosine similarity.
//   2. Similarity outside the [LOW, HIGH] band is decided immediately — cheap and fast,
//      no LLM call needed for clearly-right or clearly-wrong answers.
//   3. Similarity inside the band is ambiguous -> escalate to an LLM judge that reads
//      the question, the reference answer, and the candidate, and decides whether they
//      are semantically equivalent (same key facts, different wording is fine).
//
// Usage (from server/, with the API running and the document ready):
//   node scripts/eval.js --documentId=<uuid>
//
// Options:
//   --dataset=<path>                  (default: eval/datasets/gpt4-report.v1.json)
//   --ids=P01,T02                     only these questions (smoke tests)
//   --allow-draft                     run a dataset whose status isn't APPROVED
//
// Optional env vars:
//   SERVER_URL=http://localhost:5001  (default)
//   EVAL_JUDGE_MODEL=<model>          (default: LLM_MODEL — same runtime as the app)
//   EVAL_GRADING=judge|layered        (default: judge)
//   EVAL_MODE=docs|web|hybrid         (default: hybrid) — which sources /chat may use
//
// Each run writes results/eval-<timestamp>.json with the dataset version, the
// server's /runtime record and the git commit, so results can be tied to an
// exact configuration.

import dotenv from "dotenv";
dotenv.config();

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { execSync } from "child_process";
import http from "http";

import { PromptTemplate } from "@langchain/core/prompts";
import { createChatModel, createEmbeddings, llmConfig } from "../lib/llm.js";
import { z } from "zod";
import {
  answerableInMode,
  citedGoldPage,
  retrievalApplies,
  retrievalScores,
  stageLatencies,
  summarize,
} from "../eval/metrics.js";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:5001";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || llmConfig().model;
const GRADING = process.env.EVAL_GRADING || "judge";
const MODE = process.env.EVAL_MODE || "hybrid";

// Similarity band for the embedding pre-filter. Tuned loosely — wide enough
// that the LLM judge only sees genuinely ambiguous cases.
const HIGH_CONFIDENCE_SIM = 0.85; // >= this: confidently correct, skip judge
const LOW_CONFIDENCE_SIM = 0.6; // <= this: confidently wrong, skip judge

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const documentId = argValue("documentId");
if (!documentId) {
  console.error("Usage: node scripts/eval.js --documentId=<uuid> [--dataset=<path>] [--ids=P01,T02] [--allow-draft]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Dataset — each question has a reference answer (what a correct answer should
// convey, not a required wording), gold pages and optional grading notes.
// ---------------------------------------------------------------------------
const datasetPath = argValue("dataset") || "eval/datasets/gpt4-report.v1.json";
const datasetText = readFileSync(datasetPath, "utf8");
const dataset = JSON.parse(datasetText);
if (dataset.status !== "APPROVED" && !process.argv.includes("--allow-draft")) {
  console.error(`Dataset ${datasetPath} has status "${dataset.status}", not APPROVED. Pass --allow-draft to run it anyway.`);
  process.exit(1);
}
const onlyIds = argValue("ids")?.split(",");
const CASES = onlyIds ? dataset.questions.filter((q) => onlyIds.includes(q.id)) : dataset.questions;
if (onlyIds && CASES.length !== onlyIds.length) {
  const known = new Set(dataset.questions.map((q) => q.id));
  console.error(`Unknown question ids: ${onlyIds.filter((id) => !known.has(id)).join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Grading helpers
// ---------------------------------------------------------------------------
const cosineSimilarity = (a, b) => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const judgeSchema = z.object({
  passed: z
    .boolean()
    .describe(
      "true if the candidate answer is semantically correct and conveys the same key facts as the reference answer"
    ),
  reasoning: z.string().describe("one short sentence explaining the decision"),
});

const JUDGE_PROMPT = `You are grading a RAG system's answer against a reference answer.

Question: {question}
Reference answer (ground truth): {reference}
{grading}Candidate answer (to grade): {candidate}

Judge whether the candidate answer is semantically correct. It does not need to
match the wording of the reference — different phrasing, synonyms, or a more
concise answer are all fine. Fail it only if it omits the central point,
contradicts the reference, or is not actually answering the question.
Grading notes, when given, override these general rules.`;

const llmJudge = async (judgeModel, { question, reference, grading }, candidate) => {
  const prompt = PromptTemplate.fromTemplate(JUDGE_PROMPT);
  const formatted = await prompt.format({
    question,
    reference,
    grading: grading ? `Grading notes: ${grading}\n` : "",
    candidate,
  });
  const structuredModel = judgeModel.withStructuredOutput(judgeSchema);
  return structuredModel.invoke(formatted);
};

// GET with an explicit timeout. Node's fetch gives up waiting for response
// headers after 300s, which slow local models can exceed.
const REQUEST_TIMEOUT_MS = parseInt(process.env.EVAL_REQUEST_TIMEOUT_MS || "900000", 10);
const httpGet = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ ok: res.statusCode < 400, status: res.statusCode, body }));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`)));
    req.on("error", reject);
  });

// ---------------------------------------------------------------------------
// Run a single eval case
// ---------------------------------------------------------------------------
async function runCase(c, embeddings, judgeModel) {
  const url = `${SERVER_URL}/chat?question=${encodeURIComponent(
    c.question
  )}&documentId=${documentId}&mode=${MODE}`;
  const t0 = Date.now();
  let res;
  try {
    res = await httpGet(url);
  } catch (err) {
    return { passed: false, method: "request-error", answer: err.message, latencyMs: Date.now() - t0 };
  }
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    const body = res.body;
    return {
      passed: false,
      method: "http-error",
      answer: `HTTP ${res.status}: ${body}`,
      httpStatus: res.status,
      latencyMs,
    };
  }

  const body = JSON.parse(res.body);
  const answer = body.answer || "";
  // Kept with every case: what the answer cited, and what it was given.
  const grounding = {
    citations: body.citations,
    web: body.web,
    sources: body.sources.map((s) =>
      s.type === "document" ? { id: s.id, type: s.type, page: s.page } : { id: s.id, type: s.type, url: s.url }
    ),
  };
  const meta = body.meta;

  const [refVec, ansVec] = await embeddings.embedDocuments([
    c.reference,
    answer,
  ]);
  const similarity = cosineSimilarity(refVec, ansVec);

  if (GRADING === "layered" && similarity >= HIGH_CONFIDENCE_SIM) {
    return { passed: true, method: "embedding", similarity, answer, latencyMs, ...grounding, meta };
  }
  if (GRADING === "layered" && similarity <= LOW_CONFIDENCE_SIM) {
    return { passed: false, method: "embedding", similarity, answer, latencyMs, ...grounding, meta };
  }

  // Judge mode, or the ambiguous zone in layered mode
  const judgment = await llmJudge(judgeModel, c, answer);
  return {
    passed: judgment.passed,
    method: "llm-judge",
    reasoning: judgment.reasoning,
    similarity,
    answer,
    latencyMs,
    ...grounding,
    meta,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(`\nEval harness — documentId: ${documentId}, mode: ${MODE}`);
console.log(`Dataset: ${dataset.name} v${dataset.version} (${dataset.status}), ${CASES.length} questions`);
console.log(`Server: ${SERVER_URL}`);
console.log(
  GRADING === "layered"
    ? `Grading: embedding pre-filter (band ${LOW_CONFIDENCE_SIM}-${HIGH_CONFIDENCE_SIM}) + LLM judge (${JUDGE_MODEL}) for ambiguous cases\n`
    : `Grading: LLM judge (${JUDGE_MODEL}) on every answer; embedding similarity recorded only\n`
);

// What the server is actually running, captured before the run starts.
const runtime = await fetch(`${SERVER_URL}/runtime`)
  .then((r) => r.json())
  .catch((err) => ({ error: err.message }));
const git = (() => {
  try {
    const commit = execSync("git rev-parse HEAD").toString().trim();
    const dirty = execSync("git status --porcelain --untracked-files=no").toString().trim().length > 0;
    return { commit, dirty };
  } catch {
    return null;
  }
})();
console.log("─".repeat(72));

const embeddings = createEmbeddings();
const judgeModel = createChatModel({ model: JUDGE_MODEL });

// Retrieval cut-offs, up to the server's top-k.
const topK = runtime.retrieval?.top_k ?? 5;
const KS = [...new Set([1, 3, topK])].filter((k) => k <= topK).sort((a, b) => a - b);

// Adds the dataset-derived scores to one case's result.
const score = (c, result) => {
  const record = {
    id: c.id,
    category: c.category,
    complexity: c.complexity,
    needs: c.needs,
    question: c.question,
    answerable_in_mode: answerableInMode(c, MODE),
    gold_pages: c.gold_pages,
    ...result,
  };
  const hits = result.meta?.retrieval?.hits;
  if (retrievalApplies(c, MODE) && hits) {
    record.retrieval_scores = { hit_pages: hits.map((h) => h.page), ...retrievalScores(hits.map((h) => h.page), c.gold_pages, KS) };
  }
  if (retrievalApplies(c, MODE) && result.sources) {
    record.cited_gold_page = citedGoldPage(result.citations, result.sources, c.gold_pages);
  }
  return record;
};

let embeddingDecided = 0;
let judgeEscalated = 0;
const records = [];

for (const c of CASES) {
  const record = score(c, await runCase(c, embeddings, judgeModel));
  records.push(record);

  if (record.method === "embedding") embeddingDecided++;
  if (record.method === "llm-judge") judgeEscalated++;

  console.log(`[${record.passed ? "PASS" : "FAIL"}] ${c.id} (${c.category}${record.answerable_in_mode ? "" : ", not answerable in this mode"}): ${c.question}`);
  console.log(
    `       Method: ${record.method}${
      record.similarity !== undefined ? ` (similarity: ${record.similarity.toFixed(3)})` : ""
    }`
  );
  if (record.reasoning) console.log(`       Judge reasoning: ${record.reasoning}`);
  if (!record.passed) {
    console.log(`       Reference: ${c.reference}`);
    console.log(`       Answer: ${record.answer?.slice(0, 160)}...`);
  }
  if (record.retrieval_scores) {
    const { hit_pages, first_gold_rank } = record.retrieval_scores;
    console.log(`       Retrieved pages: ${hit_pages.join(" ")} | gold: ${c.gold_pages.join(" ")} | first gold rank: ${first_gold_rank ?? "none"}`);
  }
  if (record.citations) {
    const { cited, invalid } = record.citations;
    console.log(
      `       Cited: ${cited.join(" ") || "(none)"}${invalid.length ? ` | INVALID: ${invalid.join(" ")}` : ""}${
        record.cited_gold_page !== undefined ? ` | gold page cited: ${record.cited_gold_page ? "yes" : "no"}` : ""
      } | web: ${record.web?.status ?? "n/a"}`
    );
  }
  console.log(`       Latency: ${record.latencyMs}ms`);
  console.log();
}

const missingHits = records.filter((r) => retrievalApplies(r, MODE) && r.meta?.retrieval?.status === "ok" && !r.meta.retrieval.hits).length;
const groupBy = (key) =>
  Object.fromEntries(
    [...new Set(records.map((r) => r[key]))].map((value) => [value, summarize(records.filter((r) => r[key] === value), KS)])
  );
const overall = summarize(records, KS);
const byCategory = groupBy("category");
const byComplexity = groupBy("complexity");
const latency = stageLatencies(records);

const fmtRetrieval = (r) =>
  r ? `MRR ${r.mrr} | ${KS.map((k) => `R@${k} ${r.recall_at[k]}`).join(" ")} (n=${r.n})` : "n/a";

console.log("─".repeat(72));
console.log(`Result: ${overall.passed}/${overall.n} passed; answerable in ${MODE} mode: ${overall.answerable.passed}/${overall.answerable.n}`);
console.log(`Retrieval: ${fmtRetrieval(overall.retrieval)}`);
if (overall.cited_gold_page) console.log(`Gold page cited: ${overall.cited_gold_page.yes}/${overall.cited_gold_page.n}`);
for (const [category, s] of Object.entries(byCategory)) {
  console.log(`  ${category.padEnd(16)} ${s.passed}/${s.n} passed | ${fmtRetrieval(s.retrieval)}`);
}
console.log(
  `Grading breakdown: ${embeddingDecided}/${CASES.length} resolved by embedding pre-filter, ${judgeEscalated}/${CASES.length} escalated to LLM judge`
);
for (const [stage, l] of Object.entries(latency)) console.log(`  ${stage.padEnd(11)} P50 ${l.p50}ms  P95 ${l.p95}ms (n=${l.n})`);
if (missingHits) {
  console.log(`WARNING: ${missingHits} responses had no meta.retrieval.hits; restart the server on this commit for retrieval metrics.`);
}
console.log("─".repeat(72));

// Persist raw per-case results (answers, grading, server-side stage timings
// and token usage) so runs can be compared later.
const runAt = new Date().toISOString();
mkdirSync("results", { recursive: true });
const outPath = `results/eval-${runAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(
  outPath,
  JSON.stringify(
    {
      runAt,
      server: SERVER_URL,
      documentId,
      git,
      runtime,
      dataset: {
        path: datasetPath,
        name: dataset.name,
        version: dataset.version,
        status: dataset.status,
        sha1: createHash("sha1").update(datasetText).digest("hex"),
        ids: onlyIds ?? "all",
      },
      judgeModel: JUDGE_MODEL,
      mode: MODE,
      grading: { mode: GRADING, low: LOW_CONFIDENCE_SIM, high: HIGH_CONFIDENCE_SIM },
      summary: {
        ...overall,
        retrieval_ks: KS,
        by_category: byCategory,
        by_complexity: byComplexity,
        latency_ms: latency,
        httpErrors: records.filter((r) => r.method === "http-error").length,
        requestErrors: records.filter((r) => r.method === "request-error").length,
        responsesMissingHits: missingHits,
        answersWithValidCitation: records.filter((r) => r.citations?.cited.length > 0).length,
        invalidCitationLabels: records.reduce((n, r) => n + (r.citations?.invalid.length ?? 0), 0),
        webStatus: records.reduce((acc, r) => {
          const s = r.web?.status ?? "n/a";
          acc[s] = (acc[s] ?? 0) + 1;
          return acc;
        }, {}),
      },
      cases: records,
    },
    null,
    2
  )
);
console.log(`Raw results written to ${outPath}`);
