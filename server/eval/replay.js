// Shared helpers for the frozen-context replay (eval/replay-contexts.js), its
// blind grading sheet (eval/make-replay-sheet.js) and scoring
// (eval/score-replay.js). Pure functions, tested in test/replay.test.js.

import { createHash } from "crypto";

export const sha1 = (s) => createHash("sha1").update(s).digest("hex");

// What the model reads; matches buildContext's promptText.
export const promptText = (system, user) => `${system}\n\n${user}`;

export const CONDITIONS = ["retrieved", "oracle"];

// One call per distinct prompt. When the oracle didn't change the hybrid
// context (the evidence was already retrieved), its prompt is byte-identical
// to the retrieved one, so the retrieved answer is reused for the oracle.
// `conditions` limits the run, e.g. ["retrieved"] to test a retriever only.
export const planCalls = (frozen, ids, conditions = CONDITIONS) =>
  frozen.questions
    .filter((q) => !ids || ids.includes(q.id))
    .flatMap((q) => {
      const retrieved = q.contexts.retrieved.hybrid;
      const oracle = q.contexts.oracle.hybrid;
      const calls = conditions.includes("retrieved") ? [{ id: q.id, condition: "retrieved", context: retrieved }] : [];
      if (conditions.includes("oracle") && (oracle.prompt_sha1 !== retrieved.prompt_sha1 || !conditions.includes("retrieved"))) {
        calls.push({ id: q.id, condition: "oracle", context: oracle });
      }
      return calls;
    });

// ---------------------------------------------------------------------------
// Layer 2: was the gold evidence in the context the model saw?
// ---------------------------------------------------------------------------
const squash = (s) => s.toLowerCase().replace(/\s+/g, "");

// The facts a web snippet must contain to answer each web/mixed question.
// A heuristic stand-in for gold web evidence: the dataset has no snippet-level
// gold, so these encode the reference answers' key values.
export const WEB_ANSWER_PATTERNS = {
  W01: /May 13,? 2024/i,
  W02: /128[,.]?000|128K/i,
  W03: /April 30,? 2025/i,
  W04: /\bv6\b|March 4,? 2024|4 Mar 2024/i,
  W05: /April 2023/i,
  M01: /62nd|48th|69th/i,
  M02: /April 2023/i,
  M03: /METR/,
  M04: /90\.2|91\.0/,
  M05: /8,192|\b8K\b/i,
};

const docEvidence = (sources, quotes) => {
  const text = sources.filter((s) => s.type === "document").map((s) => squash(s.text)).join("\n");
  const found = quotes.filter((q) => text.includes(squash(q))).length;
  return { found, total: quotes.length };
};

const webEvidence = (sources, pattern) =>
  // The date is part of what the model reads ([W#] title (date)), so it counts.
  sources.some((s) => s.type === "web" && pattern.test(`${s.title} ${s.date ?? ""} ${s.snippet}`));

// "sufficient" | "partial" | "missing", per what the question needs.
export const evidenceStatus = (question, sources) => {
  const parts = [];
  if (question.needs !== "web") {
    const { found, total } = docEvidence(sources, question.evidence ?? []);
    parts.push(total === 0 ? 0 : found / total);
  }
  if (question.needs !== "doc") {
    const pattern = WEB_ANSWER_PATTERNS[question.id];
    parts.push(pattern && webEvidence(sources, pattern) ? 1 : 0);
  }
  if (parts.every((p) => p === 1)) return "sufficient";
  if (parts.every((p) => p === 0)) return "missing";
  return "partial";
};

// ---------------------------------------------------------------------------
// Labels and derived judgements
// ---------------------------------------------------------------------------
const CORRECT = { correct: "correct", c: "correct", partial: "partial", p: "partial", incorrect: "incorrect", i: "incorrect", abstained: "abstained", a: "abstained" };
const GROUNDED = { yes: true, y: true, no: false, n: false };

export const parseCorrect = (raw) => CORRECT[raw.trim().toLowerCase()] ?? null;
export const parseGrounded = (raw) => GROUNDED[raw.trim().toLowerCase()] ?? null;

export const groundedCorrect = ({ correct, grounded }) => correct === "correct" && grounded === true;

// Abstention judged against the evidence the model had, not the reference.
export const abstentionCheck = (evidence, correct) => {
  if (correct === "abstained") return evidence === "missing" ? "appropriate" : "over-abstained";
  return evidence === "missing" ? "answered-without-evidence" : "appropriate";
};

// Per-question diagnosis from the retrieved and oracle outcomes.
export const diagnose = (retrievedOk, oracleOk) => {
  if (retrievedOk && oracleOk) return "works";
  if (!retrievedOk && oracleOk) return "retrieval";
  if (!retrievedOk && !oracleOk) return "generation-or-reference";
  return "oracle-worse";
};

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

// Seeded shuffle (mulberry32), so a sheet's row order is reproducible.
export const seededShuffle = (items, seed) => {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// The sources as the model saw them, for judging groundedness.
export const formatSources = (sources) =>
  sources
    .map((s) =>
      s.type === "document"
        ? `[${s.id}] (page ${s.page ?? "?"}) ${s.text.replace(/\s+/g, " ").trim()}`
        : `[${s.id}] ${s.title}${s.date ? ` (${s.date})` : ""} — ${s.url}\n    ${s.snippet}`
    )
    .join("\n\n") || "(no sources)";

// Head-to-head on grounded-correct for the same questions. `before` and `after`
// map question id -> boolean. A change wins only with net >= minNet and at most
// maxRegressions questions that were grounded-correct before and not after.
export const compareArms = (before, after, { minNet = 2, maxRegressions = 1 } = {}) => {
  const ids = Object.keys(before).filter((id) => id in after).sort();
  const gained = ids.filter((id) => !before[id] && after[id]);
  const lost = ids.filter((id) => before[id] && !after[id]);
  const net = gained.length - lost.length;
  return { n: ids.length, gained, lost, net, meetsRule: net >= minNet && lost.length <= maxRegressions };
};
