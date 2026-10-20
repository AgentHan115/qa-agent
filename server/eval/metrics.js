// Pure scoring helpers for scripts/eval.js, kept separate so they can be tested
// without a running server.
//
// Gold pages are alternatives: any one of them is enough for retrieval credit
// (see the dataset's `fields.gold_pages`). So "recall@k" here is hit@k: 1 if
// any of the top-k retrieved chunks is on a gold page, else 0.

// Does the question's evidence live in the document, and is the document
// searched in this mode? Retrieval metrics only apply when both hold.
export const retrievalApplies = (q, mode) => mode !== "web" && q.gold_pages?.length > 0;

// Can the mode's sources answer the question at all?
export const answerableInMode = (q, mode) =>
  mode === "hybrid" || (mode === "docs" && q.needs === "doc") || (mode === "web" && q.needs === "web");

// 1-based rank of the first chunk on a gold page, or null.
export const firstGoldRank = (hitPages, goldPages) => {
  const i = hitPages.findIndex((p) => goldPages.includes(p));
  return i === -1 ? null : i + 1;
};

export const retrievalScores = (hitPages, goldPages, ks) => {
  const rank = firstGoldRank(hitPages, goldPages);
  return {
    first_gold_rank: rank,
    reciprocal_rank: rank ? 1 / rank : 0,
    hit_at: Object.fromEntries(ks.map((k) => [k, rank !== null && rank <= k ? 1 : 0])),
  };
};

// Whether the answer cited a document source on a gold page.
export const citedGoldPage = (citations, sources, goldPages) => {
  const cited = new Set(citations?.cited ?? []);
  return sources.some((s) => s.type === "document" && cited.has(s.id) && goldPages.includes(s.page));
};

export const percentile = (values, p) => {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  // Nearest-rank: the smallest value with at least p% of values at or below it.
  return v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)];
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

// Aggregates one group of case records (all cases, or one category).
export const summarize = (records, ks) => {
  const graded = records.filter((r) => r.passed !== undefined);
  const answerable = graded.filter((r) => r.answerable_in_mode);
  const retrieval = records.filter((r) => r.retrieval_scores);
  const goldCiteable = records.filter((r) => r.cited_gold_page !== undefined);
  return {
    n: records.length,
    passed: graded.filter((r) => r.passed).length,
    answerable: { n: answerable.length, passed: answerable.filter((r) => r.passed).length },
    retrieval: retrieval.length
      ? {
          n: retrieval.length,
          mrr: round(mean(retrieval.map((r) => r.retrieval_scores.reciprocal_rank))),
          recall_at: Object.fromEntries(ks.map((k) => [k, round(mean(retrieval.map((r) => r.retrieval_scores.hit_at[k])))])),
        }
      : null,
    cited_gold_page: goldCiteable.length
      ? { n: goldCiteable.length, yes: goldCiteable.filter((r) => r.cited_gold_page).length }
      : null,
  };
};

// P50/P95 for each stage that appears in the server's `meta`.
const STAGES = {
  embed_ms: (m) => m?.retrieval?.embed_ms,
  chroma_ms: (m) => m?.retrieval?.chroma_ms,
  search_ms: (m) => m?.web?.search_ms,
  prepare_ms: (m) => m?.prepare_ms,
  llm_ms: (m) => m?.llm?.ms,
  total_ms: (m) => m?.total_ms,
};

export const stageLatencies = (records) =>
  Object.fromEntries(
    Object.entries(STAGES).flatMap(([name, get]) => {
      const values = records.map((r) => get(r.meta)).filter((x) => typeof x === "number");
      return values.length ? [[name, { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) }]] : [];
    })
  );
