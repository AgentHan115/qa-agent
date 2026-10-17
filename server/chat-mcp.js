import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";

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
  const apiKey = process.env.OPENAI_API_KEY;

  try {
    // Ensure client is connected (reuse existing connection)
    await ensureConnected();

    // Always perform web search
    const toolResult = await client.callTool({
      name: "search_web",
      arguments: {
        query: query,
        num: 5,
      },
    });

    let searchResults = "";

    if (toolResult.content && toolResult.content.length > 0) {
      searchResults = toolResult.content[0].text;
    }

    // Use the LLM to answer the question based on search results
    const model = new ChatOpenAI({
      model: process.env.OPENAI_MODEL || "gpt-4o",
      apiKey,
    });

    const answerTemplate = `Summarize the search result.

Search Results:
{searchResults}

Helpful Answer:`;

    const prompt = PromptTemplate.fromTemplate(answerTemplate);
    const formattedPrompt = await prompt.format({
      searchResults: searchResults || "No search results available",
    });

    const response = await model.invoke(formattedPrompt);
    const finalAnswer = response.content;

    return { text: finalAnswer };
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
