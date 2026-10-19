// Calls the search_web tool on the MCP stdio server (mcp-server.js), keeping
// one child process alive across requests.
//
// Connection handling: concurrent callers share one in-flight connection
// attempt, and the cached client is published only after connect() succeeds.
// It is dropped only when the transport closes (child exited, pipe broke) —
// never because a single tool call failed or was cancelled, since other
// requests may be using the same connection.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { SearchProviderError } from "./provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let client = null; // connected client, or null
let connecting = null; // in-flight connection attempt, shared by concurrent callers
export const stats = { connects: 0 }; // for tests and diagnostics

const connect = async () => {
  const c = new Client({ name: "chat-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(__dirname, "..", "mcp-server.js")],
    env: { ...process.env }, // provider selection and keys come from the parent env
    stderr: "inherit",
  });
  c.onclose = () => {
    if (client === c) client = null;
  };
  stats.connects++;
  await c.connect(transport);
  client = c;
  return c;
};

const getClient = () => {
  if (client) return Promise.resolve(client);
  connecting ??= connect().finally(() => {
    connecting = null;
  });
  return connecting;
};

// Shut the child process down (tests, graceful exit).
export const closeMcpClient = async () => {
  const c = client;
  client = null;
  await c?.close();
};

// Resolves { results, attempts }; throws SearchProviderError when the tool
// reports a failure, or the abort reason when `signal` fires (the SDK then
// sends a cancellation to the server, which stops the provider call).
export const searchViaMcp = async (query, { num = 5, signal } = {}) => {
  const c = await getClient();
  const toolResult = await c.callTool({ name: "search_web", arguments: { query, num } }, undefined, { signal });

  const text = toolResult.content?.[0]?.text ?? "";
  if (toolResult.isError) {
    const err = new SearchProviderError(text || "search_web failed");
    err.attempts = toolResult._meta?.attempts ?? undefined;
    throw err;
  }
  const payload = toolResult.structuredContent ?? JSON.parse(text);
  if (!Array.isArray(payload?.results)) throw new SearchProviderError("search_web returned no results array");
  return { results: payload.results, attempts: payload.attempts ?? null };
};
