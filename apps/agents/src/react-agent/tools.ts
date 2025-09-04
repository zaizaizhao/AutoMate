/**
 * This file defines the tools available to the ReAct agent.
 * Tools are functions that the agent can use to interact with external systems or perform specific tasks.
 */

import { MultiServerMCPClient } from "@langchain/mcp-adapters";


const client = new MultiServerMCPClient({
  mcpServers: {
    "weather": {
      // Ensure your start your weather server on port 8000
      url: "http://localhost:8080/mcp",
      transport: "http",
    },
    "json-writer": {
      // JSON Writer MCP server for structured data writing
      command: "tsx",
      args: ["./src/mcp-servers/json-writer-server.ts"],
      transport: "stdio",
    }
  }
})

/**
 * Get tools from MCP client asynchronously
 */
export async function getTestServerToolsgetTools() {
  return await client.getTools();
}

/**
 * Export an array of all available tools
 * Add new tools to this array to make them available to the agent
 *
 * Note: You can create custom tools by implementing the Tool interface from @langchain/core/tools
 * and add them to this array.
 * See https://js.langchain.com/docs/how_to/custom_tools/#tool-function for more information.
 */
// export const TOOLS = [tools];
