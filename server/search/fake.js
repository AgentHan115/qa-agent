// Deterministic offline provider for tests, development and load tests.
// Returns canned results with configurable latency and failure modes, so the
// pipeline can be exercised without spending search quota.
//
// Env (when selected via SEARCH_PROVIDER=fake):
//   FAKE_SEARCH_LATENCY_MS=200
//   FAKE_SEARCH_MODE=ok | empty | error | hang

import { SearchProviderError, normalizeResult } from "./provider.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cannedResults = (query) =>
  [1, 2, 3, 4, 5].map((i) =>
    normalizeResult(
      {
        title: `Result ${i} for "${query}"`,
        url: `https://example.com/search/${i}?q=${encodeURIComponent(query)}`,
        snippet: `Canned snippet ${i} about ${query}. This text comes from the fake search provider.`,
        position: i,
      },
      "fake"
    )
  );

export const createFakeProvider = ({
  latencyMs = parseInt(process.env.FAKE_SEARCH_LATENCY_MS || "200", 10),
  mode = process.env.FAKE_SEARCH_MODE || "ok",
  results,
} = {}) => ({
  name: "fake",
  async search(query, { num = 5 } = {}) {
    if (mode === "hang") return new Promise(() => {});
    await sleep(latencyMs);
    if (mode === "error") throw new SearchProviderError("fake provider failure", { provider: "fake" });
    if (mode === "empty") return [];
    return (results ?? cannedResults(query)).slice(0, num);
  },
});
