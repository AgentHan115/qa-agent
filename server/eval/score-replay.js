// Scores a graded replay sheet (eval/make-replay-sheet.js) into the three
// evaluation layers, per question and by category:
//   1. end-to-end   retrieved context -> answer vs the reference
//   2. retrieval    was the gold evidence in the retrieved context (no labels needed)
//   3. generator    oracle context -> answer vs the reference
// plus a per-question diagnosis: works / retrieval / generation-or-reference /
// oracle-worse, based on grounded-correct (correct AND grounded).
//
//   node eval/score-replay.js --sheet=eval/frozen/labels/replay-<run>.csv
//
// Saves the labels (without source text) to eval/labels/replay-<run>.labels.json
// and the scores to results/replay-score-<run>.json. Unlabelled rows are
// reported and left out; layer 2 is always computed.

import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { parseCsv } from "./csv.js";
import { abstentionCheck, diagnose, groundedCorrect, parseCorrect, parseGrounded } from "./replay.js";

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const sheetPath = argValue("sheet");
if (!sheetPath) {
  console.error("Usage: node eval/score-replay.js --sheet=eval/frozen/labels/replay-<run>.csv");
  process.exit(1);
}
// The run id is what follows "replay-"; a suffix such as ".graded" (a saved
// copy of the sheet) is ignored.
const run = basename(sheetPath, ".csv").replace(/^replay-/, "").replace(/\.[^.]+$/, "");
const key = JSON.parse(readFileSync(`eval/labels/replay-${run}.key.json`, "utf8"));
const keyById = new Map(key.rows.map((r) => [r.answer_id, r]));

const [header, ...lines] = parseCsv(readFileSync(sheetPath, "utf8"));
const col = (name) => {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`${sheetPath} has no "${name}" column`);
  return i;
};
const [iId, iCorrect, iGrounded, iNotes] = ["answer_id", "correct", "grounded", "notes"].map(col);

const labels = [];
const unlabelled = [];
const invalid = [];
for (const line of lines) {
  const answerId = line[iId];
  if (!answerId) continue;
  if (!keyById.has(answerId)) throw new Error(`${answerId} isn't in the key`);
  const [rawC, rawG] = [line[iCorrect] ?? "", line[iGrounded] ?? ""];
  if (!rawC.trim() && !rawG.trim()) {
    unlabelled.push(answerId);
    continue;
  }
  const correct = parseCorrect(rawC);
  const grounded = parseGrounded(rawG);
  if (correct === null || grounded === null) invalid.push(`${answerId} (correct "${rawC}", grounded "${rawG}")`);
  else labels.push({ answer_id: answerId, correct, grounded, notes: line[iNotes] ?? "" });
}
if (invalid.length) {
  console.error(`Unrecognised labels: ${invalid.join(", ")}. correct: correct/partial/incorrect/abstained; grounded: yes/no.`);
  process.exit(1);
}
const labelById = new Map(labels.map((l) => [l.answer_id, l]));

// One entry per question and condition, following used_for for reused answers.
const outcomes = key.rows.flatMap((r) =>
  r.used_for.map((condition) => ({ ...r, condition, label: labelById.get(r.answer_id) ?? null }))
);
const byCondition = (condition) => outcomes.filter((o) => o.condition === condition);

const countLabels = (rows) => {
  const graded = rows.filter((r) => r.label);
  const c = (v) => graded.filter((r) => r.label.correct === v).length;
  return {
    n: rows.length,
    graded: graded.length,
    correct: c("correct"),
    partial: c("partial"),
    incorrect: c("incorrect"),
    abstained: c("abstained"),
    grounded_correct: graded.filter((r) => groundedCorrect(r.label)).length,
    correct_but_ungrounded: graded.filter((r) => r.label.correct === "correct" && !r.label.grounded).length,
  };
};
const countEvidence = (rows) => ({
  n: rows.length,
  sufficient: rows.filter((r) => r.evidence === "sufficient").length,
  partial: rows.filter((r) => r.evidence === "partial").length,
  missing: rows.filter((r) => r.evidence === "missing").length,
});
const categories = [...new Set(key.rows.map((r) => r.category))];
const perCategory = (rows, fn) => Object.fromEntries(categories.map((c) => [c, fn(rows.filter((r) => r.category === c))]));

const retrieved = byCondition("retrieved");
const oracle = byCondition("oracle");

