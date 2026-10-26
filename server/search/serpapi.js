// SerpAPI (Google) adapter, calling the JSON endpoint directly with fetch so
// we get HTTP status codes (for retry decisions) and cancellation. The
// `serpapi` npm client rejects non-200 responses with the raw body and has no
// per-request abort, so it can't tell a rate limit from a bad key.
//
// Only organic results are used: the raw response also carries search metadata,
// related questions, knowledge graph, etc., which made the old prompt ~30k
// tokens of JSON for 5 results.
//
// The API key travels in the query string (SerpAPI's API), so the request URL
// is never included in errors or logs.

import { SearchProviderError, normalizeResult, snippetCharsFromEnv } from "./provider.js";

const ENDPOINT = "https://serpapi.com/search.json";

export const mapSerpApiResponse = (response, { maxSnippetChars } = {}) => {
  if (!response || typeof response !== "object") {
    throw new SearchProviderError("SerpAPI returned a non-object response", { provider: "serpapi" });
  }
  if (response.error) {
    // SerpAPI reports "no results" as an error string; that's an empty result, not a failure.
    if (/hasn't returned any results/i.test(response.error)) return [];
    throw new SearchProviderError(`SerpAPI error: ${response.error}`, { provider: "serpapi" });
  }
  const organic = response.organic_results ?? [];
  if (!Array.isArray(organic)) {
    throw new SearchProviderError("SerpAPI organic_results is not an array", { provider: "serpapi" });
  }
  return organic
    .map((r) =>
      normalizeResult({ title: r.title, url: r.link, snippet: r.snippet, position: r.position, date: r.date }, "serpapi", { maxSnippetChars })
    )
    .filter(Boolean);
};

// HTTP status -> retryable? 429 is a throughput limit unless the monthly quota
// is used up (then retrying can't help until it resets).
export const classifyHttpError = (status, message = "") => {
  if (status === 429) return !/run out of searches/i.test(message);
  return status >= 500;
};

export const createSerpApiProvider = ({
  apiKey = process.env.SERPAPI_KEY,
  attemptTimeoutMs = parseInt(process.env.SEARCH_ATTEMPT_TIMEOUT_MS || "3000", 10),
  snippetChars = snippetCharsFromEnv(),
  fetchImpl = fetch,
} = {}) => ({
  name: "serpapi",
  async search(query, { num = 5, signal } = {}) {
    if (!apiKey) throw new SearchProviderError("SERPAPI_KEY is not set", { provider: "serpapi" });

    const url = `${ENDPOINT}?${new URLSearchParams({ engine: "google", q: query, num: String(num), api_key: apiKey })}`;
    const attemptSignal = AbortSignal.any([AbortSignal.timeout(attemptTimeoutMs), ...(signal ? [signal] : [])]);

    let res;
    try {
      res = await fetchImpl(url, { signal: attemptSignal });
    } catch (err) {
      if (signal?.aborted) throw err; // caller cancelled: not a provider failure
      const timedOut = err.name === "TimeoutError";
      throw new SearchProviderError(
        timedOut ? `SerpAPI attempt timed out after ${attemptTimeoutMs}ms` : `SerpAPI request failed: ${err.message}`,
        { provider: "serpapi", retryable: true, cause: err }
      );
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      throw new SearchProviderError(`SerpAPI returned non-JSON (HTTP ${res.status})`, {
        provider: "serpapi",
        status: res.status,
        retryable: res.status >= 500,
        cause: err,
      });
    }
    if (!res.ok) {
      const message = typeof body?.error === "string" ? body.error : "";
      throw new SearchProviderError(`SerpAPI HTTP ${res.status}${message ? `: ${message}` : ""}`, {
        provider: "serpapi",
        status: res.status,
        retryable: classifyHttpError(res.status, message),
      });
    }
    return mapSerpApiResponse(body, { maxSnippetChars: snippetChars }).slice(0, num);
  },
});
