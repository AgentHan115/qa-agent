// Search entry point used by the answer pipeline.
//
//   SEARCH_PROVIDER = serpapi | querit | fake which API answers the query
//   SEARCH_TRANSPORT = mcp | direct           how the server reaches it:
//     mcp    — through the MCP stdio server (mcp-server.js), the same tool an
//              external agent would call (default)
//     direct — in-process call to the provider (no child process)
//   SEARCH_NUM_RESULTS = 5
//   SEARCH_TIMEOUT_MS = 8000          overall budget, enforced by the pipeline
//   SEARCH_ATTEMPT_TIMEOUT_MS = 3000  per attempt (provider-specific)
//   SEARCH_RETRIES = 2                retries of retryable failures, within the budget

import { createSerpApiProvider } from "./serpapi.js";
import { createQueritProvider } from "./querit.js";
import { createFakeProvider } from "./fake.js";
import { searchViaMcp } from "./mcp-client.js";
import { withRetries } from "./retry.js";

const PROVIDERS = {
  serpapi: createSerpApiProvider,
  querit: createQueritProvider,
  fake: createFakeProvider,
};

export const searchConfig = () => ({
  provider: process.env.SEARCH_PROVIDER || "serpapi",
  transport: process.env.SEARCH_TRANSPORT || "mcp",
  num: parseInt(process.env.SEARCH_NUM_RESULTS || "5", 10),
  timeoutMs: parseInt(process.env.SEARCH_TIMEOUT_MS || "8000", 10),
  attemptTimeoutMs: parseInt(process.env.SEARCH_ATTEMPT_TIMEOUT_MS || "3000", 10),
  retries: parseInt(process.env.SEARCH_RETRIES || "2", 10),
});

export const createSearchProvider = (name = searchConfig().provider) => {
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`Unknown SEARCH_PROVIDER "${name}" (expected: ${Object.keys(PROVIDERS).join(", ")})`);
  return factory();
};

// Runs a provider search with bounded retries. Resolves { results, attempts }.
// Used in-process (direct transport) and inside the MCP server.
export const searchWithRetries = async (provider, query, { num, signal, retries = searchConfig().retries } = {}) => {
  let attempts = 0;
  const results = await withRetries(
    () => {
      attempts++;
      return provider.search(query, { num, signal });
    },
    {
      retries,
      signal,
      onRetry: (err, { attempt, delay }) =>
        console.warn(`[search] ${provider.name} attempt ${attempt} failed (${err.message}); retrying in ${delay}ms`),
    }
  );
  return { results, attempts };
};

let directProvider = null;

// Resolves { results, attempts }; throws on failure or when `signal` aborts.
export const searchWeb = async (query, { signal } = {}) => {
  const { transport, num } = searchConfig();
  if (transport === "direct") {
    directProvider ??= createSearchProvider();
    return searchWithRetries(directProvider, query, { num, signal });
  }
  return searchViaMcp(query, { num, signal });
};
