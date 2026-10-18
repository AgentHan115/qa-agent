// Search entry point used by the answer pipeline.
//
//   SEARCH_PROVIDER = serpapi | fake          which API answers the query
//   SEARCH_TRANSPORT = mcp | direct           how the server reaches it:
//     mcp    — through the MCP stdio server (mcp-server.js), the same tool an
//              external agent would call (default)
//     direct — in-process call to the provider (no child process)
//   SEARCH_NUM_RESULTS = 5, SEARCH_TIMEOUT_MS = 8000

import { createSerpApiProvider } from "./serpapi.js";
import { createFakeProvider } from "./fake.js";
import { searchViaMcp } from "./mcp-client.js";

const PROVIDERS = {
  serpapi: createSerpApiProvider,
  fake: createFakeProvider,
};

export const searchConfig = () => ({
  provider: process.env.SEARCH_PROVIDER || "serpapi",
  transport: process.env.SEARCH_TRANSPORT || "mcp",
  num: parseInt(process.env.SEARCH_NUM_RESULTS || "5", 10),
  timeoutMs: parseInt(process.env.SEARCH_TIMEOUT_MS || "8000", 10),
});

export const createSearchProvider = (name = searchConfig().provider) => {
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`Unknown SEARCH_PROVIDER "${name}" (expected: ${Object.keys(PROVIDERS).join(", ")})`);
  return factory();
};

let directProvider = null;

// Resolves to normalized results; throws on provider failure.
export const searchWeb = async (query) => {
  const { transport, num } = searchConfig();
  if (transport === "direct") {
    directProvider ??= createSearchProvider();
    return directProvider.search(query, { num });
  }
  return searchViaMcp(query, { num });
};
