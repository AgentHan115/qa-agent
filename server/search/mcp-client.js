// Calls the search_web tool on the MCP stdio server (mcp-server.js), keeping
// one child process alive across requests.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { SearchProviderError } from "./provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Reusable MCP client instance
let client = null;
let transport = null;
let isConnecting = false;
let connectionPromise = null;

// Initialize the MCP client connection (lazy initialization)
const ensureConnected = async () => {
  // If already connected, return
  if (client && transport) {
    return;
  }

  // If connection is in progress, wait for it
  if (isConnecting && connectionPromise) {
    await connectionPromise;
    return;
  }

  // Start new connection
  isConnecting = true;
  connectionPromise = (async () => {
    try {
      client = new Client({ name: "chat-client", version: "1.0.0" });
      transport = new StdioClientTransport({
        command: "node",
        args: [join(__dirname, "..", "mcp-server.js")],
        env: { ...process.env }, // provider selection and keys come from the parent env
      });
      await client.connect(transport);
    } finally {
      isConnecting = false;
      connectionPromise = null;
    }
  })();
  await connectionPromise;
};

const resetConnection = async () => {
  if (!client) return;
  try {
    await client.close();
  } catch {
    // Ignore cleanup errors
  }
  client = null;
  transport = null;
};

// Resolves to normalized results (search/provider.js); throws SearchProviderError
// when the tool reports a failure.
export const searchViaMcp = async (query, { num = 5 } = {}) => {
  let toolResult;
  try {
    await ensureConnected();
    toolResult = await client.callTool({ name: "search_web", arguments: { query, num } });
  } catch (err) {
    // Transport-level failure: drop the connection so the next call reconnects.
    await resetConnection();
    throw err;
  }

  const text = toolResult.content?.[0]?.text ?? "";
  if (toolResult.isError) throw new SearchProviderError(text || "search_web failed");
  const results = toolResult.structuredContent?.results ?? JSON.parse(text).results;
  if (!Array.isArray(results)) throw new SearchProviderError("search_web returned no results array");
  return results;
};
