// 测试getResources方法的脚本
import { mcpClientManager, getPostgresqlHubResources } from './src/app/mcp-servers/mcp-client.ts';

async function testGetResources() {
  console.log('开始测试getResources方法...');
  
  try {
    // 测试1: 使用mcpClientManager直接调用getResources
    console.log('\n=== 测试1: 直接调用getResources ===');
    const resources1 = await mcpClientManager.getResources(['postgresql-hub']);
    console.log('获取到的资源数量:', resources1.length);
    console.log('资源列表:', JSON.stringify(resources1, null, 2));
    
    // 测试2: 使用便捷函数getPostgresqlHubResources
    console.log('\n=== 测试2: 使用便捷函数getPostgresqlHubResources ===');
    const resources2 = await getPostgresqlHubResources();
    console.log('获取到的资源数量:', resources2.length);
    console.log('资源列表:', JSON.stringify(resources2, null, 2));
    
    // 测试3: 测试错误的服务器名称
    console.log('\n=== 测试3: 测试不存在的服务器 ===');
    try {
      const resources3 = await mcpClientManager.getResources(['non-existent-server']);
      console.log('不存在服务器的结果:', resources3);
    } catch (error) {
      console.log('预期的错误:', error.message);
    }
    
    // 测试4: 测试多个服务器
    console.log('\n=== 测试4: 测试多个服务器 ===');
    const resources4 = await mcpClientManager.getResources(['postgresql-hub', 'json-writer']);
    console.log('多服务器资源数量:', resources4.length);
    console.log('多服务器资源列表:', JSON.stringify(resources4, null, 2));
    
    console.log('\n✅ 所有测试完成!');
    
  } catch (error) {
    console.error('❌ 测试过程中发生错误:');
    console.error('错误信息:', error.message);
    console.error('错误堆栈:', error.stack);
  }
}

// 运行测试
testGetResources().then(() => {
  console.log('测试脚本执行完毕');
  process.exit(0);
}).catch((error) => {
  console.error('测试脚本执行失败:', error);
  process.exit(1);
});