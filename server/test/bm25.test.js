// BM25 and rank fusion used by eval/retrieval-sweep.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBm25, interleave, reciprocalRankFusion, tokenize } from "../eval/bm25.js";

test("tokenize keeps decimals and names, splits glued table values, drops stopwords", () => {
  assert.deepEqual(tokenize("MMLU [49]86.4%70.0%"), ["mmlu", "49", "86.4", "70.0"]);
  assert.deepEqual(tokenize("How did the authors check HumanEval?"), ["authors", "check", "humaneval"]);
});

test("BM25 ranks the chunk with the rare matching term first", () => {
  const search = createBm25([
    "GPT-4 performance on many exams and benchmarks",
    "Codeforces Rating 392 (below 5th)",
    "GPT-4 GPT-4 GPT-4 exams",
  ]);
  const hits = search("What Codeforces rating did GPT-4 achieve?", 3);
  assert.equal(hits[0].index, 1);
  assert.ok(hits.every((h) => h.score > 0));
});

test("BM25 returns no hits for a query with no matching terms", () => {
  assert.deepEqual(createBm25(["alpha beta"])("gamma", 5), []);
});

test("BM25 normalizes for chunk length", () => {
  const search = createBm25(["humaneval", `humaneval ${"filler ".repeat(50)}`]);
  assert.equal(search("humaneval", 2)[0].index, 0);
});

test("reciprocal rank fusion rewards ids ranked well in both lists", () => {
  // b is 2nd and 1st; a and c each appear once.
  assert.deepEqual(reciprocalRankFusion([["a", "b"], ["b", "c"]]), ["b", "a", "c"]);
  assert.deepEqual(reciprocalRankFusion([["x"]]), ["x"]);
});

test("interleave alternates lists and skips duplicates", () => {
  assert.deepEqual(interleave([["a", "b", "c"], ["b", "d"]]), ["a", "b", "d", "c"]);
});
