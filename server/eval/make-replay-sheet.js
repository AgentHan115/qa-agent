// Builds a blind two-label grading sheet from a replay result
// (eval/replay-contexts.js), plus a key file. Every distinct answer appears
// once, shuffled across questions and conditions; the sheet doesn't say
// whether a row's context was retrieved or oracle.
//
//   node eval/make-replay-sheet.js --replay=results/replay-<ts>.json
//
// Writes the sheet to eval/frozen/labels/replay-<run>.csv (git-ignored: it
// shows the sources, i.e. report text and search snippets) and the key to
// eval/labels/replay-<run>.key.json. The grader fills in `correct`
// (correct/partial/incorrect/abstained) and `grounded` (yes/no); rules are in
// eval/labels/README.md. eval/score-replay.js saves the labels, without the
// source text, next to the key so they can be committed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { csvCell, evidenceStatus, formatSources, seededShuffle } from "./replay.js";

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const replayPath = argValue("replay");
if (!replayPath) {
  console.error("Usage: node eval/make-replay-sheet.js --replay=results/replay-<ts>.json [--dataset=<path>]");
  process.exit(1);
}

const SEED = 20261021;
const replay = JSON.parse(readFileSync(replayPath, "utf8"));
const frozen = JSON.parse(readFileSync(replay.frozen.path, "utf8"));
const dataset = JSON.parse(readFileSync(argValue("dataset") || frozen.dataset.path, "utf8"));
const questions = new Map(dataset.questions.map((q) => [q.id, q]));
const frozenQuestions = new Map(frozen.questions.map((q) => [q.id, q]));

const failed = replay.answers.filter((a) => a.error);
if (failed.length) {
  console.error(`The replay has ${failed.length} failed calls (${failed.map((a) => `${a.id}/${a.condition}`).join(", ")}); re-run them first.`);
  process.exit(1);
}

const run = basename(replayPath, ".json").replace(/^replay-/, "");
const csvPath = `eval/frozen/labels/replay-${run}.csv`;
const keyPath = `eval/labels/replay-${run}.key.json`;
if (existsSync(csvPath)) {
  console.error(`${csvPath} already exists; delete it first if you really want to regenerate (labels would be lost).`);
  process.exit(1);
}

const rows = seededShuffle(replay.answers, SEED).map((a, i) => {
  const q = questions.get(a.id);
  const context = frozenQuestions.get(a.id).contexts[a.condition].hybrid;
  return {
    answer_id: `R${String(i + 1).padStart(2, "0")}`,
    answer: a,
    q,
    sources: context.sources,
    evidence: evidenceStatus(q, context.sources),
    // A retrieved answer also stands for the oracle when the prompts were identical.
    used_for: a.condition === "retrieved" && replay.reused.includes(a.id) ? ["retrieved", "oracle"] : [a.condition],
  };
});

const header = ["answer_id", "question", "reference", "grading_notes", "sources_the_model_saw", "answer", "correct", "grounded", "notes"];
const lines = rows.map((r) =>
  [r.answer_id, r.q.question, r.q.reference, r.q.grading ?? "", formatSources(r.sources), r.answer.answer, "", "", ""].map(csvCell).join(",")
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
      replay: { path: replayPath, frozen_sha256: replay.frozen.sha256, stub: replay.stub },
      rows: rows.map((r) => ({
        answer_id: r.answer_id,
        id: r.q.id,
        category: r.q.category,
        needs: r.q.needs,
        condition: r.answer.condition,
        used_for: r.used_for,
        evidence: r.evidence,
        prompt_sha1: r.answer.prompt_sha1,
      })),
    },
    null,
    2
  ) + "\n"
);
console.log(`Wrote ${csvPath} (${rows.length} rows) and ${keyPath}`);
