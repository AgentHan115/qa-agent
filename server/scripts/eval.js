// Retrieval eval harness — 10 fixed questions about the HBS Lean Startup PDF.
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
// This avoids the false negatives flat keyword matching produced when a correct
// answer used a synonym or different phrasing than the expected keyword.
//
// Usage:
//   1. Upload the PDF and wait for status=ready:
//      curl -F "file=@uploads/hbs-lean-startup.pdf" http://localhost:5001/upload
//   2. Run:
//      node scripts/eval.js --documentId=<uuid>
//
// Optional env vars:
//   SERVER_URL=http://localhost:5001  (default)
//   EVAL_JUDGE_MODEL=<model>          (default: LLM_MODEL — same runtime as the app)
//   EVAL_GRADING=judge|layered        (default: judge)
//   EVAL_WEB=off                      (skip the web path; measures the document pipeline alone)
//
// Each run writes results/eval-<timestamp>.json with the server's /runtime
// record and the git commit, so results can be tied to an exact configuration.

import dotenv from "dotenv";
dotenv.config();

import { mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import http from "http";

import { PromptTemplate } from "@langchain/core/prompts";
import { createChatModel, createEmbeddings, llmConfig } from "../lib/llm.js";
import { z } from "zod";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:5001";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || llmConfig().model;
const GRADING = process.env.EVAL_GRADING || "judge";
const WEB = process.env.EVAL_WEB === "off" ? "off" : "on";

// Similarity band for the embedding pre-filter. Tuned loosely — wide enough
// that the LLM judge only sees genuinely ambiguous cases.
const HIGH_CONFIDENCE_SIM = 0.85; // >= this: confidently correct, skip judge
const LOW_CONFIDENCE_SIM = 0.6; // <= this: confidently wrong, skip judge

// Parse --documentId=<uuid> from argv
const arg = process.argv.find((a) => a.startsWith("--documentId="));
if (!arg) {
  console.error("Usage: node scripts/eval.js --documentId=<uuid>");
  process.exit(1);
}
const documentId = arg.split("=")[1];

// ---------------------------------------------------------------------------
// 10 eval cases — each has a question and a reference answer written from the
// source PDF's concepts. The reference is what a correct answer should convey,
// not a required wording.
// ---------------------------------------------------------------------------
const CASES = [
  {
    id: 1,
    question: "What is the Build-Measure-Learn feedback loop?",
    reference:
      "It is the core iterative cycle of the Lean Startup method: build a minimum viable product, measure how customers actually respond to it, and use that data to learn whether to persevere or pivot, then repeat.",
  },
  {
    id: 2,
    question: "What is a Minimum Viable Product (MVP)?",
    reference:
      "The MVP is the version of a new product that lets a team collect the maximum amount of validated learning about customers with the least effort and development time.",
  },
  {
    id: 3,
    question: "What is validated learning?",
    reference:
      "Validated learning is the process of empirically demonstrating, through rigorous experiments, that a team has discovered valuable truths about a startup's current and future business prospects.",
  },
  {
    id: 4,
    question: "What is a pivot in the context of the lean startup?",
    reference:
      "A pivot is a structured course correction designed to test a new fundamental hypothesis about the product, strategy, or engine of growth, while keeping what has already been learned.",
  },
  {
    id: 5,
    question: "What is innovation accounting?",
    reference:
      "Innovation accounting is a quantitative approach that lets startups operating under uncertainty measure progress, set milestones, and prioritize work using actionable metrics instead of vanity metrics.",
  },
  {
    id: 6,
    question:
      "What is the difference between vanity metrics and actionable metrics?",
    reference:
      "Vanity metrics look good on paper (e.g. total signups or pageviews) but don't show clear cause and effect or guide decisions. Actionable metrics tie a specific action to an observed result, so they can inform real business decisions.",
  },
  {
    id: 7,
    question: "How does the lean startup define waste?",
    reference:
      "Waste is any activity that does not contribute to validated learning about customers — for example building features or products that customers ultimately do not want.",
  },
  {
    id: 8,
    question: "What is a split test or A/B test according to the lean startup?",
    reference:
      "A split test offers different variants of a product to different customer segments at the same time and measures the effect of the change on customer behavior, used to test a hypothesis with real data.",
  },
  {
    id: 9,
    question: "What does it mean to persevere vs pivot?",
    reference:
      "Perseverance means keeping the current strategic hypothesis and continuing to optimize and improve execution. Pivoting means changing the fundamental hypothesis while carrying forward what has already been learned from prior experiments.",
  },
  {
    id: 10,
    question: "What is the role of customers in the lean startup methodology?",
    reference:
      "Customers are the primary source of feedback and validated learning; the startup engages them early and continuously through MVPs, interviews, and usage data to test hypotheses, rather than relying on internal assumptions or long-range planning.",
  },
];

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
Candidate answer (to grade): {candidate}

Judge whether the candidate answer is semantically correct. It does not need to
match the wording of the reference — different phrasing, synonyms, or a more
concise answer are all fine. Fail it only if it omits the central point,
contradicts the reference, or is not actually answering the question.`;

const llmJudge = async (judgeModel, question, reference, candidate) => {
  const prompt = PromptTemplate.fromTemplate(JUDGE_PROMPT);
  const formatted = await prompt.format({ question, reference, candidate });
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
  )}&documentId=${documentId}${WEB === "off" ? "&web=off" : ""}`;
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

  const { ragAnswer, meta } = JSON.parse(res.body);
  const answer = ragAnswer || "";

  const [refVec, ansVec] = await embeddings.embedDocuments([
    c.reference,
    answer,
  ]);
  const similarity = cosineSimilarity(refVec, ansVec);

  if (GRADING === "layered" && similarity >= HIGH_CONFIDENCE_SIM) {
    return { passed: true, method: "embedding", similarity, answer, latencyMs, meta };
  }
  if (GRADING === "layered" && similarity <= LOW_CONFIDENCE_SIM) {
    return { passed: false, method: "embedding", similarity, answer, latencyMs, meta };
  }

  // Judge mode, or the ambiguous zone in layered mode
  const judgment = await llmJudge(judgeModel, c.question, c.reference, answer);
  return {
    passed: judgment.passed,
    method: "llm-judge",
    reasoning: judgment.reasoning,
    similarity,
    answer,
    latencyMs,
    meta,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(`\nEval harness — documentId: ${documentId}`);
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

let passed = 0;
let embeddingDecided = 0;
let judgeEscalated = 0;
const latencies = [];
const records = [];

for (const c of CASES) {
  const result = await runCase(c, embeddings, judgeModel);
  latencies.push(result.latencyMs);
  records.push({ id: c.id, question: c.question, ...result });

  if (result.method === "embedding") embeddingDecided++;
  if (result.method === "llm-judge") judgeEscalated++;

  const status = result.passed ? "PASS" : "FAIL";
  if (result.passed) passed++;

  console.log(`[${status}] Q${c.id}: ${c.question}`);
  console.log(
    `       Method: ${result.method}${
      result.similarity !== undefined ? ` (similarity: ${result.similarity.toFixed(3)})` : ""
    }`
  );
  if (result.reasoning) console.log(`       Judge reasoning: ${result.reasoning}`);
  if (!result.passed) {
    console.log(`       Reference: ${c.reference}`);
    console.log(`       Answer: ${result.answer?.slice(0, 160)}...`);
  }
  console.log(`       Latency: ${result.latencyMs}ms`);
  console.log();
}

const accuracy = ((passed / CASES.length) * 100).toFixed(0);
const avgLatency = Math.round(
  latencies.reduce((a, b) => a + b, 0) / latencies.length
);

console.log("─".repeat(72));
console.log(`Result: ${passed}/${CASES.length} passed — ${accuracy}% accuracy`);
console.log(
  `Grading breakdown: ${embeddingDecided}/${CASES.length} resolved by embedding pre-filter, ${judgeEscalated}/${CASES.length} escalated to LLM judge`
);
console.log(`Avg latency per question: ${avgLatency}ms`);
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
      judgeModel: JUDGE_MODEL,
      web: WEB,
      grading: { mode: GRADING, low: LOW_CONFIDENCE_SIM, high: HIGH_CONFIDENCE_SIM },
      summary: {
        passed,
        total: CASES.length,
        httpErrors: records.filter((r) => r.method === "http-error").length,
        requestErrors: records.filter((r) => r.method === "request-error").length,
        avgLatencyMs: avgLatency,
      },
      cases: records,
    },
    null,
    2
  )
);
console.log(`Raw results written to ${outPath}`);
