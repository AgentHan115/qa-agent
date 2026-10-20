// Compares human labels in the calibration sheet with the judge's verdicts.
//
//   node eval/judge-agreement.js [sheet.csv] [key.json]
//
// Defaults: eval/labels/judge-calibration-v1.csv and its .key.json.
// human_label accepts pass/fail (also p/f, y/n, 1/0, true/false); rows left
// blank are reported as unlabelled and left out. Agreement and Cohen's kappa
// are given per stratum, because the "suspected" stratum was picked for
// likely judge errors and isn't a representative sample.

import { readFileSync } from "fs";
import { agreementStats, parseCsv, parseLabel } from "./agreement.js";

const sheetPath = process.argv[2] || "eval/labels/judge-calibration-v1.csv";
const keyPath = process.argv[3] || sheetPath.replace(/\.csv$/, ".key.json");

const [header, ...rows] = parseCsv(readFileSync(sheetPath, "utf8"));
const col = (name) => {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`${sheetPath} has no "${name}" column`);
  return i;
};
const [iSample, iLabel, iNotes] = ["sample", "human_label", "notes"].map(col);
const key = new Map(JSON.parse(readFileSync(keyPath, "utf8")).rows.map((r) => [r.sample, r]));

const labelled = [];
const unlabelled = [];
const invalid = [];
for (const row of rows) {
  const sample = row[iSample];
  if (!sample) continue;
  const k = key.get(sample);
  if (!k) throw new Error(`${sample} isn't in ${keyPath}`);
  const raw = row[iLabel]?.trim() ?? "";
  if (!raw) {
    unlabelled.push(sample);
    continue;
  }
  const human = parseLabel(raw);
  if (human === null) invalid.push(`${sample} ("${raw}")`);
  else labelled.push({ ...k, human_passed: human, notes: row[iNotes] ?? "" });
}

if (invalid.length) {
  console.error(`Unrecognised human_label values: ${invalid.join(", ")}. Use pass or fail.`);
  process.exit(1);
}

const fmt = (s) =>
  s.n
    ? `n=${s.n}  agreement ${s.agree}/${s.n} (${Math.round((100 * s.agree) / s.n)}%)  kappa ${s.kappa ?? "n/a"}  ` +
      `judge pass & human fail: ${s.judgePassHumanFail}  judge fail & human pass: ${s.judgeFailHumanPass}`
    : "n=0";

console.log(`${labelled.length} labelled, ${unlabelled.length} unlabelled${unlabelled.length ? ` (${unlabelled.join(" ")})` : ""}\n`);
console.log(`All        ${fmt(agreementStats(labelled))}`);
for (const stratum of ["random", "suspected"]) {
  console.log(`${stratum.padEnd(10)} ${fmt(agreementStats(labelled.filter((r) => r.stratum === stratum)))}`);
}
console.log("\nBy category (both strata):");
for (const category of [...new Set(labelled.map((r) => r.category))]) {
  console.log(`  ${category.padEnd(16)} ${fmt(agreementStats(labelled.filter((r) => r.category === category)))}`);
}

const disagreements = labelled.filter((r) => r.judge_passed !== r.human_passed);
if (disagreements.length) {
  console.log("\nDisagreements:");
  for (const r of disagreements) {
    console.log(`  ${r.sample} ${r.mode} ${r.id} (${r.stratum}): judge ${r.judge_passed ? "PASS" : "FAIL"}, human ${r.human_passed ? "PASS" : "FAIL"}`);
    if (r.notes) console.log(`      notes: ${r.notes}`);
    console.log(`      judge: ${r.judge_reasoning}`);
  }
}
