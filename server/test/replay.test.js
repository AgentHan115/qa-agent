// Helpers for the frozen-context replay: call planning, evidence checks,
// labels and the per-question diagnosis.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abstentionCheck,
  diagnose,
  evidenceStatus,
  groundedCorrect,
  parseCorrect,
  parseGrounded,
  planCalls,
  promptText,
  seededShuffle,
  sha1,
} from "../eval/replay.js";

const ctx = (user) => ({ user, sources: [], prompt_sha1: sha1(promptText("SYS", user)) });
const frozen = {
  questions: [
    { id: "A", contexts: { retrieved: { hybrid: ctx("same") }, oracle: { hybrid: ctx("same") } } },
    { id: "B", contexts: { retrieved: { hybrid: ctx("retrieved") }, oracle: { hybrid: ctx("oracle") } } },
  ],
};

test("planCalls makes one call per distinct prompt", () => {
  const calls = planCalls(frozen);
  assert.deepEqual(
    calls.map((c) => `${c.id}:${c.condition}`),
    ["A:retrieved", "B:retrieved", "B:oracle"]
  );
  assert.deepEqual(planCalls(frozen, ["B"]).map((c) => c.condition), ["retrieved", "oracle"]);
});

test("planCalls can be limited to one condition", () => {
  assert.deepEqual(planCalls(frozen, null, ["retrieved"]).map((c) => `${c.id}:${c.condition}`), ["A:retrieved", "B:retrieved"]);
  // Oracle alone still calls for an oracle prompt identical to the retrieved one.
  assert.deepEqual(planCalls(frozen, null, ["oracle"]).map((c) => `${c.id}:${c.condition}`), ["A:oracle", "B:oracle"]);
});

test("promptText matches the pipeline's system + blank line + user layout", () => {
  assert.equal(promptText("S", "U"), "S\n\nU");
});

const doc = (text) => ({ type: "document", text, page: 1 });
const web = (title, snippet) => ({ type: "web", title, snippet, url: "https://example.com" });

test("evidenceStatus checks document quotes, ignoring whitespace", () => {
  const q = { id: "P99", needs: "doc", evidence: ["by 82% compared", "toxic 0.73%"] };
  assert.equal(evidenceStatus(q, [doc("reduced  by\n82% compared to"), doc("toxic 0.73% of the time")]), "sufficient");
  assert.equal(evidenceStatus(q, [doc("reduced by 82% compared to")]), "partial");
  assert.equal(evidenceStatus(q, [doc("unrelated")]), "missing");
});

test("evidenceStatus uses the answer pattern for web questions and both parts for mixed ones", () => {
  assert.equal(evidenceStatus({ id: "W05", needs: "web" }, [web("GPT-4 Turbo", "cut-off is April 2023.")]), "sufficient");
  assert.equal(evidenceStatus({ id: "W05", needs: "web" }, [web("Knowledge", "a dictionary entry")]), "missing");
  // W01's answer is carried by the result date, which the prompt shows.
  assert.equal(evidenceStatus({ id: "W01", needs: "web" }, [{ ...web("Hello GPT-4o", "We're announcing GPT-4o"), date: "May 13, 2024" }]), "sufficient");
  const m02 = { id: "M02", needs: "both", evidence: ["cuts off in September 2021"] };
  assert.equal(evidenceStatus(m02, [doc("data cuts off in September 2021"), web("Turbo", "April 2023")]), "sufficient");
  assert.equal(evidenceStatus(m02, [doc("data cuts off in September 2021")]), "partial");
  assert.equal(evidenceStatus(m02, []), "missing");
});

test("labels accept short forms and reject others", () => {
  assert.equal(parseCorrect(" C "), "correct");
  assert.equal(parseCorrect("abstained"), "abstained");
  assert.equal(parseCorrect("maybe"), null);
  assert.equal(parseGrounded("Y"), true);
  assert.equal(parseGrounded("no"), false);
  assert.equal(parseGrounded(""), null);
});

test("grounded-correct needs both", () => {
  assert.equal(groundedCorrect({ correct: "correct", grounded: true }), true);
  assert.equal(groundedCorrect({ correct: "correct", grounded: false }), false);
  assert.equal(groundedCorrect({ correct: "partial", grounded: true }), false);
});

test("abstention is judged against the evidence the model had", () => {
  assert.equal(abstentionCheck("missing", "abstained"), "appropriate");
  assert.equal(abstentionCheck("sufficient", "abstained"), "over-abstained");
  assert.equal(abstentionCheck("partial", "abstained"), "over-abstained");
  assert.equal(abstentionCheck("missing", "correct"), "answered-without-evidence");
  assert.equal(abstentionCheck("sufficient", "incorrect"), "appropriate");
});

test("diagnose attributes failures to retrieval or generation", () => {
  assert.equal(diagnose(true, true), "works");
  assert.equal(diagnose(false, true), "retrieval");
  assert.equal(diagnose(false, false), "generation-or-reference");
  assert.equal(diagnose(true, false), "oracle-worse");
});

test("seededShuffle is reproducible and a permutation", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(seededShuffle(xs, 42), seededShuffle(xs, 42));
  assert.deepEqual([...seededShuffle(xs, 42)].sort(), xs);
  assert.notDeepEqual(seededShuffle(xs, 42), xs);
});
