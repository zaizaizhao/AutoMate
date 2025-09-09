/**
 * JSON Writer MCP Server
 * Provides tools for writing structured data to JSON files
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";

interface WriteJsonToolArgs {
  filePath: string;
  data: any;
  mode: "append" | "overwrite";
  createDirectories?: boolean;
}

class JsonWriterServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: "json-writer-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "writeJsonFile",
            description:
              "Write structured data to a JSON file with support for append and overwrite modes",
            inputSchema: {
              type: "object",
              properties: {
                filePath: {
                  type: "string",
                  description: "Path to the JSON file to write to",
                },
                data: {
                  type: "object",
                  description: "The structured data to write to the file",
                },
                mode: {
                  type: "string",
                  enum: ["append", "overwrite"],
                  description:
                    "Write mode: append to existing data or overwrite the file",
                },
                createDirectories: {
                  type: "boolean",
                  description:
                    "Whether to create parent directories if they do not exist",
                  default: true,
                },
              },
              required: ["filePath", "data", "mode"],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "writeJsonFile") {
        return await this.handleWriteJsonFile(
          args as unknown as WriteJsonToolArgs
        );
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }

  private async handleWriteJsonFile(args: WriteJsonToolArgs) {
    try {
      const { filePath, data, mode, createDirectories = true } = args;

      // Validate input data
      if (!filePath) {
        throw new Error("filePath is required");
      }

      if (data === undefined || data === null) {
        throw new Error("data is required");
      }

      // Handle file path resolution safely
      // If path starts with '/', treat it as relative to current working directory
      // to avoid writing to system root directory
      let resolvedPath = filePath;
      if (filePath.startsWith("/")) {
        resolvedPath = filePath.substring(1); // Remove leading slash
      }

      // Ensure the file path is absolute, relative to current working directory
      const absolutePath = path.resolve(process.cwd(), resolvedPath);

      // Create directories if needed
      if (createDirectories) {
        const dir = path.dirname(absolutePath);
        await fs.mkdir(dir, { recursive: true });
      }

      let finalData = data;

      if (mode === "append") {
        try {
          // Try to read existing file
          const existingContent = await fs.readFile(absolutePath, "utf-8");
          const existingData = JSON.parse(existingContent);

          // Handle different data structures for appending
          if (Array.isArray(existingData) && Array.isArray(data)) {
            finalData = [...existingData, ...data];
          } else if (
            typeof existingData === "object" &&
            typeof data === "object"
          ) {
            finalData = { ...existingData, ...data };
          } else {
            // If structures don't match, create an array
            finalData = [existingData, data];
          }
        } catch (error) {
          // File doesn't exist or is invalid JSON, use new data
          finalData = data;
        }
      }

      // Write the data to file
      const jsonString = JSON.stringify(finalData, null, 2);
      await fs.writeFile(absolutePath, jsonString, "utf-8");

      return {
        content: [
          {
            type: "text",
            text: `Successfully wrote data to ${absolutePath} in ${mode} mode. File size: ${jsonString.length} characters.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error writing JSON file: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("JSON Writer MCP server running on stdio");
  }
}

const server = new JsonWriterServer();
server.run().catch(console.error);
