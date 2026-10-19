// Deterministic offline provider for tests, development and load tests.
// Returns canned results with configurable latency and failure modes, so the
// pipeline can be exercised without spending search quota.
//
// Env (when selected via SEARCH_PROVIDER=fake):
//   FAKE_SEARCH_LATENCY_MS=200
//   FAKE_SEARCH_MODE=ok | empty | error | transient | hang
//     error     — permanent failure (not retried)
//     transient — retryable failure (e.g. a 503) on every attempt
//     hang      — never resolves (until the caller's signal aborts)

import { SearchProviderError, normalizeResult } from "./provider.js";
import { sleep } from "./retry.js";

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
  calls: 0,
  async search(query, { num = 5, signal } = {}) {
    this.calls++;
    await sleep(mode === "hang" ? 2 ** 31 - 1 : latencyMs, signal);
    if (mode === "error") throw new SearchProviderError("fake provider failure", { provider: "fake", status: 401 });
    if (mode === "transient") {
      throw new SearchProviderError("fake provider unavailable", { provider: "fake", status: 503, retryable: true });
    }
    if (mode === "empty") return [];
    return (results ?? cannedResults(query)).slice(0, num);
  },
});
