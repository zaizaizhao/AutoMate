import { MultiServerMCPClient } from "@langchain/mcp-adapters";

// MCP服务器配置定义
export interface MCPServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  transport: "http" | "stdio";
}

// 从环境变量读取MCP服务器配置
function getMCPServerConfigs(): Record<string, MCPServerConfig> {
  return {
    "test-server": {
      url: process.env.MCP_TEST_SERVER_URL || "http://localhost:8080/mcp",
      transport: (process.env.MCP_TEST_SERVER_TRANSPORT as "http" | "stdio") || "http",
    },
    "json-writer": {
      // JSON Writer MCP server for structured data writing
      command: process.env.MCP_JSON_WRITER_COMMAND || "tsx",
      args: process.env.MCP_JSON_WRITER_ARGS
        ? process.env.MCP_JSON_WRITER_ARGS.split(",")
        : ["./src/mcp-servers/json-writer-server.ts"],
      transport: (process.env.MCP_JSON_WRITER_TRANSPORT as "http" | "stdio") || "stdio",
    },
    // "postgresql-hub": {
    //   command: process.env.NODE_ENV === 'production'
    //     ? "dbhub" // 生产环境使用全局安装
    //     : "./node_modules/.bin/dbhub", // 开发环境使用本,
    //   args: [
    //     "--transport",
    //     "stdio",
    //     "--dsn",
    //     process.env.TEST_DATABASE_URL ?? "postgres://postgres:111111@localhost:5432/agents?sslmode=disable"
    //   ],
    //   transport: "stdio",
    // }
    "postgresql-hub": {
      url: "http://localhost:8083/message",
      transport: "http",
    }
  };
}

// 预定义的MCP服务器配置
export const MCP_SERVER_CONFIGS: Record<string, MCPServerConfig> = getMCPServerConfigs();

/**
 * MCP客户端管理器 - 支持按需连接特定的MCP服务器
 */
export class MCPClientManager {
  private clients: Map<string, MultiServerMCPClient> = new Map();
  private serverConfigs: Record<string, MCPServerConfig>;

  constructor(
    serverConfigs: Record<string, MCPServerConfig> = MCP_SERVER_CONFIGS
  ) {
    this.serverConfigs = serverConfigs;
  }

  /**
   * 获取或创建指定服务器的MCP客户端
   */
  private getClient(serverNames: string[]): MultiServerMCPClient {
    const clientKey = serverNames.sort().join(",");

    if (!this.clients.has(clientKey)) {
      const mcpServers: Record<string, MCPServerConfig> = {};

      for (const serverName of serverNames) {
        if (this.serverConfigs[serverName]) {
          mcpServers[serverName] = this.serverConfigs[serverName];
        } else {
          throw new Error(`MCP服务器配置未找到: ${serverName}`);
        }
      }

      const client = new MultiServerMCPClient({ mcpServers } as any);
      this.clients.set(clientKey, client);
    }

    return this.clients.get(clientKey)!;
  }

  /**
   * 获取指定MCP服务器的工具
   */
  async getTools(serverNames: string[]): Promise<any[]> {
    const client = this.getClient(serverNames);
    return await client.getTools();
  }

  /**
   * 获取单个MCP服务器的工具
   */
  async getToolsFromServer(serverName: string): Promise<any[]> {
    return await this.getTools([serverName]);
  }

  /**
   * 关闭所有客户端连接
   */
  async closeAll(): Promise<void> {
    for (const client of this.clients.values()) {
      // 如果客户端有close方法，调用它
      if (typeof (client as any).close === "function") {
        await (client as any).close();
      }
    }
    this.clients.clear();
  }

  /**
   * 获取可用的服务器列表
   */
  getAvailableServers(): string[] {
    return Object.keys(this.serverConfigs);
  }
}

// 全局MCP客户端管理器实例
export const mcpClientManager = new MCPClientManager();

// 向后兼容的函数 - 获取所有工具
export async function getTools(): Promise<any[]> {
  return await mcpClientManager.getTools(["test-server", "json-writer"]);
}

// 专门为weather agent提供的工具获取函数
export async function getTestServerTools(): Promise<any[]> {
  return await mcpClientManager.getToolsFromServer("test-server");
}

// 专门为postgresql-hub agent提供的工具获取函数
export async function getPostgresqlHubTools(): Promise<any[]> {
  return await mcpClientManager.getToolsFromServer("postgresql-hub");
}

// 专门为json-writer agent提供的工具获取函数
export async function getJsonWriterTools(): Promise<any[]> {
  return await mcpClientManager.getToolsFromServer("json-writer");
}

// 自定义组合工具获取函数
export async function getCustomTools(serverNames: string[]): Promise<any[]> {
  return await mcpClientManager.getTools(serverNames);
}
