// Builds a blind labelling sheet for judge calibration from committed eval
// results, plus a key file that maps each row back to its result and the
// judge's verdict. The sheet never shows the judge's verdict or reasoning.
//
// The sample has two strata, reported separately by eval/judge-agreement.js:
//   suspected — answers picked by hand as likely judge errors after reading
//               the 2026-10-20 runs. Over-represents disagreements, so it
//               measures how often those suspicions hold, not judge accuracy.
//   random    — a seeded draw, two per category, spread across modes. This is
//               the stratum to read as an (n=10) estimate of judge agreement.
//
//   node eval/make-label-sheet.js
//
// Writes eval/labels/judge-calibration-v1.csv (to fill in) and
// eval/labels/judge-calibration-v1.key.json (don't open it before labelling).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const RESULTS = {
  docs: "results/eval-2026-10-20T00-56-34-170Z.json",
  web: "results/eval-2026-10-20T01-07-20-397Z.json",
  hybrid: "results/eval-2026-10-20T01-20-53-949Z.json",
};
const DATASET = "eval/datasets/gpt4-report.v1.json";
const OUT_CSV = "eval/labels/judge-calibration-v1.csv";
const OUT_KEY = "eval/labels/judge-calibration-v1.key.json";
const SEED = 20261020;
const RANDOM_PER_CATEGORY = 2;

const SUSPECTED = [
  ["docs", "T03", "abstained although the gold page was retrieved at rank 1"],
  ["docs", "W01", "abstained; reference has a date"],
  ["docs", "M03", "names the Center for Human-Compatible AI as the current name"],
  ["docs", "U01", "says the sources don't mention it after a retrieval miss, not that the report withholds it"],
  ["web", "P06", "abstained; search returned only unrelated pages"],
  ["web", "T01", "abstained; reference has a score"],
  ["web", "T08", "says GPT-4 is toxic at a higher rate than GPT-3.5"],
  ["web", "W05", "abstained; reference has a date"],
  ["hybrid", "M03", "says the organization is now called the Alignment Research Center"],
  ["hybrid", "T06", "mixes 67% with an 88.4% web figure"],
  ["hybrid", "U01", "states web parameter estimates; check attribution against the grading notes"],
  ["hybrid", "W04", "abstained; reference has a version and date"],
];

if (existsSync(OUT_CSV)) {
  console.error(`${OUT_CSV} already exists; delete it first if you really want to regenerate (labels would be lost).`);
  process.exit(1);
}

// Small seeded PRNG (mulberry32), so the draw is reproducible.
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const random = rng(SEED);
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const dataset = JSON.parse(readFileSync(DATASET, "utf8"));
const questions = new Map(dataset.questions.map((q) => [q.id, q]));
const runs = Object.fromEntries(
  Object.entries(RESULTS).map(([mode, path]) => [mode, JSON.parse(readFileSync(path, "utf8"))])
);
const caseFor = (mode, id) => runs[mode].cases.find((c) => c.id === id);

const picked = SUSPECTED.map(([mode, id, reason]) => ({ mode, id, stratum: "suspected", reason }));
const taken = new Set(picked.map((p) => `${p.mode}:${p.id}`));

// Random stratum: only answers the judge actually graded (not HTTP errors).
const pool = shuffle(
  Object.keys(RESULTS).flatMap((mode) =>
    runs[mode].cases.filter((c) => c.method === "llm-judge" && !taken.has(`${mode}:${c.id}`)).map((c) => ({ mode, c }))
  )
);
for (const category of ["doc_prose", "doc_table", "doc_undisclosed", "web", "mixed"]) {
  const modesUsed = new Set();
  for (const { mode, c } of pool) {
    if (picked.filter((p) => p.stratum === "random" && questions.get(p.id).category === category).length >= RANDOM_PER_CATEGORY) break;
    // Two different modes per category, and never the same question twice.
    if (c.category !== category || modesUsed.has(mode) || taken.has(`any:${c.id}`)) continue;
    modesUsed.add(mode);
    taken.add(`any:${c.id}`);
    picked.push({ mode, id: c.id, stratum: "random" });
  }
}

const rows = shuffle(picked).map((p, i) => ({ sample: `S${String(i + 1).padStart(2, "0")}`, ...p }));

const sourcesCited = (c) =>
  (c.citations?.cited ?? [])
    .map((label) => {
      const s = c.sources.find((x) => x.id === label);
      if (!s) return `${label}(?)`;
      return s.type === "document" ? `${label}=p${s.page}` : `${label}=${s.url}`;
    })
    .join(" ");

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const header = ["sample", "mode", "question", "reference", "grading_notes", "answer", "cited_sources", "human_label", "notes"];
const lines = rows.map((r) => {
  const q = questions.get(r.id);
  const c = caseFor(r.mode, r.id);
  return [r.sample, r.mode, q.question, q.reference, q.grading ?? "", c.answer, sourcesCited(c), "", ""].map(csvCell).join(",");
});
mkdirSync("eval/labels", { recursive: true });
// BOM so spreadsheet apps read the file as UTF-8.
writeFileSync(OUT_CSV, "﻿" + [header.join(","), ...lines].join("\r\n") + "\r\n");

const key = {
  created: new Date().toISOString(),
  seed: SEED,
  results: RESULTS,
  dataset: { path: DATASET, version: dataset.version },
  rows: rows.map((r) => {
    const c = caseFor(r.mode, r.id);
    return {
      sample: r.sample,
      mode: r.mode,
      id: r.id,
      category: c.category,
      answerable_in_mode: c.answerable_in_mode,
      stratum: r.stratum,
      reason: r.reason ?? null,
      judge_passed: c.passed,
      judge_reasoning: c.reasoning,
    };
  }),
};
writeFileSync(OUT_KEY, JSON.stringify(key, null, 2) + "\n");

const count = (s) => rows.filter((r) => r.stratum === s).length;
console.log(`Wrote ${OUT_CSV} (${rows.length} rows: ${count("suspected")} suspected, ${count("random")} random) and ${OUT_KEY}`);
