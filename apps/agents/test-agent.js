import { ExecuteTestAgent } from './dist/app/Agents/TestAgent/Agent/TestAgent.js';
import { HumanMessage } from '@langchain/core/messages';
import { SharedMemoryManager } from './dist/app/Memory/SharedMemoryManager.js';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

// 加载环境变量
try {
  const envPath = path.resolve(process.cwd(), "../../.env");
  dotenv.config({ path: envPath });
} catch (e) {
  console.log('No .env file found, using default settings');
}

// 配置日志级别
process.env.LANGCHAIN_VERBOSE = "false";
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = "false";
process.env.LANGCHAIN_TRACING_V2 = "false";

// 抑制警告
const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  const message = args.join(' ');
  if (message.includes('field[completion_tokens] already exists') || 
      message.includes('field[total_tokens] already exists') ||
      message.includes('value has unsupported type')) {
    return;
  }
  originalConsoleWarn.apply(console, args);
};

async function testAgent() {
  console.log('🧪 Starting TestAgent test...');
  
  try {
    // 创建数据库连接池
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/agents'
    });

    // 初始化内存管理器
    const memoryManager = new SharedMemoryManager(pool);
    await memoryManager.initialize();

    // 创建命名空间
    const namespace = {
      project: "automate",
      environment: "development", 
      agent_type: "test",
      session_id: "test-session"
    };

    // 创建TestAgent实例
    const testAgent = new ExecuteTestAgent({
      agentId: 'test-agent-001',
      agentType: 'testAgent',
      namespace: namespace,
      memoryManager: memoryManager
    });

    // 构建图
    const graph = testAgent.buildGraph();
    
    console.log('📝 Testing tool call with DeepSeek-V3...');
    
    // 测试工具调用
    const result = await graph.invoke({
      messages: [new HumanMessage("请使用write_to_file工具创建一个测试文件")]
    }, {
      configurable: {
        thread_id: "test-thread"
      }
    });

    console.log('✅ Test completed successfully!');
    console.log('Result:', JSON.stringify(result, null, 2));
    
    // 关闭数据库连接
    await pool.end();
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// 运行测试
testAgent().catch(console.error);