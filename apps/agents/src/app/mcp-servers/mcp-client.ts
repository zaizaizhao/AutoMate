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
    // "sql-hub": {
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
    "sql-hub": {
      url: "http://localhost:8083/message",
      transport: "http",
    }
  };
}

// 预定义的MCP服务器配置
export const MCP_SERVER_CONFIGS: Record<string, MCPServerConfig> = getMCPServerConfigs();

/**
 * MCP工具调用监控器
 */
class MCPCallMonitor {
  private static instance: MCPCallMonitor;
  private callHistory: Array<{
    timestamp: Date;
    serverName: string;
    toolName: string;
    parameters: any;
    result?: any;
    error?: any;
    duration?: number;
  }> = [];
  private listeners: Array<(call: any) => void> = [];

  static getInstance(): MCPCallMonitor {
    if (!MCPCallMonitor.instance) {
      MCPCallMonitor.instance = new MCPCallMonitor();
    }
    return MCPCallMonitor.instance;
  }

  /**
   * 记录MCP工具调用
   */
  logCall(serverName: string, toolName: string, parameters: any, result?: any, error?: any, duration?: number) {
    const call = {
      timestamp: new Date(),
      serverName,
      toolName,
      parameters,
      result,
      error,
      duration
    };
    
    this.callHistory.push(call);
    console.log(`[MCP-Monitor] ${serverName}/${toolName} called:`, {
      parameters,
      duration: duration ? `${duration}ms` : 'unknown',
      success: !error
    });
    
    // 通知监听器
    this.listeners.forEach(listener => {
      try {
        listener(call);
      } catch (e) {
        console.error('[MCP-Monitor] Listener error:', e);
      }
    });
  }

  /**
   * 添加调用监听器
   */
  addListener(listener: (call: any) => void) {
    this.listeners.push(listener);
  }

  /**
   * 移除调用监听器
   */
  removeListener(listener: (call: any) => void) {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * 获取调用历史
   */
  getCallHistory(serverName?: string, toolName?: string): any[] {
    let history = this.callHistory;
    
    if (serverName) {
      history = history.filter(call => call.serverName === serverName);
    }
    
    if (toolName) {
      history = history.filter(call => call.toolName === toolName);
    }
    
    return history;
  }

  /**
   * 获取最近的调用
   */
  getRecentCalls(count: number = 10): any[] {
    return this.callHistory.slice(-count);
  }

  /**
   * 清除调用历史
   */
  clearHistory() {
    this.callHistory = [];
  }

  /**
   * 检查特定工具是否被调用过
   */
  hasBeenCalled(serverName: string, toolName?: string): boolean {
    return this.callHistory.some(call => {
      if (call.serverName !== serverName) return false;
      if (toolName && call.toolName !== toolName) return false;
      return true;
    });
  }

  /**
   * 获取调用统计
   */
  getCallStats(serverName?: string): any {
    let calls = this.callHistory;
    if (serverName) {
      calls = calls.filter(call => call.serverName === serverName);
    }

    const stats = {
      totalCalls: calls.length,
      successfulCalls: calls.filter(call => !call.error).length,
      failedCalls: calls.filter(call => call.error).length,
      averageDuration: 0,
      toolBreakdown: {} as Record<string, number>
    };

    // 计算平均耗时
    const durationsWithValue = calls.filter(call => call.duration).map(call => call.duration!);
    if (durationsWithValue.length > 0) {
      stats.averageDuration = durationsWithValue.reduce((sum, duration) => sum + duration, 0) / durationsWithValue.length;
    }

    // 工具调用分布
    calls.forEach(call => {
      const key = `${call.serverName}/${call.toolName}`;
      stats.toolBreakdown[key] = (stats.toolBreakdown[key] || 0) + 1;
    });

    return stats;
  }
}

// 全局监控器实例
export const mcpCallMonitor = MCPCallMonitor.getInstance();

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
   * 获取指定MCP服务器的工具（带监控）
   */
  async getTools(serverNames: string[]): Promise<any[]> {
    const startTime = Date.now();
    try {
      const client = this.getClient(serverNames);
      const tools = await client.getTools();
      
      // 记录工具获取调用
      mcpCallMonitor.logCall(
        serverNames.join(','), 
        'getTools', 
        { serverNames }, 
        { toolCount: tools.length },
        undefined,
        Date.now() - startTime
      );
      
      return tools;
    } catch (error) {
      mcpCallMonitor.logCall(
        serverNames.join(','), 
        'getTools', 
        { serverNames }, 
        undefined,
        error,
        Date.now() - startTime
      );
      throw error;
    }
  }

