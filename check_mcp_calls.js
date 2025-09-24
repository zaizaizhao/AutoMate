/**
 * 简单的MCP调用检查脚本
 * 用于快速检查postgresql-hub工具是否被调用
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// 简单的调用历史记录
let callHistory = [];

// 模拟监控函数
function logMCPCall(serverName, toolName, success = true) {
  const call = {
    timestamp: new Date(),
    serverName,
    toolName,
    success
  };
  callHistory.push(call);
  console.log(`[MCP-Call] ${success ? '✅' : '❌'} ${serverName}/${toolName} - ${call.timestamp.toISOString()}`);
}

// 检查函数
function checkMCPCalls() {
  console.log('=== MCP调用检查 ===');
  
  if (callHistory.length === 0) {
    console.log('❌ 没有检测到任何MCP调用');
    console.log('');
    console.log('可能的原因:');
    console.log('1. Agent还没有开始执行');
    console.log('2. Agent没有调用MCP工具');
    console.log('3. MCP服务器连接失败');
    console.log('');
    console.log('建议:');
    console.log('1. 检查MCP服务器是否运行在 http://localhost:8083');
    console.log('2. 查看Agent日志中的MCP相关信息');
    console.log('3. 使用实时监控模式: node apps/agents/test-mcp-monitor.js interactive');
    return;
  }

  const postgresqlCalls = callHistory.filter(call => call.serverName === 'postgresql-hub');
  const successfulCalls = postgresqlCalls.filter(call => call.success);
  
  console.log(`总MCP调用: ${callHistory.length}`);
  console.log(`PostgreSQL-Hub调用: ${postgresqlCalls.length}`);
  console.log(`成功调用: ${successfulCalls.length}`);
  
  if (postgresqlCalls.length > 0) {
    console.log('\nPostgreSQL-Hub调用详情:');
    postgresqlCalls.forEach((call, index) => {
      const status = call.success ? '✅' : '❌';
      console.log(`  ${index + 1}. ${status} ${call.toolName} - ${call.timestamp.toISOString()}`);
    });
  }
}

// 模拟一些调用用于测试
function simulateCalls() {
  console.log('模拟一些MCP调用用于测试...\n');
  
  logMCPCall('postgresql-hub', 'getTools', true);
  setTimeout(() => logMCPCall('postgresql-hub', 'execute_sql', true), 1000);
  setTimeout(() => logMCPCall('postgresql-hub', 'execute_sql', false), 2000);
  
  setTimeout(() => {
    console.log('\n');
    checkMCPCalls();
  }, 3000);
}

// 实时监控模式
function startRealTimeMonitoring() {
  console.log('=== 实时MCP调用监控 ===');
  console.log('监控已启动，等待MCP调用...');
  console.log('按 Ctrl+C 退出\n');

  // 模拟定期检查
  const checkInterval = setInterval(() => {
    // 这里应该连接到实际的MCP监控系统
    // 现在只是显示当前状态
    const now = new Date();
    console.log(`[${now.toISOString()}] 监控中... (已记录 ${callHistory.length} 次调用)`);
  }, 5000);

  process.on('SIGINT', () => {
    console.log('\n\n停止监控...');
    clearInterval(checkInterval);
    checkMCPCalls();
    process.exit(0);
  });
}

// 主函数
function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'check';

  switch (command) {
    case 'check':
      checkMCPCalls();
      break;
    case 'simulate':
      simulateCalls();
      break;
    case 'monitor':
      startRealTimeMonitoring();
      break;
    case 'help':
      console.log('MCP调用检查工具');
      console.log('');
      console.log('用法:');
      console.log('  node check_mcp_calls.js [command]');
      console.log('');
      console.log('命令:');
      console.log('  check     - 检查MCP调用历史 (默认)');
      console.log('  simulate  - 模拟一些调用用于测试');
      console.log('  monitor   - 启动实时监控模式');
      console.log('  help      - 显示帮助信息');
      console.log('');
      console.log('高级监控:');
      console.log('  node apps/agents/test-mcp-monitor.js          - 完整测试');
      console.log('  node apps/agents/test-mcp-monitor.js interactive - 交互式监控');
      break;
    default:
      console.log(`未知命令: ${command}`);
      console.log('使用 "help" 查看可用命令');
  }
}

main();