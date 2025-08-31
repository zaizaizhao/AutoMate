
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
export async function getTools() {
  return await client.getTools();
}