const questionIds = [...new Set(key.rows.map((r) => r.id))];
const perQuestion = questionIds.map((id) => {
  const ret = retrieved.find((o) => o.id === id);
  const ora = oracle.find((o) => o.id === id); // absent in a retrieved-only run
  const row = {
    id,
    category: ret.category,
    retrieved_evidence: ret.evidence,
    oracle_evidence: ora?.evidence ?? null,
    oracle_reused_retrieved_answer: ora ? ora.answer_id === ret.answer_id : null,
    retrieved: ret.label && { correct: ret.label.correct, grounded: ret.label.grounded },
    oracle: ora?.label ? { correct: ora.label.correct, grounded: ora.label.grounded } : null,
  };
  if (ret.label) row.retrieved_abstention = abstentionCheck(ret.evidence, ret.label.correct);
  if (ret.label && ora?.label) row.diagnosis = diagnose(groundedCorrect(ret.label), groundedCorrect(ora.label));
  return row;
});

const tally = (values) => values.reduce((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {});
const summary = {
  sheet: sheetPath,
  replay: key.replay,
  labelled: labels.length,
  unlabelled,
  layer1_end_to_end: { ...countLabels(retrieved), by_category: perCategory(retrieved, countLabels) },
  layer2_retrieval: { ...countEvidence(retrieved), by_category: perCategory(retrieved, countEvidence) },
  layer3_generator: { ...countLabels(oracle), by_category: perCategory(oracle, countLabels) },
  oracle_contexts_not_sufficient: oracle.filter((o) => o.evidence !== "sufficient").map((o) => o.id),
  retrieved_abstention: tally(perQuestion.filter((q) => q.retrieved_abstention).map((q) => q.retrieved_abstention)),
  diagnosis: tally(perQuestion.filter((q) => q.diagnosis).map((q) => q.diagnosis)),
  questions: perQuestion,
};

writeFileSync(`eval/labels/replay-${run}.labels.json`, JSON.stringify({ sheet: sheetPath, labels }, null, 2) + "\n");
writeFileSync(`results/replay-score-${run}.json`, JSON.stringify(summary, null, 2) + "\n");

const fmt = (s) =>
  s.graded
    ? `graded ${s.graded}/${s.n}: correct ${s.correct}, partial ${s.partial}, incorrect ${s.incorrect}, abstained ${s.abstained} | grounded-correct ${s.grounded_correct}/${s.graded}` +
      (s.correct_but_ungrounded ? ` (correct but ungrounded: ${s.correct_but_ungrounded})` : "")
    : `graded 0/${s.n}`;
const fmtE = (s) => `evidence sufficient ${s.sufficient}, partial ${s.partial}, missing ${s.missing} (n=${s.n})`;

console.log(`${labels.length} labelled, ${unlabelled.length} unlabelled\n`);
console.log(`Layer 1, end-to-end (retrieved):  ${fmt(summary.layer1_end_to_end)}`);
console.log(`Layer 2, retrieval:               ${fmtE(summary.layer2_retrieval)}`);
console.log(`Layer 3, generator (oracle):      ${fmt(summary.layer3_generator)}`);
if (summary.oracle_contexts_not_sufficient.length) {
  console.log(`  oracle contexts the evidence check didn't confirm: ${summary.oracle_contexts_not_sufficient.join(" ")}`);
}
console.log("\nBy category:");
for (const c of categories) {
  console.log(`  ${c}`);
  console.log(`    end-to-end  ${fmt(summary.layer1_end_to_end.by_category[c])}`);
  console.log(`    retrieval   ${fmtE(summary.layer2_retrieval.by_category[c])}`);
  console.log(`    generator   ${fmt(summary.layer3_generator.by_category[c])}`);
}
if (Object.keys(summary.diagnosis).length) {
  console.log(`\nDiagnosis: ${JSON.stringify(summary.diagnosis)} | retrieved abstention: ${JSON.stringify(summary.retrieved_abstention)}`);
  for (const q of perQuestion.filter((q) => q.diagnosis && q.diagnosis !== "works")) {
    console.log(`  ${q.id} ${q.diagnosis}: retrieved ${q.retrieved.correct}/${q.retrieved.grounded ? "grounded" : "ungrounded"} (evidence ${q.retrieved_evidence}), oracle ${q.oracle.correct}/${q.oracle.grounded ? "grounded" : "ungrounded"}`);
  }
}
console.log(`\nWrote eval/labels/replay-${run}.labels.json and results/replay-score-${run}.json`);
