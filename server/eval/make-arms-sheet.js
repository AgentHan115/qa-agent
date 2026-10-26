// Builds one blind grading sheet from several replays of the same questions
// ("arms", e.g. one per search provider), plus a key. Rows are shuffled across
// arms and questions, and nothing in the sheet says which arm a row came from.
// Only the retrieved condition is used.
//
//   node eval/make-arms-sheet.js --name=search-2026-10-26 \
//     --arm=serpapi@500=results/replay-<a>.json --arm=querit@500=results/replay-<b>.json \
//     --compare=querit@500:serpapi@500 [--compare=<after>:<before> ...]
//
// --compare records which head-to-heads eval/score-arms.js reports (after:before).
// Writes the sheet to eval/frozen/labels/arms-<name>.csv (git-ignored: it shows
// the sources) and the key to eval/labels/arms-<name>.key.json. Grade with the
// replay rubric in eval/labels/README.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { csvCell, evidenceStatus, formatSources, seededShuffle } from "./replay.js";

const SEED = 20261026;
const args = (name) => process.argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const name = args("name")[0];
const arms = args("arm").map((spec) => {
  const i = spec.indexOf("=");
  return { arm: spec.slice(0, i), path: spec.slice(i + 1) };
});
const comparisons = args("compare").map((spec) => {
  const [after, before] = spec.split(":");
  return { after, before };
});
if (!name || arms.length < 2 || arms.some((a) => !a.arm || !a.path)) {
  console.error("Usage: node eval/make-arms-sheet.js --name=<name> --arm=<label>=<replay.json> --arm=... [--compare=<after>:<before>]");
  process.exit(1);
}
const labels = new Set(arms.map((a) => a.arm));
for (const c of comparisons) {
  if (!labels.has(c.after) || !labels.has(c.before)) {
    console.error(`--compare ${c.after}:${c.before} names an arm that wasn't given`);
    process.exit(1);
  }
}

const load = (p) => JSON.parse(readFileSync(p, "utf8"));
let datasetPath = null;
const pool = arms.flatMap(({ arm, path }) => {
  const replay = load(path);
  const frozen = load(replay.frozen.path);
  if (datasetPath && frozen.dataset.path !== datasetPath) {
    console.error(`${path} uses a different dataset (${frozen.dataset.path})`);
    process.exit(1);
  }
  datasetPath = frozen.dataset.path;
  const answers = replay.answers.filter((a) => a.condition === "retrieved");
  const failed = answers.filter((a) => a.error);
  if (failed.length) {
    console.error(`${path} has failed calls (${failed.map((a) => a.id).join(", ")}); re-run them first.`);
    process.exit(1);
  }
  const contexts = new Map(frozen.questions.map((q) => [q.id, q.contexts.retrieved.hybrid]));
  return answers.map((a) => ({ arm, replayPath: path, frozenSha256: replay.frozen.sha256, a, context: contexts.get(a.id) }));
});
const questions = new Map(load(datasetPath).questions.map((q) => [q.id, q]));
const perArm = new Map(arms.map(({ arm }) => [arm, new Set(pool.filter((p) => p.arm === arm).map((p) => p.a.id))]));
const reference = [...perArm.values()][0];
for (const [arm, ids] of perArm) {
  if (ids.size !== reference.size || [...ids].some((id) => !reference.has(id))) {
    console.error(`Arm ${arm} doesn't cover the same questions as the others.`);
    process.exit(1);
  }
}

const csvPath = `eval/frozen/labels/arms-${name}.csv`;
const keyPath = `eval/labels/arms-${name}.key.json`;
if (existsSync(csvPath) || existsSync(keyPath)) {
  console.error(`${csvPath} or ${keyPath} already exists; refusing to overwrite (labels would be lost).`);
  process.exit(1);
}

const rows = seededShuffle(pool, SEED).map((p, i) => {
  const q = questions.get(p.a.id);
  return { ...p, q, answer_id: `S${String(i + 1).padStart(3, "0")}`, evidence: evidenceStatus(q, p.context.sources) };
});
const header = ["answer_id", "question", "reference", "grading_notes", "sources_the_model_saw", "answer", "correct", "grounded", "notes"];
const lines = rows.map((r) =>
  [r.answer_id, r.q.question, r.q.reference, r.q.grading ?? "", formatSources(r.context.sources), r.a.answer, "", "", ""]
    .map(csvCell)
    .join(",")
);
mkdirSync("eval/frozen/labels", { recursive: true });
mkdirSync("eval/labels", { recursive: true });
writeFileSync(csvPath, "﻿" + [header.join(","), ...lines].join("\r\n") + "\r\n");
writeFileSync(
  keyPath,
  JSON.stringify(
    {
      created: new Date().toISOString(),
      seed: SEED,
      arms: arms.map(({ arm, path }) => ({ arm, replay: path, frozen_sha256: pool.find((p) => p.arm === arm).frozenSha256 })),
      comparisons,
      rows: rows.map((r) => ({
        answer_id: r.answer_id,
        arm: r.arm,
        id: r.q.id,
        category: r.q.category,
        needs: r.q.needs,
        evidence: r.evidence,
        prompt_sha1: r.a.prompt_sha1,
      })),
    },
    null,
    2
  ) + "\n"
);
console.log(`Wrote ${csvPath} (${rows.length} rows from ${arms.length} arms) and ${keyPath}`);
