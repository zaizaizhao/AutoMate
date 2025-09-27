// 测试PlanAgent修复效果的脚本
const { PlanAgent } = require('./apps/agents/dist/app/Agents/PlanAgent/PlanAgent.js');
const { SharedMemoryManager } = require('./apps/agents/dist/app/Memory/SharedMemoryManager.js');

async function testPlanAgentFixes() {
  console.log('=== 测试PlanAgent修复效果 ===');
  
  try {
    // 初始化内存管理器
    const memoryManager = new SharedMemoryManager({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'automate_db',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'password'
    });
    
    await memoryManager.initialize();
    console.log('✓ 内存管理器初始化成功');
    
    // 初始化PlanAgent
    const planAgent = new PlanAgent({
      namespace: {
        project: 'test-project',
        environment: 'development',
        agent_type: 'plan-agent'
      }
    }, memoryManager);
    
    console.log('✓ PlanAgent初始化成功');
    
    // 构建并编译图
    const graph = planAgent.buildGraph();
    const compiledGraph = graph.compile({
      checkpointer: memoryManager.getCheckpointer(),
      store: memoryManager.getStore()
    });
    
    console.log('✓ 图编译成功');
    
    // 测试执行
    const testThreadId = `test-${Date.now()}`;
    console.log(`开始测试，线程ID: ${testThreadId}`);
    
    const result = await compiledGraph.invoke(
      { messages: [] },
      {
        configurable: {
          thread_id: testThreadId
        }
      }
    );
    
    console.log('✓ 图执行完成');
    console.log('执行结果:', JSON.stringify(result, null, 2));
    
    // 检查数据库中是否保存了计划
    console.log('\n=== 检查数据库中的计划 ===');
    const savedPlans = await memoryManager.getTaskPlansByPlan(testThreadId);
    console.log(`找到 ${savedPlans.length} 个保存的计划:`);
    
    savedPlans.forEach((plan, index) => {
      console.log(`计划 ${index + 1}:`);
      console.log(`  - 工具名: ${plan.toolName}`);
      console.log(`  - 描述: ${plan.description}`);
      console.log(`  - 参数: ${JSON.stringify(plan.parameters)}`);
      console.log(`  - 需要数据库验证: ${plan.isRequiredValidateByDatabase}`);
      console.log('');
    });
    
    if (savedPlans.length > 0) {
      console.log('✓ 计划成功保存到数据库');
      
      // 检查是否使用了真实数据
      let hasRealData = false;
      savedPlans.forEach(plan => {
        const params = plan.parameters || {};
        Object.values(params).forEach(value => {
          if (typeof value === 'string') {
            // 检查是否是UUID格式
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if (uuidRegex.test(value)) {
              hasRealData = true;
              console.log(`✓ 发现真实UUID数据: ${value}`);
            }
            // 检查是否避免了假数据
            const fakePatterns = ['test', 'example', 'sample', 'john doe', 'user1', '123'];
            const lowerValue = value.toLowerCase();
            if (fakePatterns.some(pattern => lowerValue.includes(pattern))) {
              console.log(`⚠️  可能包含假数据: ${value}`);
            }
          }
        });
      });
      
      if (hasRealData) {
        console.log('✓ 检测到使用了真实数据库数据');
      } else {
        console.log('⚠️  未检测到明显的真实数据库数据');
      }
    } else {
      console.log('❌ 没有找到保存的计划');
    }
    
    console.log('\n=== 测试完成 ===');
    
  } catch (error) {
    console.error('测试失败:', error);
    console.error('错误堆栈:', error.stack);
  }
}

// 运行测试
testPlanAgentFixes().catch(console.error);