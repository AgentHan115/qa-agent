// The web-search provider contract.
//
// A provider is { name, search(query, { num }) } and resolves to an array of
// normalized results. Everything downstream (MCP tool, context builder,
// citations, UI) only sees this shape, so swapping SerpAPI for another search
// API means writing one adapter that maps its response here.
//
//   { title: string, url: string, snippet: string, position: number,
//     date: string | null, provider: string }
//
// Providers resolve [] for "no results" and throw SearchProviderError for
// failures (bad response shape, HTTP errors), so callers can tell them apart.

export class SearchProviderError extends Error {
  constructor(message, { provider, cause } = {}) {
    super(message);
    this.name = "SearchProviderError";
    this.provider = provider;
    this.cause = cause;
  }
}

const MAX_TITLE_CHARS = 200;
const MAX_SNIPPET_CHARS = 500;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Shared field validation/cleanup for adapters. Returns null for unusable items.
export const normalizeResult = ({ title, url, snippet, position, date }, provider) => {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  const cleanSnippet = typeof snippet === "string" ? snippet.replace(/\s+/g, " ").trim() : "";
  if (!cleanTitle && !cleanSnippet) return null;
  return {
    title: clip(cleanTitle || url, MAX_TITLE_CHARS),
    url,
    snippet: clip(cleanSnippet, MAX_SNIPPET_CHARS),
    position: Number.isFinite(position) ? position : null,
    date: typeof date === "string" && date ? date : null,
    provider,
  };
};
