// Scores a graded arms sheet (eval/make-arms-sheet.js): grounded-correct per
// arm, the web/mixed subset, median input tokens and generation time per arm,
// and the head-to-heads recorded in the key, judged by the pre-set rule
// (net >= +2 grounded-correct, <= 1 regression; eval/replay.js compareArms).
//
//   node eval/score-arms.js --sheet=eval/frozen/labels/arms-<name>.graded.csv
//
// Writes eval/labels/arms-<name>.labels.json and results/arms-score-<name>.json;
// refuses to overwrite either.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { parseCsv } from "./csv.js";
import { compareArms, groundedCorrect, parseCorrect, parseGrounded } from "./replay.js";

const sheetPath = process.argv.find((a) => a.startsWith("--sheet="))?.slice(8);
if (!sheetPath) {
  console.error("Usage: node eval/score-arms.js --sheet=eval/frozen/labels/arms-<name>.csv");
  process.exit(1);
}
// A suffix such as ".graded" (a saved copy of the sheet) is ignored.
const name = basename(sheetPath, ".csv").replace(/^arms-/, "").replace(/\.[^.]+$/, "");
const key = JSON.parse(readFileSync(`eval/labels/arms-${name}.key.json`, "utf8"));
const labelsPath = `eval/labels/arms-${name}.labels.json`;
const scorePath = `results/arms-score-${name}.json`;
for (const p of [labelsPath, scorePath]) {
  if (existsSync(p)) {
    console.error(`${p} already exists; refusing to overwrite.`);
    process.exit(1);
  }
}

const [header, ...lines] = parseCsv(readFileSync(sheetPath, "utf8"));
const col = (n) => {
  const i = header.indexOf(n);
  if (i === -1) throw new Error(`${sheetPath} has no "${n}" column`);
  return i;
};
const keyById = new Map(key.rows.map((r) => [r.answer_id, r]));
const labels = [];
const problems = [];
for (const line of lines) {
  const answerId = line[col("answer_id")];
  if (!answerId) continue;
  if (!keyById.has(answerId)) throw new Error(`${answerId} isn't in the key`);
  const [rawC, rawG] = [line[col("correct")] ?? "", line[col("grounded")] ?? ""];
  const correct = parseCorrect(rawC);
  const grounded = parseGrounded(rawG);
  if (correct === null || grounded === null) problems.push(`${answerId} (correct "${rawC}", grounded "${rawG}")`);
  else labels.push({ answer_id: answerId, correct, grounded, notes: line[col("notes")] ?? "" });
}
const missing = key.rows.filter((r) => !labels.some((l) => l.answer_id === r.answer_id)).map((r) => r.answer_id);
if (problems.length || missing.length) {
  console.error(`Every row must be labelled. Unrecognised: ${problems.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}.`);
  process.exit(1);
}

const labelById = new Map(labels.map((l) => [l.answer_id, l]));
const rows = key.rows.map((r) => ({ ...r, label: labelById.get(r.answer_id) }));
const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const tally = (rs) => {
  const c = (v) => rs.filter((r) => r.label.correct === v).length;
  return {
    n: rs.length,
    grounded_correct: rs.filter((r) => groundedCorrect(r.label)).length,
    correct: c("correct"),
    partial: c("partial"),
    incorrect: c("incorrect"),
    abstained: c("abstained"),
    ungrounded: rs.filter((r) => !r.label.grounded).length,
  };
};
const passMap = (arm) => Object.fromEntries(rows.filter((r) => r.arm === arm).map((r) => [r.id, groundedCorrect(r.label)]));

const arms = key.arms.map(({ arm, replay }) => {
  const rs = rows.filter((r) => r.arm === arm);
  const answers = JSON.parse(readFileSync(replay, "utf8")).answers.filter((a) => a.condition === "retrieved");
  return {
    arm,
    replay,
    all: tally(rs),
    web_and_mixed: tally(rs.filter((r) => r.needs !== "doc")),
    median_input_tokens: median(answers.map((a) => a.usage?.input_tokens)),
    median_generation_ms: median(answers.map((a) => a.ms)),
  };
});
const comparisons = key.comparisons.map(({ after, before }) => ({ after, before, ...compareArms(passMap(before), passMap(after)) }));

writeFileSync(labelsPath, JSON.stringify({ sheet: sheetPath, labels }, null, 2) + "\n");
writeFileSync(
  scorePath,
  JSON.stringify(
    {
      sheet: sheetPath,
      key: `eval/labels/arms-${name}.key.json`,
      rule: "net >= +2 grounded-correct and <= 1 regression",
      arms,
      comparisons,
      questions: [...new Set(rows.map((r) => r.id))].sort().map((id) => ({
        id,
        ...Object.fromEntries(
          rows.filter((r) => r.id === id).map((r) => [r.arm, { correct: r.label.correct, grounded: r.label.grounded, evidence: r.evidence }])
        ),
      })),
    },
    null,
    2
  ) + "\n"
);

const fmt = (t) => `${t.grounded_correct}/${t.n} grounded-correct (correct ${t.correct}, partial ${t.partial}, incorrect ${t.incorrect}, abstained ${t.abstained}; ungrounded ${t.ungrounded})`;
for (const a of arms) {
  console.log(`${a.arm.padEnd(12)} ${fmt(a.all)}`);
  console.log(`${"".padEnd(12)} web+mixed ${fmt(a.web_and_mixed)} | median input tokens ${a.median_input_tokens}, generation ${a.median_generation_ms} ms`);
}
for (const c of comparisons) {
  console.log(
    `\n${c.after} vs ${c.before}: gained ${c.gained.length} (${c.gained.join(", ") || "none"}), lost ${c.lost.length} (${c.lost.join(", ") || "none"}), net ${c.net >= 0 ? "+" : ""}${c.net} -> ${c.meetsRule ? "MEETS the rule" : "does not meet the rule"}`
  );
}
console.log(`\nWrote ${labelsPath} and ${scorePath}`);
