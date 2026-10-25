// Saves a filled side-by-side re-grade sheet (eval/make-regrade-sheet.js) as
// labels, without the source text, and scores both sides on grounded-correct.
// The first labels of each replay are left untouched: a re-grade is a separate
// labelling pass, kept next to them.
//
//   node eval/save-regrade.js --sheet=<regrade.csv> --before=results/replay-<a>.json --after=results/replay-<b>.json
//                             [--note="why the re-grade was done"]
//
// Writes eval/labels/regrade-<a>-vs-<b>.labels.json (refuses to overwrite).

import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { parseCsv } from "./agreement.js";
import { groundedCorrect, parseCorrect, parseGrounded } from "./replay.js";

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const [sheetPath, beforePath, afterPath] = [argValue("sheet"), argValue("before"), argValue("after")];
if (!sheetPath || !beforePath || !afterPath) {
  console.error("Usage: node eval/save-regrade.js --sheet=<regrade.csv> --before=results/replay-<a>.json --after=results/replay-<b>.json [--note=...]");
  process.exit(1);
}
const runOf = (p) => basename(p, ".json").replace(/^replay-/, "");
const [before, after] = [runOf(beforePath), runOf(afterPath)];

const [header, ...lines] = parseCsv(readFileSync(sheetPath, "utf8"));
const col = (name) => {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`${sheetPath} has no "${name}" column`);
  return i;
};
const label = (line, side) => {
  const [rawC, rawG] = [line[col(`correct_${side}`)] ?? "", line[col(`grounded_${side}`)] ?? ""];
  const correct = parseCorrect(rawC);
  const grounded = parseGrounded(rawG);
  if (correct === null || grounded === null) throw new Error(`${line[0]} ${side}: unrecognised labels (correct "${rawC}", grounded "${rawG}")`);
  return { correct, grounded };
};
const rows = lines
  .filter((line) => line[col("question_id")])
  .map((line) => ({ id: line[col("question_id")], before: label(line, "before"), after: label(line, "after"), notes: line[col("notes")] ?? "" }));

const pass = (side) => rows.filter((r) => groundedCorrect(r[side]));
const gained = rows.filter((r) => !groundedCorrect(r.before) && groundedCorrect(r.after)).map((r) => r.id);
const lost = rows.filter((r) => groundedCorrect(r.before) && !groundedCorrect(r.after)).map((r) => r.id);

const out = `eval/labels/regrade-${before}-vs-${after}.labels.json`;
if (existsSync(out)) {
  console.error(`${out} already exists; refusing to overwrite labels.`);
  process.exit(1);
}
writeFileSync(
  out,
  JSON.stringify(
    {
      sheet: basename(sheetPath),
      before: beforePath,
      after: afterPath,
      note: argValue("note") ?? null,
      grounded_correct: { before: pass("before").length, after: pass("after").length, n: rows.length, gained, lost },
      rows,
    },
    null,
    2
  ) + "\n"
);
console.log(`grounded-correct: before ${pass("before").length}/${rows.length}, after ${pass("after").length}/${rows.length}`);
console.log(`gained ${gained.length} (${gained.join(", ") || "none"}), lost ${lost.length} (${lost.join(", ") || "none"})`);
console.log(`Wrote ${out}`);
