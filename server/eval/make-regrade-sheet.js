// Builds a side-by-side re-grade sheet: one row per question with the
// baseline ("before") and changed ("after") answers next to each other, the
// sources both saw, and the sources only "after" saw, so one rubric can be
// applied to both versions at once. Not blind: it's for re-checking specific
// questions after a comparison, and the first labels are shown for reference.
//
//   node eval/make-regrade-sheet.js --before=results/replay-<a>.json --after=results/replay-<b>.json --ids=P07,P09
//
// Writes eval/frozen/labels/regrade-<a>-vs-<b>.csv (git-ignored: it shows the
// sources). Fill in correct_before, grounded_before, correct_after,
// grounded_after (same values as the replay sheets) and notes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { csvCell, formatSources } from "./replay.js";

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const [beforePath, afterPath, idsArg] = [argValue("before"), argValue("after"), argValue("ids")];
if (!beforePath || !afterPath || !idsArg) {
  console.error("Usage: node eval/make-regrade-sheet.js --before=results/replay-<a>.json --after=results/replay-<b>.json --ids=P07,P09");
  process.exit(1);
}
const ids = idsArg.split(",");
const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const runOf = (p) => basename(p, ".json").replace(/^replay-/, "");

// A replay with its frozen contexts and first labels (if graded).
const side = (path) => {
  const replay = load(path);
  const run = runOf(path);
  const frozen = load(replay.frozen.path);
  const keyPath = `eval/labels/replay-${run}.key.json`;
  const labelsPath = `eval/labels/replay-${run}.labels.json`;
  const key = existsSync(keyPath) ? load(keyPath).rows : [];
  const labels = existsSync(labelsPath) ? load(labelsPath).labels : [];
  return {
    run,
    datasetPath: frozen.dataset.path,
    answer: (id) => replay.answers.find((a) => a.id === id && a.condition === "retrieved"),
    sources: (id) => frozen.questions.find((q) => q.id === id).contexts.retrieved.hybrid.sources,
    firstLabel: (id) => {
      const k = key.find((r) => r.id === id && r.condition === "retrieved");
      const l = k && labels.find((x) => x.answer_id === k.answer_id);
      return l ? `${k.answer_id}: ${l.correct}/${l.grounded ? "grounded" : "ungrounded"} — ${l.notes}` : "";
    },
  };
};
const before = side(beforePath);
const after = side(afterPath);
const questions = new Map(load(before.datasetPath).questions.map((q) => [q.id, q]));

// Sources are compared by label and content: the shared ones are printed once.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rows = ids.map((id) => {
  const q = questions.get(id);
  if (!q) throw new Error(`Unknown question ${id}`);
  const [sb, sa] = [before.sources(id), after.sources(id)];
  const shared = sa.filter((s) => sb.some((t) => same(s, t)));
  return [
    id,
    q.question,
    q.reference,
    q.grading ?? "",
    formatSources(shared),
    formatSources(sb.filter((s) => !shared.includes(s) && !sa.some((t) => same(s, t)))),
    formatSources(sa.filter((s) => !shared.includes(s))),
    before.answer(id).answer,
    after.answer(id).answer,
    "",
    "",
    "",
    "",
    "",
    before.firstLabel(id),
    after.firstLabel(id),
  ];
});

const header = [
  "question_id",
  "question",
  "reference",
  "grading_notes",
  "sources_both_saw",
  "sources_only_before_saw",
  "sources_only_after_saw",
  "answer_before",
  "answer_after",
  "correct_before",
  "grounded_before",
  "correct_after",
  "grounded_after",
  "notes",
  "first_grading_before",
  "first_grading_after",
];
const out = argValue("out") || `eval/frozen/labels/regrade-${before.run}-vs-${after.run}.csv`;
if (existsSync(out)) {
  console.error(`${out} already exists; delete it first if you really want to regenerate (labels would be lost).`);
  process.exit(1);
}
mkdirSync("eval/frozen/labels", { recursive: true });
writeFileSync(out, "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n");
console.log(`Wrote ${out} (${rows.length} questions)`);
