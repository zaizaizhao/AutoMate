import { mcpCallMonitor } from './mcp-client.js';

/**
 * MCP工具调用检测器
 */
export class MCPCallDetector {
  private checkInterval: NodeJS.Timeout | null = null;
  private lastCheckTime: Date = new Date();
  private callbacks: Array<(calls: any[]) => void> = [];

  /**
   * 开始监控MCP工具调用
   */
  startMonitoring(intervalMs: number = 1000) {
    if (this.checkInterval) {
      this.stopMonitoring();
    }

    console.log('[MCP-Detector] 开始监控MCP工具调用...');
    
    this.checkInterval = setInterval(() => {
      this.checkForNewCalls();
    }, intervalMs);
  }

  /**
   * 停止监控
   */
  stopMonitoring() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('[MCP-Detector] 停止监控MCP工具调用');
    }
  }

  /**
   * 检查新的调用
   */
  private checkForNewCalls() {
    const allCalls = mcpCallMonitor.getCallHistory();
    const newCalls = allCalls.filter(call => call.timestamp > this.lastCheckTime);
    
    if (newCalls.length > 0) {
      console.log(`[MCP-Detector] 检测到 ${newCalls.length} 个新的MCP调用:`);
      newCalls.forEach(call => {
        console.log(`  - ${call.serverName}/${call.toolName} at ${call.timestamp.toISOString()}`);
      });
      
      // 通知回调函数
      this.callbacks.forEach(callback => {
        try {
          callback(newCalls);
        } catch (error) {
          console.error('[MCP-Detector] 回调函数执行错误:', error);
        }
      });
      
      this.lastCheckTime = new Date();
    }
  }

  /**
   * 添加新调用检测回调
   */
  onNewCalls(callback: (calls: any[]) => void) {
    this.callbacks.push(callback);
  }

  /**
   * 检查sql-hub工具是否被调用
   */
  checkPostgresqlHubCalls(): {
    hasCalls: boolean;
    callCount: number;
    recentCalls: any[];
    lastCallTime?: Date;
  } {
    const postgresqlCalls = mcpCallMonitor.getCallHistory('sql-hub');
    
    return {
      hasCalls: postgresqlCalls.length > 0,
      callCount: postgresqlCalls.length,
      recentCalls: postgresqlCalls.slice(-5), // 最近5次调用
      lastCallTime: postgresqlCalls.length > 0 ? postgresqlCalls[postgresqlCalls.length - 1].timestamp : undefined
    };
  }

  /**
   * 等待特定工具被调用
   */
  async waitForToolCall(serverName: string, toolName?: string, timeoutMs: number = 30000): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkCall = () => {
        const calls = mcpCallMonitor.getCallHistory(serverName, toolName);
        const recentCalls = calls.filter(call => call.timestamp.getTime() >= startTime);
        
        if (recentCalls.length > 0) {
          resolve(recentCalls);
          return;
        }
        
        if (Date.now() - startTime >= timeoutMs) {
          reject(new Error(`等待 ${serverName}${toolName ? '/' + toolName : ''} 调用超时`));
          return;
        }
        
        setTimeout(checkCall, 100);
      };
      
      checkCall();
    });
  }

  /**
   * 生成调用报告
   */
  generateReport(): string {
    const stats = mcpCallMonitor.getCallStats();
    const postgresqlStats = mcpCallMonitor.getCallStats('sql-hub');
    const recentCalls = mcpCallMonitor.getRecentCalls(10);
    
    let report = '=== MCP工具调用报告 ===\n\n';
    
    report += `总体统计:\n`;
    report += `  - 总调用次数: ${stats.totalCalls}\n`;
    report += `  - 成功调用: ${stats.successfulCalls}\n`;
    report += `  - 失败调用: ${stats.failedCalls}\n`;
    report += `  - 平均耗时: ${stats.averageDuration.toFixed(2)}ms\n\n`;
    
    report += `sql-hub统计:\n`;
    report += `  - 调用次数: ${postgresqlStats.totalCalls}\n`;
    report += `  - 成功率: ${postgresqlStats.totalCalls > 0 ? ((postgresqlStats.successfulCalls / postgresqlStats.totalCalls) * 100).toFixed(1) : 0}%\n\n`;
    
    report += `工具调用分布:\n`;
    Object.entries(stats.toolBreakdown).forEach(([tool, count]) => {
      report += `  - ${tool}: ${count}次\n`;
    });
    
    if (recentCalls.length > 0) {
      report += `\n最近的调用:\n`;
      recentCalls.forEach(call => {
        const status = call.error ? '❌' : '✅';
        report += `  ${status} ${call.timestamp.toISOString()} - ${call.serverName}/${call.toolName}\n`;
      });
    }
    
    return report;
  }
}

/**
 * 实时MCP调用监控器
 */
export class RealTimeMCPMonitor {
  private isActive: boolean = false;
  private detector: MCPCallDetector;

  constructor() {
    this.detector = new MCPCallDetector();
  }

  /**
   * 开始实时监控
   */
  start() {
    if (this.isActive) {
      console.log('[实时监控] 已经在运行中');
      return;
    }

    this.isActive = true;
    console.log('[实时监控] 开始实时监控MCP工具调用...');
    
    // 监听新调用
    this.detector.onNewCalls((calls) => {
      calls.forEach(call => {
        const status = call.error ? '❌ 失败' : '✅ 成功';
        const duration = call.duration ? ` (${call.duration}ms)` : '';
        console.log(`[实时监控] ${status} ${call.serverName}/${call.toolName}${duration}`);
        
        if (call.error) {
          console.error(`[实时监控] 错误详情:`, call.error);
        }
      });
    });
    
    this.detector.startMonitoring(500); // 每500ms检查一次
  }

  /**
   * 停止实时监控
   */
  stop() {
    if (!this.isActive) {
      console.log('[实时监控] 未在运行');
      return;
    }

    this.isActive = false;
    this.detector.stopMonitoring();
    console.log('[实时监控] 已停止实时监控');
  }

  /**
   * 获取检测器实例
   */
  getDetector(): MCPCallDetector {
    return this.detector;
  }
}

// 导出全局实例
export const mcpCallDetector = new MCPCallDetector();
export const realTimeMCPMonitor = new RealTimeMCPMonitor();

/**
 * 便捷函数：检查sql-hub是否被调用
 */
export function checkPostgresqlHubActivity(): void {
  const result = mcpCallDetector.checkPostgresqlHubCalls();
  
  console.log('=== sql-hub 调用检查 ===');
  console.log(`是否有调用: ${result.hasCalls ? '✅ 是' : '❌ 否'}`);
  console.log(`调用次数: ${result.callCount}`);
  
  if (result.lastCallTime) {
    console.log(`最后调用时间: ${result.lastCallTime.toISOString()}`);
  }
  
  if (result.recentCalls.length > 0) {
    console.log('最近的调用:');
    result.recentCalls.forEach((call, index) => {
      const status = call.error ? '❌' : '✅';
      console.log(`  ${index + 1}. ${status} ${call.toolName} - ${call.timestamp.toISOString()}`);
    });
  }
}

/**
 * 便捷函数：生成并打印调用报告
 */
export function printMCPReport(): void {
  const report = mcpCallDetector.generateReport();
  console.log(report);
}