const { PlanAgent } = require('./apps/agents/src/app/Agents/PlanAgent/PlanAgent.ts');
const { SharedMemoryManager } = require('./apps/agents/src/app/SharedMemoryManager.ts');
const { Pool } = require('pg');
const { DatabaseInitializer } = require('./apps/agents/src/app/DatabaseInitializer.ts');

// 设置环境变量
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'debug';

async function testPlanAgent() {
  console.log('开始测试PlanAgent修复...');
  
  try {
    // 初始化数据库连接池
    const pool = new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'automate_db',
      password: process.env.DB_PASSWORD || 'password',
      port: parseInt(process.env.DB_PORT || '5432'),
    });

    // 初始化数据库
    const dbInitializer = new DatabaseInitializer(pool);
    await dbInitializer.initialize();

    // 初始化共享内存管理器
    const memoryManager = new SharedMemoryManager(pool);
    await memoryManager.initialize();

    // 创建PlanAgent实例
    const planAgent = new PlanAgent({
      namespace: {
        project: 'test',
        environment: 'dev',
        agent_type: 'plan'
      }
    }, memoryManager);

    // 构建并编译图
    const graph = planAgent.buildGraph();
    const compiledGraph = graph.compile();

    console.log('PlanAgent图构建完成，开始测试...');

    // 执行测试
    const testInput = {
      queryResults: {},
      currentToolIndex: 0,
      currentTool: null,
      generatedPlans: [],
      batchInfo: null,
      toolsList: []
    };

    const result = await compiledGraph.invoke(testInput, {
      configurable: { thread_id: 'test-thread-' + Date.now() }
    });

    console.log('测试完成，结果:', JSON.stringify(result, null, 2));
    
    // 检查是否正常生成计划且没有无限循环
    if (result.generatedPlans && result.generatedPlans.length > 0) {
      console.log('✅ 成功生成计划，无限循环问题已修复');
    } else {
      console.log('⚠️ 未生成计划，可能存在其他问题');
    }

    await pool.end();
    
  } catch (error) {
    console.error('测试失败:', error);
    process.exit(1);
  }
}

// 运行测试
testPlanAgent().catch(console.error);