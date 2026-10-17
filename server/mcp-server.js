import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getJson } from "serpapi";

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Create MCP server instance
const server = new McpServer({
  name: "serpapi-search",
  version: "1.0.0",
});

// Register the search tool
server.registerTool(
  "search_web",
  {
    description:
      "Search the web using SerpAPI. Returns search results including organic results, snippets, and related information.",
    inputSchema: {
      query: z.string().describe("The search query to execute"),
      num: z
        .number()
        .optional()
        .describe("Number of results to return (default: 10)"),
    },
  },
  async ({ query, num = 10 }) => {
    try {
      const results = await getJson({
        engine: "google",
        q: query,
        num: num,
        api_key: SERPAPI_KEY,
      });

      // Return all results as plain text
      const fullResults = JSON.stringify(results);

      return {
        content: [
          {
            type: "text",
            text: fullResults,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error performing web search: ${error.message}`,
          },
        ],
      };
    }
  }
);

// Main function to run the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SerpAPI MCP Server running on stdio");
}
// Always run the server when this file is executed
// This is needed when spawned as a child process
main().catch((error) => {
  console.error("Fatal error in MCP server:", error);
  process.exit(1);
});

export default server;