  /**
   * 获取指定MCP服务器的资源列表
   */
  async getResources(serverNames: string[]): Promise<any[]> {
    try {
      const allResources: any[] = [];
      for (const serverName of serverNames) {
        const multiClient = this.getClient([serverName]);
        const client = await multiClient.getClient(serverName);
        if (client) {
          const result = await client.listResources();
          allResources.push(...(result.resources || []));
        }
      }
      return allResources;
    } catch (error) {
      console.error(`Error getting resources from ${serverNames.join(', ')}:`, error);
      return [];
    }
  }

  /**
   * 读取指定资源内容
   */
  async readResource(serverNames: string[], uri: string): Promise<any> {
    try {
      for (const serverName of serverNames) {
        const multiClient = this.getClient([serverName]);
        const client = await multiClient.getClient(serverName);
        if (client) {
          return await client.readResource({ uri });
        }
      }
      throw new Error(`No available client found for servers: ${serverNames.join(', ')}`);
    } catch (error) {
      console.error(`Error reading resource ${uri} from ${serverNames.join(', ')}:`, error);
      throw error;
    }
  }

  /**
   * 获取指定MCP服务器的提示模板列表
   */
  async getPrompts(serverNames: string[]): Promise<any[]> {
    try {
      const allPrompts: any[] = [];
      for (const serverName of serverNames) {
        const multiClient = this.getClient([serverName]);
        const client = await multiClient.getClient(serverName);
        if (client) {
          const result = await client.listPrompts();
          allPrompts.push(...(result.prompts || []));
        }
      }
      return allPrompts;
    } catch (error) {
      console.error(`Error getting prompts from ${serverNames.join(', ')}:`, error);
      return [];
    }
  }

  /**
   * 获取指定提示模板
   */
  async getPrompt(serverNames: string[], name: string, args?: Record<string, any>): Promise<any> {
    try {
      for (const serverName of serverNames) {
        const multiClient = this.getClient([serverName]);
        const client = await multiClient.getClient(serverName);
        if (client) {
          return await client.getPrompt({ name, arguments: args });
        }
      }
      throw new Error(`No available client found for servers: ${serverNames.join(', ')}`);
    } catch (error) {
      console.error(`Error getting prompt ${name} from ${serverNames.join(', ')}:`, error);
      throw error;
    }
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

// 专门为sql-hub agent提供的工具获取函数
export async function getPostgresqlHubTools(): Promise<any[]> {
  return await mcpClientManager.getToolsFromServer("sql-hub");
}

export async function getPostgresqlHubResources(): Promise<any[]> {
  return await mcpClientManager.getResources(["sql-hub"]);
}

export async function getPostgresqlHubResourceContent(uri: string): Promise<any> {
  return await mcpClientManager.readResource(["sql-hub"], uri);
}

export async function getPostgresqlHubPrompts(): Promise<any[]> {
  return await mcpClientManager.getPrompts(["sql-hub"]);
}

export async function getPostgresqlHubPrompt(name: string, args?: Record<string, any>): Promise<any> {
  return await mcpClientManager.getPrompt(["sql-hub"], name, args);
}

// 专门为json-writer agent提供的工具获取函数
export async function getJsonWriterTools(): Promise<any[]> {
  return await mcpClientManager.getToolsFromServer("json-writer");
}

// 自定义组合工具获取函数
export async function getCustomTools(serverNames: string[]): Promise<any[]> {
  return await mcpClientManager.getTools(serverNames);
}
