import { MultiAgentCoordinator } from "./AgentManager/AgentManager.js";
import { SharedMemoryManager } from "./Memory/SharedMemoryManager.js";
import { MemoryNamespace } from "./Memory/SharedMemoryManager.js";
import { Pool } from "pg";
import * as path from "path";
import * as dotenv from "dotenv";

// 优先加载根目录 .env，确保 DATABASE_URL 正确注入
try {
  const envPath = path.resolve(process.cwd(), "../../.env");
  dotenv.config({ path: envPath });
} catch (e) {
  // 忽略 .env 加载错误，继续使用进程内已有的环境变量
}

function sanitizeDbUrl(raw?: string): string {
  if (!raw) return "(default)";
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(invalid DATABASE_URL format)";
  }
}

// 配置日志级别以抑制LangChain token警告
process.env.LANGCHAIN_VERBOSE = "false";
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = "false";
process.env.LANGCHAIN_TRACING_V2 = "false";

// 抑制特定的警告日志
const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  const message = args.join(" ");
  // 过滤掉token相关的警告信息
  if (
    message.includes("field[completion_tokens] already exists") ||
    message.includes("field[total_tokens] already exists") ||
    message.includes("value has unsupported type")
  ) {
    return; // 不输出这些警告
  }
  originalConsoleWarn.apply(console, args);
};

// 创建数据库连接池
console.log(
  `[DB] Using connection: ${sanitizeDbUrl(process.env.DATABASE_URL)}`
);
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://localhost:5432/agents",
});

// 初始化内存管理器
const memoryManager = new SharedMemoryManager(pool);
await memoryManager.initialize();

// 创建命名空间
const namespace: MemoryNamespace = {
  project: "automate",
  environment: "development",
  agent_type: "main",
  session_id: "default",
};

const multiAgentCoordinator = new MultiAgentCoordinator(
  memoryManager,
  namespace
);
const workflow = multiAgentCoordinator.initializeAgents();
// Note: recursionLimit should be passed when invoking the graph, not during compilation
// Example: await graph.invoke({...}, { recursionLimit: 100 })

export const graph = workflow
  .compile({
    checkpointer: memoryManager.getCheckpointer(),
  })
  .withConfig({ recursionLimit: 256 });
// 为LangGraph checkpointer提供thread_id，用于标识会话和存储检查点
// const threadId = `thread_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
// await graph.invoke({}, { 
//   recursionLimit: 100,
//   configurable: {
//     thread_id: threadId
//   }
// })
graph.name = "agent";
