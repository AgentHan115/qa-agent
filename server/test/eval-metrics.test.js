// Scoring helpers used by scripts/eval.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerableInMode,
  citedGoldPage,
  percentile,
  retrievalApplies,
  retrievalScores,
  stageLatencies,
  summarize,
} from "../eval/metrics.js";

const KS = [1, 3, 5];

test("retrieval scores use the first chunk on any gold page", () => {
  assert.deepEqual(retrievalScores([9, 5, 5, 1, 2], [1, 5], KS), {
    first_gold_rank: 2,
    reciprocal_rank: 0.5,
    hit_at: { 1: 0, 3: 1, 5: 1 },
  });
  assert.deepEqual(retrievalScores([7, 7, 8], [5], KS), {
    first_gold_rank: null,
    reciprocal_rank: 0,
    hit_at: { 1: 0, 3: 0, 5: 0 },
  });
  assert.equal(retrievalScores([5], [5], KS).hit_at[1], 1);
});

test("retrieval metrics apply only to document questions in modes that search the document", () => {
  const doc = { needs: "doc", gold_pages: [2] };
  const web = { needs: "web", gold_pages: [] };
  assert.equal(retrievalApplies(doc, "docs"), true);
  assert.equal(retrievalApplies(doc, "hybrid"), true);
  assert.equal(retrievalApplies(doc, "web"), false);
  assert.equal(retrievalApplies(web, "hybrid"), false);
});

test("answerable_in_mode follows which sources the mode can reach", () => {
  assert.equal(answerableInMode({ needs: "doc" }, "docs"), true);
  assert.equal(answerableInMode({ needs: "web" }, "docs"), false);
  assert.equal(answerableInMode({ needs: "both" }, "docs"), false);
  assert.equal(answerableInMode({ needs: "both" }, "hybrid"), true);
  assert.equal(answerableInMode({ needs: "doc" }, "web"), false);
  assert.equal(answerableInMode({ needs: "web" }, "web"), true);
});

test("gold page counts as cited only through a cited document source", () => {
  const sources = [
    { id: "D1", type: "document", page: 3 },
    { id: "D2", type: "document", page: 5 },
    { id: "W1", type: "web", url: "https://example.com" },
  ];
  assert.equal(citedGoldPage({ cited: ["D2"] }, sources, [5]), true);
  assert.equal(citedGoldPage({ cited: ["D1", "W1"] }, sources, [5]), false);
  assert.equal(citedGoldPage({ cited: [] }, sources, [3]), false);
  assert.equal(citedGoldPage(undefined, sources, [3]), false);
});

test("percentile is nearest-rank and ignores missing values", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([null, undefined], 50), null);
});

test("summarize separates answerable questions and averages retrieval over scored cases", () => {
  const records = [
    { passed: true, answerable_in_mode: true, retrieval_scores: retrievalScores([1], [1], KS), cited_gold_page: true },
    { passed: false, answerable_in_mode: true, retrieval_scores: retrievalScores([2, 9, 1], [1], KS), cited_gold_page: false },
    { passed: false, answerable_in_mode: false },
  ];
  const s = summarize(records, KS);
  assert.equal(s.n, 3);
  assert.equal(s.passed, 1);
  assert.deepEqual(s.answerable, { n: 2, passed: 1 });
  assert.deepEqual(s.retrieval, { n: 2, mrr: 0.667, recall_at: { 1: 0.5, 3: 1, 5: 1 } });
  assert.deepEqual(s.cited_gold_page, { n: 2, yes: 1 });
  assert.equal(summarize([{ passed: true, answerable_in_mode: true }], KS).retrieval, null);
});

test("stage latencies come from the server's meta and skip stages that didn't run", () => {
  const records = [
    { meta: { retrieval: { embed_ms: 10 }, llm: { ms: 100 }, total_ms: 120 } },
    { meta: { retrieval: { embed_ms: 30 }, web: { search_ms: 900 }, llm: { ms: 300 }, total_ms: 1300 } },
    { method: "http-error" },
  ];
  const l = stageLatencies(records);
  assert.deepEqual(l.embed_ms, { n: 2, p50: 10, p95: 30 });
  assert.deepEqual(l.search_ms, { n: 1, p50: 900, p95: 900 });
  assert.equal(l.chroma_ms, undefined);
});
