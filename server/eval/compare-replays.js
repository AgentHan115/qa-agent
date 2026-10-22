// Compares two scored replays (eval/score-replay.js) question by question, on
// the retrieved condition: grounded-correct before and after, evidence status,
// input tokens and generation latency. Used to test a retrieval change against
// the graded baseline with everything else frozen.
//
//   node eval/compare-replays.js --before=results/replay-score-<a>.json --after=results/replay-score-<b>.json
//                                [--determinism=results/replay-<c>.json]
//
// Decision rule (set before the run): adopt the change only if grounded-correct
// improves by at least MIN_NET and at most MAX_REGRESSIONS of the questions
// that were grounded-correct before regress.
//
// --determinism takes a replay of some *baseline* prompts re-run with the same
// model and checks that it reproduced the baseline answers exactly; if it
// didn't, some before/after differences are run-to-run noise.

import { readFileSync } from "fs";
import { groundedCorrect } from "./replay.js";

const MIN_NET = 2;
const MAX_REGRESSIONS = 1;

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const load = (path) => JSON.parse(readFileSync(path, "utf8"));
const [beforePath, afterPath] = [argValue("before"), argValue("after")];
if (!beforePath || !afterPath) {
  console.error("Usage: node eval/compare-replays.js --before=<score.json> --after=<score.json> [--determinism=<replay.json>]");
  process.exit(1);
}
const before = load(beforePath);
const after = load(afterPath);
const beforeReplay = load(before.replay.path);
const afterReplay = load(after.replay.path);

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const retrievedAnswers = (replay) => replay.answers.filter((a) => a.condition === "retrieved");
const ok = (q) => (q?.retrieved ? groundedCorrect(q.retrieved) : null);

const rows = before.questions.map((b) => {
  const a = after.questions.find((x) => x.id === b.id);
  return { id: b.id, category: b.category, before: ok(b), after: ok(a), evidence_before: b.retrieved_evidence, evidence_after: a?.retrieved_evidence };
});
const ungraded = rows.filter((r) => r.before === null || r.after === null).map((r) => r.id);
const graded = rows.filter((r) => r.before !== null && r.after !== null);
const gained = graded.filter((r) => !r.before && r.after);
const lost = graded.filter((r) => r.before && !r.after);
const net = gained.length - lost.length;

console.log("id   category         before  after   evidence before -> after");
for (const r of rows) {
  const mark = (v) => (v === null ? "  -   " : v ? " pass " : " FAIL ");
  const change = r.before !== r.after && r.before !== null && r.after !== null ? (r.after ? "  GAINED" : "  LOST") : "";
  console.log(`${r.id.padEnd(4)} ${r.category.padEnd(16)} ${mark(r.before)}  ${mark(r.after)}  ${r.evidence_before} -> ${r.evidence_after}${change}`);
}

const count = (rs, key) => rs.filter((r) => r[key]).length;
const tokens = (replay) => median(retrievedAnswers(replay).map((a) => a.usage?.input_tokens));
const ms = (replay) => median(retrievedAnswers(replay).map((a) => a.ms));
console.log(`\ngrounded-correct: before ${count(graded, "before")}/${graded.length}, after ${count(graded, "after")}/${graded.length}`);
console.log(`gained ${gained.length} (${gained.map((r) => r.id).join(", ") || "none"}), lost ${lost.length} (${lost.map((r) => r.id).join(", ") || "none"}), net ${net >= 0 ? "+" : ""}${net}`);
console.log(`median input tokens ${tokens(beforeReplay)} -> ${tokens(afterReplay)}; median generation ms ${ms(beforeReplay)} -> ${ms(afterReplay)}`);
if (ungraded.length) console.log(`not graded in both: ${ungraded.join(", ")}`);

const adopt = net >= MIN_NET && lost.length <= MAX_REGRESSIONS;
console.log(
  `\nDecision rule (net >= +${MIN_NET}, regressions <= ${MAX_REGRESSIONS}): ${adopt ? "ADOPT as the pipeline candidate" : "DON'T adopt"}. n = ${graded.length}, one run: directional, not significant.`
);

const determinismPath = argValue("determinism");
if (determinismPath) {
  const rerun = load(determinismPath);
  const results = rerun.answers.map((a) => {
    const original = beforeReplay.answers.find((o) => o.id === a.id && o.prompt_sha1 === a.prompt_sha1);
    return { id: a.id, found: Boolean(original), identical: original ? original.answer === a.answer : false };
  });
  const missing = results.filter((r) => !r.found).map((r) => r.id);
  const same = results.filter((r) => r.identical).length;
  console.log(
    `\nDeterminism: ${same}/${results.length} re-run baseline prompts reproduced the baseline answer exactly` +
      `${missing.length ? `; no baseline answer with the same prompt for ${missing.join(", ")}` : ""}` +
      `${same < results.length ? ". Some before/after differences may be run-to-run noise." : "."}`
  );
}
