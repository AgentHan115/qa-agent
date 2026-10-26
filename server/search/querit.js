// Querit Search API adapter (https://www.querit.ai/en/docs), calling
// POST /v1/search with fetch so we get HTTP status codes (for retry decisions)
// and cancellation, as in serpapi.js. Endpoint, bearer auth, request body and
// response shape follow the official SDK (github.com/querit-ai/querit-python):
//
//   request  { query, count }
//   response { error_code (200 = ok), error_msg, search_id, results: { result: [item] } }
//   item     { url, title, snippet, page_age, page_time, ... }
//
// The API key travels in the Authorization header, never in the URL, and is
// never included in errors or logs.

import { SearchProviderError, normalizeResult } from "./provider.js";

const ENDPOINT = "https://api.querit.ai/v1/search";

// Some snippets carry raw HTML (e.g. Wikipedia infobox tables). Tags become plain
// text with table cells joined by " | "; the content itself is kept unchanged.
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
export const stripHtml = (text) =>
  typeof text !== "string"
    ? text
    : text
        .replace(/<\/(td|th|tr|li|p|div|table)>|<br\s*\/?>/gi, " | ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
        .replace(/\s+/g, " ")
        .replace(/(\s*\|\s*)+/g, " | ")
        .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
        .trim();

// Success bodies carry error_code 200 (observed 2026-10-25; the SDK doesn't check it).
// Any other code in an HTTP 200 body is treated as a failure.
const QUERIT_OK_CODES = new Set([undefined, null, 0, 200]);

export const mapQueritResponse = (response) => {
  if (!response || typeof response !== "object") {
    throw new SearchProviderError("Querit returned a non-object response", { provider: "querit" });
  }
  if (!QUERIT_OK_CODES.has(response.error_code)) {
    const message = typeof response.error_msg === "string" ? response.error_msg : "";
    throw new SearchProviderError(`Querit error ${response.error_code}${message ? `: ${message}` : ""}`, {
      provider: "querit",
    });
  }
  const items = response.results?.result ?? [];
  if (!Array.isArray(items)) {
    throw new SearchProviderError("Querit results.result is not an array", { provider: "querit" });
  }
  return items
    .map((r, i) =>
      normalizeResult(
        { title: stripHtml(r?.title), url: r?.url, snippet: stripHtml(r?.snippet), position: i + 1, date: r?.page_age },
        "querit"
      )
    )
    .filter(Boolean);
};

// HTTP status -> retryable? Rate limits and server errors can pass; bad
// requests, bad keys and forbidden access won't fix themselves.
export const classifyQueritHttpError = (status) => status === 429 || status >= 500;

export const createQueritProvider = ({
  apiKey = process.env.QUERIT_API_KEY,
  attemptTimeoutMs = parseInt(process.env.SEARCH_ATTEMPT_TIMEOUT_MS || "3000", 10),
  fetchImpl = fetch,
} = {}) => ({
  name: "querit",
  async search(query, { num = 5, signal } = {}) {
    if (!apiKey) throw new SearchProviderError("QUERIT_API_KEY is not set", { provider: "querit" });

    const attemptSignal = AbortSignal.any([AbortSignal.timeout(attemptTimeoutMs), ...(signal ? [signal] : [])]);
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, count: num }),
        signal: attemptSignal,
      });
    } catch (err) {
      if (signal?.aborted) throw err; // caller cancelled: not a provider failure
      const timedOut = err.name === "TimeoutError";
      throw new SearchProviderError(
        timedOut ? `Querit attempt timed out after ${attemptTimeoutMs}ms` : `Querit request failed: ${err.message}`,
        { provider: "querit", retryable: true, cause: err }
      );
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      throw new SearchProviderError(`Querit returned non-JSON (HTTP ${res.status})`, {
        provider: "querit",
        status: res.status,
        retryable: res.status >= 500,
        cause: err,
      });
    }
    if (!res.ok) {
      const message = typeof body?.error_msg === "string" ? body.error_msg : "";
      throw new SearchProviderError(`Querit HTTP ${res.status}${message ? `: ${message}` : ""}`, {
        provider: "querit",
        status: res.status,
        retryable: classifyQueritHttpError(res.status),
      });
    }
    return mapQueritResponse(body).slice(0, num);
  },
});
