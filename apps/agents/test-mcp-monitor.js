import { 
  mcpCallDetector, 
  realTimeMCPMonitor, 
  checkPostgresqlHubActivity, 
  printMCPReport 
} from './src/app/mcp-servers/mcp-monitor.js';
import { getPostgresqlHubTools } from './src/app/mcp-servers/mcp-client.js';

/**
 * 测试MCP工具调用检测功能
 */
async function testMCPCallDetection() {
  console.log('=== MCP工具调用检测测试 ===\n');

  // 1. 启动实时监控
  console.log('1. 启动实时监控...');
  realTimeMCPMonitor.start();

  // 2. 检查初始状态
  console.log('\n2. 检查初始PostgreSQL-Hub调用状态:');
  checkPostgresqlHubActivity();

  // 3. 执行一些MCP工具调用
  console.log('\n3. 执行PostgreSQL-Hub工具调用...');
  try {
    const tools = await getPostgresqlHubTools();
    console.log(`✅ 成功获取 ${tools.length} 个工具`);
  } catch (error) {
    console.error('❌ 工具调用失败:', error.message);
  }

  // 4. 等待一下让监控器检测到调用
  await new Promise(resolve => setTimeout(resolve, 1000));

  // 5. 再次检查PostgreSQL-Hub调用状态
  console.log('\n4. 检查调用后的PostgreSQL-Hub状态:');
  checkPostgresqlHubActivity();

  // 6. 生成完整报告
  console.log('\n5. 生成MCP调用报告:');
  printMCPReport();

  // 7. 测试等待特定工具调用
  console.log('\n6. 测试等待工具调用功能...');
  try {
    // 先执行一个调用
    setTimeout(async () => {
      console.log('   执行延迟调用...');
      await getPostgresqlHubTools();
    }, 2000);

    // 等待调用
    const calls = await mcpCallDetector.waitForToolCall('postgresql-hub', undefined, 5000);
    console.log(`✅ 检测到 ${calls.length} 个调用`);
  } catch (error) {
    console.error('❌ 等待调用超时:', error.message);
  }

  // 8. 停止监控
  console.log('\n7. 停止实时监控...');
  realTimeMCPMonitor.stop();

  console.log('\n=== 测试完成 ===');
}

/**
 * 交互式监控模式
 */
async function interactiveMonitoring() {
  console.log('=== 交互式MCP监控模式 ===');
  console.log('启动实时监控，按 Ctrl+C 退出...\n');

  // 启动实时监控
  realTimeMCPMonitor.start();

  // 设置定期报告
  const reportInterval = setInterval(() => {
    console.log('\n--- 定期报告 ---');
    checkPostgresqlHubActivity();
    console.log('');
  }, 10000); // 每10秒报告一次

  // 处理退出
  process.on('SIGINT', () => {
    console.log('\n\n正在停止监控...');
    clearInterval(reportInterval);
    realTimeMCPMonitor.stop();
    
    console.log('\n最终报告:');
    printMCPReport();
    
    process.exit(0);
  });

  // 保持进程运行
  console.log('监控已启动，等待MCP工具调用...');
  console.log('提示：在另一个终端中运行你的agent来触发MCP调用');
}

// 根据命令行参数决定运行模式
const mode = process.argv[2] || 'test';

if (mode === 'interactive' || mode === 'i') {
  interactiveMonitoring();
} else {
  testMCPCallDetection();
}