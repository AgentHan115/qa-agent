// Keyword retrieval (Okapi BM25) and rank fusion, for retrieval experiments in
// eval/retrieval-sweep.js. In-memory over a document's chunks; not used by the
// pipeline.

// Lowercase alphanumeric runs, keeping decimals together ("86.4"), so exact
// values and names like "HumanEval" or "Codeforces" match. Table text that
// PDF extraction glued together ("86.4%70.0%") still splits at the "%".
const TOKEN = /[a-z0-9]+(?:\.[0-9]+)?/g;

// Question words and function words that would otherwise match everywhere
// ("how did ..." matching "DID"); IDF alone doesn't remove all of them.
const STOPWORDS = new Set(
  "a an and are as at be by did do does for from had has have how in is it its of on or that the their this to was were what when where which who why with according report".split(" ")
);

export const tokenize = (text) => (text.toLowerCase().match(TOKEN) ?? []).filter((t) => !STOPWORDS.has(t));

// Returns search(query, k) -> [{ index, score }], best first.
export const createBm25 = (texts, { k1 = 1.2, b = 0.75 } = {}) => {
  const docs = texts.map(tokenize);
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1);
  const termFreqs = docs.map((d) => d.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map()));
  const docFreq = new Map();
  for (const tf of termFreqs) for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const idf = (t) => {
    const n = docFreq.get(t) ?? 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };

  return (query, k) => {
    const terms = [...new Set(tokenize(query))];
    const scored = termFreqs.map((tf, index) => {
      let score = 0;
      for (const t of terms) {
        const f = tf.get(t);
        if (!f) continue;
        score += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[index].length) / avgLen)));
      }
      return { index, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((x, y) => y.score - x.score || x.index - y.index)
      .slice(0, k);
  };
};

// Reciprocal rank fusion of ranked lists of ids: score = sum 1/(c + rank).
// Uses only ranks, so a vector distance and a BM25 score never need to be
// comparable. c = 60 is the usual constant.
export const reciprocalRankFusion = (lists, { c = 60 } = {}) => {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (c + i + 1)));
  }
  return [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
};

// Alternates between lists (first list first), skipping ids already taken.
export const interleave = (lists) => {
  const out = [];
  const seen = new Set();
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      if (i < l.length && !seen.has(l[i])) {
        seen.add(l[i]);
        out.push(l[i]);
      }
    }
  }
  return out;
};
