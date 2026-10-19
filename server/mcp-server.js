// MCP stdio server exposing web search as a tool. Provider-neutral: the
// provider is chosen by SEARCH_PROVIDER (see search/index.js) and results are
// returned in the normalized shape from search/provider.js, both as
// structuredContent and as JSON text for clients that only read text.
//
// Usable by this app (search/mcp-client.js) or any MCP client, e.g.:
//   { "command": "node", "args": ["server/mcp-server.js"], "env": { "SERPAPI_KEY": "..." } }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createSearchProvider, searchWithRetries } from "./search/index.js";

const provider = createSearchProvider();

const server = new McpServer({
  name: "web-search",
  version: "2.0.0",
});

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  position: z.number().nullable(),
  date: z.string().nullable(),
  provider: z.string(),
});

server.registerTool(
  "search_web",
  {
    description:
      "Search the web. Returns up to `num` results, each with title, url, snippet, position and (if known) date.",
    inputSchema: {
      query: z.string().describe("The search query to execute"),
      num: z.number().int().min(1).max(10).optional().describe("Number of results to return (default: 5)"),
    },
    outputSchema: { results: z.array(resultSchema), attempts: z.number().int() },
  },
  // `signal` aborts when the client cancels the request (e.g. its time budget
  // ran out or its user disconnected), which stops the provider call.
  async ({ query, num = 5 }, { signal }) => {
    try {
      const { results, attempts } = await searchWithRetries(provider, query, { num, signal });
      return {
        structuredContent: { results, attempts },
        content: [{ type: "text", text: JSON.stringify({ results, attempts }) }],
      };
    } catch (error) {
      // isError lets the client distinguish a failed search from an empty one.
      return {
        isError: true,
        content: [{ type: "text", text: `Web search failed (${provider.name}): ${error.message}` }],
        _meta: { attempts: error.attempts ?? null },
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`web-search MCP server running on stdio (provider: ${provider.name})`);
}
// Always run the server when this file is executed (spawned as a child process).
main().catch((error) => {
  console.error("Fatal error in MCP server:", error);
  process.exit(1);
});

export default server;
