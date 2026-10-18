import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createChatModel, invokeGuarded } from "./lib/llm.js";
import { PromptTemplate } from "@langchain/core/prompts";
import { usageFrom } from "./lib/usage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
      // Create MCP client
      client = new Client({
        name: "chat-client",
        version: "1.0.0",
      });

      // Get the path to the MCP server
      const serverPath = join(__dirname, "mcp-server.js");

      // Create transport to connect to the MCP server
      transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: {
          ...process.env, // Inherit all environment variables from parent process
        },
      });

      // Connect to the MCP server
      await client.connect(transport);
    } finally {
      isConnecting = false;
      connectionPromise = null;
    }
  })();
  await connectionPromise;
};

const chatMCP = async (query) => {
  const meta = {};

  try {
    // Ensure client is connected (reuse existing connection).
    // connect_ms is ~0 when warm; on the first request it includes spawning mcp-server.js.
    let t = Date.now();
    await ensureConnected();
    meta.connect_ms = Date.now() - t;

    // Always perform web search
    t = Date.now();
    const toolResult = await client.callTool({
      name: "search_web",
      arguments: {
        query: query,
        num: 5,
      },
    });

    // search_ms covers the MCP round-trip plus the SerpAPI call
    meta.search_ms = Date.now() - t;

    let searchResults = "";

    if (toolResult.content && toolResult.content.length > 0) {
      searchResults = toolResult.content[0].text;
    }
    meta.search_payload_chars = searchResults.length;

    // Use the LLM to answer the question based on search results
    const model = createChatModel();

    const answerTemplate = `Summarize the search result.

Search Results:
{searchResults}

Helpful Answer:`;

    const prompt = PromptTemplate.fromTemplate(answerTemplate);
    const formattedPrompt = await prompt.format({
      searchResults: searchResults || "No search results available",
    });

    t = Date.now();
    const { message: response, check } = await invokeGuarded(model, formattedPrompt);
    meta.llm_ms = Date.now() - t;
    meta.usage = usageFrom(response);
    meta.check = check;
    const finalAnswer = response.content;

    return { text: finalAnswer, meta };
  } catch (error) {
    // If connection error, reset client to allow reconnection on next request
    if (client) {
      try {
        await client.close();
      } catch (e) {
        // Ignore cleanup errors
      }
      client = null;
      transport = null;
    }

    throw error;
  }
};

export default chatMCP;
