// SerpAPI (Google) adapter. Only organic results are used: the raw response
// also carries search metadata, related questions, knowledge graph, etc., which
// made the old prompt ~30k tokens of JSON for 5 results.

import { getJson } from "serpapi";
import { SearchProviderError, normalizeResult } from "./provider.js";

export const mapSerpApiResponse = (response) => {
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
    .map((r) => normalizeResult({ title: r.title, url: r.link, snippet: r.snippet, position: r.position, date: r.date }, "serpapi"))
    .filter(Boolean);
};

export const createSerpApiProvider = ({ apiKey = process.env.SERPAPI_KEY } = {}) => ({
  name: "serpapi",
  async search(query, { num = 5 } = {}) {
    if (!apiKey) throw new SearchProviderError("SERPAPI_KEY is not set", { provider: "serpapi" });
    let response;
    try {
      response = await getJson({ engine: "google", q: query, num, api_key: apiKey });
    } catch (err) {
      throw new SearchProviderError(`SerpAPI request failed: ${err.message}`, { provider: "serpapi", cause: err });
    }
    return mapSerpApiResponse(response).slice(0, num);
  },
});
