# LangGraphJS 多Agent记忆共享 PostgreSQL 技术方案

## 1. 技术架构概述

### 1.1 架构设计原则

本技术方案基于LangGraphJS框架，实现多个AI Agent之间的记忆共享机制，使用PostgreSQL作为持久化存储后端。架构设计遵循以下原则：

* **分布式记忆管理**：支持多个Agent实例同时访问和更新共享记忆

* **数据一致性**：确保并发访问时的数据完整性和一致性

* **可扩展性**：支持水平扩展和高并发场景

* **实时同步**：Agent间记忆变更的实时同步机制

* **命名空间隔离**：不同业务场景下的记忆隔离

### 1.2 系统架构图

```mermaid
graph TD
    A[Agent 1] --> B[Memory Manager]
    C[Agent 2] --> B
    D[Agent N] --> B
    B --> E[PostgreSQL Store]
    B --> F[Memory Cache]
    E --> G[Checkpoints Table]
    E --> H[Memory Store Table]
    E --> I[Agent Sessions Table]
    F --> J[Redis Cache]
    
    subgraph "LangGraphJS Runtime"
        A
        C
        D
    end
    
    subgraph "Memory Layer"
        B
        F
    end
    
    subgraph "Persistence Layer"
        E
        G
        H
        I
    end
```

## 2. PostgreSQL 数据库设计

### 2.1 核心表结构

#### 2.1.1 Checkpoints 表（状态检查点）

```sql
-- LangGraph 检查点表
CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    checkpoint JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_id ON checkpoints(thread_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoints(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_parent ON checkpoints(parent_checkpoint_id);
```

#### 2.1.2 Memory Store 表（共享记忆存储）

```sql
-- 共享记忆存储表
CREATE TABLE IF NOT EXISTS memory_store (
    namespace_path TEXT[] NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    PRIMARY KEY (namespace_path, key)
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_memory_store_namespace ON memory_store USING GIN(namespace_path);
CREATE INDEX IF NOT EXISTS idx_memory_store_updated_at ON memory_store(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_store_expires_at ON memory_store(expires_at) WHERE expires_at IS NOT NULL;

-- 自动清理过期记忆的触发器
CREATE OR REPLACE FUNCTION cleanup_expired_memories()
RETURNS void AS $$
BEGIN
    DELETE FROM memory_store WHERE expires_at IS NOT NULL AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
```

#### 2.1.3 Agent Sessions 表（Agent会话管理）

```sql
-- Agent会话管理表
CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    namespace_path TEXT[] NOT NULL,
    session_data JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_id ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_thread_id ON agent_sessions(thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_last_active ON agent_sessions(last_active_at DESC);
```

#### 2.1.4 Memory Access Log 表（记忆访问日志）

```sql
-- 记忆访问日志表
CREATE TABLE IF NOT EXISTS memory_access_log (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    namespace_path TEXT[] NOT NULL,
    memory_key TEXT NOT NULL,
    operation_type TEXT NOT NULL CHECK (operation_type IN ('READ', 'write', 'delete')),
    operation_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_memory_access_log_session ON memory_access_log(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_access_log_agent ON memory_access_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_access_log_created_at ON memory_access_log(created_at DESC);
```

### 2.2 数据库连接配置

```typescript
// database/config.ts
import { Pool } from 'pg';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export const createDatabasePool = (config: DatabaseConfig): Pool => {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    max: config.maxConnections || 20,
    idleTimeoutMillis: config.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis || 2000,
    // 重要：LangGraph PostgreSQL checkpointer 需要的配置
    application_name: 'langgraph-multi-agent',
  });
};
```

## 3. 多Agent记忆共享机制

### 3.1 共享记忆管理器

```typescript
// memory/SharedMemoryManager.ts
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { BaseStore } from '@langchain/langgraph';

export interface MemoryNamespace {
  project: string;
  environment: string;
  agent_type: string;
  session_id?: string;
}

export interface SharedMemoryItem {
  key: string;
  value: any;
  metadata?: Record<string, any>;
  expiresAt?: Date;
}

export class SharedMemoryManager {
  private pool: Pool;
  private checkpointer: PostgresSaver;
  private store: PostgreSQLStore;

  constructor(pool: Pool) {
    this.pool = pool;
    this.checkpointer = new PostgresSaver(pool);
    this.store = new PostgreSQLStore(pool);
  }

  async initialize(): Promise<void> {
    // 初始化检查点表
    await this.checkpointer.setup();
    
    // 初始化自定义表
    await this.setupCustomTables();
  }

  private async setupCustomTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // 创建所有自定义表
      await client.query(`
        -- Memory Store 表创建语句（如上所示）
        -- Agent Sessions 表创建语句（如上所示）
        -- Memory Access Log 表创建语句（如上所示）
      `);
    } finally {
      client.release();
    }
  }

  // 获取命名空间路径
  private getNamespacePath(namespace: MemoryNamespace): string[] {
    const path = [namespace.project, namespace.environment, namespace.agent_type];
    if (namespace.session_id) {
      path.push(namespace.session_id);
    }
    return path;
  }

  // 存储共享记忆
  async setSharedMemory(
    namespace: MemoryNamespace,
    key: string,
    value: any,
    options?: {
      expiresIn?: number; // 秒
      metadata?: Record<string, any>;
    }
  ): Promise<void> {
    const namespacePath = this.getNamespacePath(namespace);
    const expiresAt = options?.expiresIn 
      ? new Date(Date.now() + options.expiresIn * 1000)
      : null;

    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO memory_store (namespace_path, key, value, expires_at, metadata, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (namespace_path, key)
         DO UPDATE SET 
           value = EXCLUDED.value,
           expires_at = EXCLUDED.expires_at,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()`,
        [
          namespacePath,
          key,
          JSON.stringify(value),
          expiresAt,
          JSON.stringify(options?.metadata || {})
        ]
      );
    } finally {
      client.release();
    }
  }

  // 获取共享记忆
  async getSharedMemory(
    namespace: MemoryNamespace,
    key: string
  ): Promise<SharedMemoryItem | null> {
    const namespacePath = this.getNamespacePath(namespace);
    
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT key, value, metadata, expires_at, updated_at
         FROM memory_store
         WHERE namespace_path = $1 AND key = $2
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [namespacePath, key]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        key: row.key,
        value: JSON.parse(row.value),
        metadata: JSON.parse(row.metadata || '{}'),
        expiresAt: row.expires_at ? new Date(row.expires_at) : undefined
      };
    } finally {
      client.release();
    }
  }

  // 列出命名空间下的所有记忆
  async listSharedMemories(
    namespace: MemoryNamespace,
    options?: {
      prefix?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<SharedMemoryItem[]> {
    const namespacePath = this.getNamespacePath(namespace);
    
    let query = `
      SELECT key, value, metadata, expires_at, updated_at
      FROM memory_store
      WHERE namespace_path = $1
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
    
    const params: any[] = [namespacePath];
    
    if (options?.prefix) {
      query += ` AND key LIKE $${params.length + 1}`;
      params.push(`${options.prefix}%`);
    }
    
    query += ` ORDER BY updated_at DESC`;
    
    if (options?.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(options.limit);
    }
    
    if (options?.offset) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(options.offset);
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query(query, params);
      
      return result.rows.map(row => ({
        key: row.key,
        value: JSON.parse(row.value),
        metadata: JSON.parse(row.metadata || '{}'),
        expiresAt: row.expires_at ? new Date(row.expires_at) : undefined
      }));
    } finally {
      client.release();
    }
  }

  // 删除共享记忆
  async deleteSharedMemory(
    namespace: MemoryNamespace,
    key: string
  ): Promise<boolean> {
    const namespacePath = this.getNamespacePath(namespace);
    
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM memory_store WHERE namespace_path = $1 AND key = $2`,
        [namespacePath, key]
      );
      
      return result.rowCount > 0;
    } finally {
      client.release();
    }
  }

  // 清理过期记忆
  async cleanupExpiredMemories(): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM memory_store WHERE expires_at IS NOT NULL AND expires_at < NOW()`
      );
      
      return result.rowCount;
    } finally {
      client.release();
    }
  }

  // 获取检查点保存器（用于LangGraph）
  getCheckpointer(): PostgresSaver {
    return this.checkpointer;
  }

  // 获取存储器（用于LangGraph BaseStore）
  getStore(): PostgreSQLStore {
    return this.store;
  }
}
```

### 3.2 PostgreSQL Store 实现

```typescript
// memory/PostgreSQLStore.ts
import { Pool } from 'pg';
import { BaseStore } from '@langchain/langgraph';

export class PostgreSQLStore extends BaseStore {
  private pool: Pool;

  constructor(pool: Pool) {
    super();
    this.pool = pool;
  }

  async get(namespace: string[], key: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT value FROM memory_store 
         WHERE namespace_path = $1 AND key = $2
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [namespace, key]
      );
      
      if (result.rows.length === 0) {
        return undefined;
      }
      
      return JSON.parse(result.rows[0].value);
    } finally {
      client.release();
    }
  }

  async put(namespace: string[], key: string, value: any): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO memory_store (namespace_path, key, value, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (namespace_path, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [namespace, key, JSON.stringify(value)]
      );
    } finally {
      client.release();
    }
  }

  async delete(namespace: string[], key: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `DELETE FROM memory_store WHERE namespace_path = $1 AND key = $2`,
        [namespace, key]
      );
    } finally {
      client.release();
    }
  }

  async *list(namespace: string[]): AsyncGenerator<[string, any]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT key, value FROM memory_store 
         WHERE namespace_path = $1
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY updated_at DESC`,
        [namespace]
      );
      
      for (const row of result.rows) {
        yield [row.key, JSON.parse(row.value)];
      }
    } finally {
      client.release();
    }
  }
}
```

## 4. 多Agent实现代码示例

### 4.1 Agent基础类

```typescript
// agents/BaseAgent.ts
import { StateGraph, MessagesState } from '@langchain/langgraph';
import { SharedMemoryManager, MemoryNamespace } from '../memory/SharedMemoryManager';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

export interface AgentConfig {
  agentId: string;
  agentType: string;
  namespace: MemoryNamespace;
  llm: ChatOpenAI;
  memoryManager: SharedMemoryManager;
}

export abstract class BaseAgent {
  protected config: AgentConfig;
  protected graph: StateGraph;
  protected memoryManager: SharedMemoryManager;

  constructor(config: AgentConfig) {
    this.config = config;
    this.memoryManager = config.memoryManager;
    this.graph = this.buildGraph();
  }

  protected abstract buildGraph(): StateGraph;

  // 保存记忆到共享存储
  protected async saveSharedMemory(
    key: string,
    value: any,
    options?: { expiresIn?: number; metadata?: Record<string, any> }
  ): Promise<void> {
    await this.memoryManager.setSharedMemory(
      this.config.namespace,
      key,
      value,
      options
    );
  }

  // 从共享存储获取记忆
  protected async getSharedMemory(key: string): Promise<any> {
    const memory = await this.memoryManager.getSharedMemory(
      this.config.namespace,
      key
    );
    return memory?.value;
  }

  // 获取所有相关记忆
  protected async getAllSharedMemories(prefix?: string): Promise<Record<string, any>> {
    const memories = await this.memoryManager.listSharedMemories(
      this.config.namespace,
      { prefix }
    );
    
    const result: Record<string, any> = {};
    for (const memory of memories) {
      result[memory.key] = memory.value;
    }
    return result;
  }

  // 编译图并返回可执行的Agent
  compile() {
    return this.graph.compile({
      checkpointer: this.memoryManager.getCheckpointer()
    });
  }

  // 执行Agent
  async invoke(input: any, config?: any) {
    const compiledGraph = this.compile();
    return await compiledGraph.invoke(input, {
      ...config,
      configurable: {
        thread_id: this.config.namespace.session_id || 'default',
        ...config?.configurable
      }
    });
  }
}
```

### 4.2 协作Agent示例

```typescript
// agents/CollaborativeAgents.ts
import { BaseAgent, AgentConfig } from './BaseAgent';
import { StateGraph, MessagesState, START, END } from '@langchain/langgraph';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// 研究Agent
export class ResearchAgent extends BaseAgent {
  protected buildGraph(): StateGraph {
    const workflow = new StateGraph(MessagesState);

    // 研究节点
    const researchNode = async (state: MessagesState) => {
      const lastMessage = state.messages[state.messages.length - 1];
      
      // 获取之前的研究结果
      const previousResearch = await this.getSharedMemory('research_results') || [];
      
      // 执行研究逻辑
      const researchPrompt = `
        基于以下问题进行研究：${lastMessage.content}
        
        之前的研究结果：
        ${JSON.stringify(previousResearch, null, 2)}
        
        请提供新的研究发现和见解。
      `;
      
      const response = await this.config.llm.invoke([
        new SystemMessage('你是一个专业的研究助手，负责收集和分析信息。'),
        new HumanMessage(researchPrompt)
      ]);
      
      // 保存研究结果到共享记忆
      const newResearch = {
        timestamp: new Date().toISOString(),
        query: lastMessage.content,
        findings: response.content,
        agent_id: this.config.agentId
      };
      
      previousResearch.push(newResearch);
      await this.saveSharedMemory('research_results', previousResearch);
      
      // 通知其他Agent有新的研究结果
      await this.saveSharedMemory('latest_research', newResearch, { expiresIn: 3600 });
      
      return {
        messages: [new AIMessage(`研究完成：${response.content}`)]
      };
    };

    workflow.addNode('research', researchNode);
    workflow.addEdge(START, 'research');
    workflow.addEdge('research', END);

    return workflow;
  }
}

// 分析Agent
export class AnalysisAgent extends BaseAgent {
  protected buildGraph(): StateGraph {
    const workflow = new StateGraph(MessagesState);

    // 分析节点
    const analysisNode = async (state: MessagesState) => {
      const lastMessage = state.messages[state.messages.length - 1];
      
      // 获取研究结果进行分析
      const researchResults = await this.getSharedMemory('research_results') || [];
      const previousAnalysis = await this.getSharedMemory('analysis_results') || [];
      
      const analysisPrompt = `
        基于以下研究结果进行分析：
        ${JSON.stringify(researchResults, null, 2)}
        
        用户问题：${lastMessage.content}
        
        之前的分析：
        ${JSON.stringify(previousAnalysis, null, 2)}
        
        请提供深入的分析和洞察。
      `;
      
      const response = await this.config.llm.invoke([
        new SystemMessage('你是一个专业的数据分析师，负责分析研究结果并提供洞察。'),
        new HumanMessage(analysisPrompt)
      ]);
      
      // 保存分析结果
      const newAnalysis = {
        timestamp: new Date().toISOString(),
        based_on_research: researchResults.length,
        analysis: response.content,
        agent_id: this.config.agentId
      };
      
      previousAnalysis.push(newAnalysis);
      await this.saveSharedMemory('analysis_results', previousAnalysis);
      
      return {
        messages: [new AIMessage(`分析完成：${response.content}`)]
      };
    };

    workflow.addNode('analysis', analysisNode);
    workflow.addEdge(START, 'analysis');
    workflow.addEdge('analysis', END);

    return workflow;
  }
}

// 总结Agent
export class SummaryAgent extends BaseAgent {
  protected buildGraph(): StateGraph {
    const workflow = new StateGraph(MessagesState);

    // 总结节点
    const summaryNode = async (state: MessagesState) => {
      const lastMessage = state.messages[state.messages.length - 1];
      
      // 获取所有相关记忆
      const allMemories = await this.getAllSharedMemories();
      
      const summaryPrompt = `
        基于以下所有信息生成综合总结：
        
        用户问题：${lastMessage.content}
        
        所有Agent的工作结果：
        ${JSON.stringify(allMemories, null, 2)}
        
        请提供一个全面、准确的总结报告。
      `;
      
      const response = await this.config.llm.invoke([
        new SystemMessage('你是一个专业的总结专家，负责整合所有信息并生成最终报告。'),
        new HumanMessage(summaryPrompt)
      ]);
      
      // 保存最终总结
      const finalSummary = {
        timestamp: new Date().toISOString(),
        user_query: lastMessage.content,
        summary: response.content,
        based_on_memories: Object.keys(allMemories),
        agent_id: this.config.agentId
      };
      
      await this.saveSharedMemory('final_summary', finalSummary);
      
      return {
        messages: [new AIMessage(`最终总结：${response.content}`)]
      };
    };

    workflow.addNode('summary', summaryNode);
    workflow.addEdge(START, 'summary');
    workflow.addEdge('summary', END);

    return workflow;
  }
}
```

### 4.3 多Agent协调器

```typescript
// agents/MultiAgentCoordinator.ts
import { SharedMemoryManager, MemoryNamespace } from '../memory/SharedMemoryManager';
import { ResearchAgent, AnalysisAgent, SummaryAgent } from './CollaborativeAgents';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';

export interface CoordinatorConfig {
  memoryManager: SharedMemoryManager;
  namespace: MemoryNamespace;
  llm: ChatOpenAI;
}

export class MultiAgentCoordinator {
  private memoryManager: SharedMemoryManager;
  private namespace: MemoryNamespace;
  private llm: ChatOpenAI;
  private agents: Map<string, any> = new Map();

  constructor(config: CoordinatorConfig) {
    this.memoryManager = config.memoryManager;
    this.namespace = config.namespace;
    this.llm = config.llm;
    this.initializeAgents();
  }

  private initializeAgents(): void {
    // 初始化研究Agent
    const researchAgent = new ResearchAgent({
      agentId: 'research-001',
      agentType: 'research',
      namespace: { ...this.namespace, agent_type: 'research' },
      llm: this.llm,
      memoryManager: this.memoryManager
    });

    // 初始化分析Agent
    const analysisAgent = new AnalysisAgent({
      agentId: 'analysis-001',
      agentType: 'analysis',
      namespace: { ...this.namespace, agent_type: 'analysis' },
      llm: this.llm,
      memoryManager: this.memoryManager
    });

    // 初始化总结Agent
    const summaryAgent = new SummaryAgent({
      agentId: 'summary-001',
      agentType: 'summary',
      namespace: { ...this.namespace, agent_type: 'summary' },
      llm: this.llm,
      memoryManager: this.memoryManager
    });

    this.agents.set('research', researchAgent);
    this.agents.set('analysis', analysisAgent);
    this.agents.set('summary', summaryAgent);
  }

  // 协调多个Agent执行任务
  async executeWorkflow(userQuery: string): Promise<string> {
    const sessionId = `session-${Date.now()}`;
    const config = {
      configurable: {
        thread_id: sessionId
      }
    };

    try {
      // 1. 执行研究Agent
      console.log('🔍 开始研究阶段...');
      const researchAgent = this.agents.get('research');
      await researchAgent.invoke({
        messages: [new HumanMessage(userQuery)]
      }, config);

      // 等待研究完成
      await this.waitForMemoryUpdate('research_results');

      // 2. 执行分析Agent
      console.log('📊 开始分析阶段...');
      const analysisAgent = this.agents.get('analysis');
      await analysisAgent.invoke({
        messages: [new HumanMessage(userQuery)]
      }, config);

      // 等待分析完成
      await this.waitForMemoryUpdate('analysis_results');

      // 3. 执行总结Agent
      console.log('📝 开始总结阶段...');
      const summaryAgent = this.agents.get('summary');
      const result = await summaryAgent.invoke({
        messages: [new HumanMessage(userQuery)]
      }, config);

      // 获取最终总结
      const finalSummary = await this.memoryManager.getSharedMemory(
        this.namespace,
        'final_summary'
      );

      return finalSummary?.value?.summary || '总结生成失败';

    } catch (error) {
      console.error('工作流执行失败:', error);
      throw error;
    }
  }

  // 等待记忆更新
  private async waitForMemoryUpdate(
    key: string,
    maxWaitTime: number = 30000
  ): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      const memory = await this.memoryManager.getSharedMemory(this.namespace, key);
      if (memory) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error(`等待记忆更新超时: ${key}`);
  }

  // 获取工作流状态
  async getWorkflowStatus(): Promise<{
    research: boolean;
    analysis: boolean;
    summary: boolean;
  }> {
    const [research, analysis, summary] = await Promise.all([
      this.memoryManager.getSharedMemory(this.namespace, 'research_results'),
      this.memoryManager.getSharedMemory(this.namespace, 'analysis_results'),
      this.memoryManager.getSharedMemory(this.namespace, 'final_summary')
    ]);

    return {
      research: !!research,
      analysis: !!analysis,
      summary: !!summary
    };
  }

  // 清理会话记忆
  async cleanupSession(): Promise<void> {
    const memories = await this.memoryManager.listSharedMemories(this.namespace);
    
    for (const memory of memories) {
      await this.memoryManager.deleteSharedMemory(this.namespace, memory.key);
    }
  }
}
```

## 5. 部署配置

### 5.1 Docker Compose 配置

```yaml
# docker-compose.yml
version: '3.8'

services:
  # PostgreSQL 数据库
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: langgraph_memory
      POSTGRES_USER: langgraph
      POSTGRES_PASSWORD: your_secure_password
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C"
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init-scripts:/docker-entrypoint-initdb.d
    command: >
      postgres
      -c shared_preload_libraries=pg_stat_statements
      -c pg_stat_statements.track=all
      -c max_connections=200
      -c shared_buffers=256MB
      -c effective_cache_size=1GB
      -c work_mem=4MB
      -c maintenance_work_mem=64MB
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U langgraph"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis 缓存（可选）
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # LangGraph 应用
  langgraph-app:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://langgraph:your_secure_password@postgres:5432/langgraph_memory
      - REDIS_URL=redis://redis:6379
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    volumes:
      - ./logs:/app/logs
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

### 5.2 环境配置

```bash
# .env
# 数据库配置
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=langgraph_memory
DATABASE_USER=langgraph
DATABASE_PASSWORD=your_secure_password
DATABASE_SSL=false
DATABASE_MAX_CONNECTIONS=20

# Redis配置（可选）
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# LLM配置
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4

# 应用配置
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# 记忆配置
MEMORY_CLEANUP_INTERVAL=3600000  # 1小时
MEMORY_DEFAULT_TTL=86400         # 24小时
MAX_MEMORY_SIZE_MB=1024          # 1GB
```

### 5.3 Kubernetes 部署配置

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: langgraph-system

---
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: langgraph-config
  namespace: langgraph-system
data:
  NODE_ENV: "production"
  LOG_LEVEL: "info"
  MEMORY_CLEANUP_INTERVAL: "3600000"
  MEMORY_DEFAULT_TTL: "86400"

---
# k8s/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: langgraph-secrets
  namespace: langgraph-system
type: Opaque
stringData:
  DATABASE_PASSWORD: "your_secure_password"
  OPENAI_API_KEY: "your_openai_api_key"

---
# k8s/postgres.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: langgraph-system
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:15-alpine
        env:
        - name: POSTGRES_DB
          value: "langgraph_memory"
        - name: POSTGRES_USER
          value: "langgraph"
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: langgraph-secrets
              key: DATABASE_PASSWORD
        ports:
        - containerPort: 5432
        volumeMounts:
        - name: postgres-storage
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "1000m"
  volumeClaimTemplates:
  - metadata:
      name: postgres-storage
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 20Gi

---
# k8s/postgres-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: langgraph-system
spec:
  selector:
    app: postgres
  ports:
  - port: 5432
    targetPort: 5432
  type: ClusterIP

---
# k8s/langgraph-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: langgraph-app
  namespace: langgraph-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: langgraph-app
  template:
    metadata:
      labels:
        app: langgraph-app
    spec:
      containers:
      - name: langgraph-app
        image: your-registry/langgraph-app:latest
        env:
        - name: DATABASE_URL
          value: "postgresql://langgraph:$(DATABASE_PASSWORD)@postgres:5432/langgraph_memory"
        - name: DATABASE_PASSWORD
          valueFrom:
            secretKeyRef:
              name: langgraph-secrets
              key: DATABASE_PASSWORD
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: langgraph-secrets
              key: OPENAI_API_KEY
        envFrom:
        - configMapRef:
            name: langgraph-config
        ports:
        - containerPort: 3000
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5

---
# k8s/langgraph-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: langgraph-app
  namespace: langgraph-system
spec:
  selector:
    app: langgraph-app
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer
```

## 6. 性能优化建议

### 6.1 数据库优化

```sql
-- 数据库性能优化配置
-- postgresql.conf 关键配置

-- 连接和内存配置
max_connections = 200
shared_buffers = 256MB
effective_cache_size = 1GB
work_mem = 4MB
maintenance_work_mem = 64MB

-- 检查点和WAL配置
wal_buffers = 16MB
checkpoint_completion_target = 0.9
max_wal_size = 1GB
min_wal_size = 80MB

-- 查询优化
random_page_cost = 1.1
effective_io_concurrency = 200

-- 日志配置
log_min_duration_statement = 1000
log_checkpoints = on
log_connections = on
log_disconnections = on
log_lock_waits = on

-- 统计信息
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
pg_stat_statements.max = 10000
```

### 6.2 连接池优化

```typescript
// database/optimized-pool.ts
import { Pool, PoolConfig } from 'pg';

export class OptimizedDatabasePool {
  private pool: Pool;
  private healthCheckInterval: NodeJS.Timeout;

  constructor(config: PoolConfig) {
    this.pool = new Pool({
      ...config,
      // 连接池优化配置
      max: 20,                    // 最大连接数
      min: 5,                     // 最小连接数
      idleTimeoutMillis: 30000,   // 空闲连接超时
      connectionTimeoutMillis: 2000, // 连接超时
      acquireTimeoutMillis: 60000,   // 获取连接超时
      
      // 连接验证
      allowExitOnIdle: true,
      
      // 错误处理
      application_name: 'langgraph-multi-agent',
    });

    // 连接池事件监听
    this.pool.on('connect', (client) => {
      console.log('数据库连接建立');
    });

    this.pool.on('error', (err) => {
      console.error('数据库连接池错误:', err);
    });

    // 定期健康检查
    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const client = await this.pool.connect();
        await client.query('SELECT 1');
        client.release();
      } catch (error) {
        console.error('数据库健康检查失败:', error);
      }
    }, 30000); // 30秒检查一次
  }

  getPool(): Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    await this.pool.end();
  }

  // 获取连接池状态
  getStatus() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount
    };
  }
}
```

### 6.3 缓存策略

```typescript
// cache/MemoryCache.ts
import Redis from 'ioredis';

export interface CacheConfig {
  redis?: {
    host: string;
    port: number;
    password?: string;
  };
  defaultTTL: number;
  maxMemorySize: number;
}

export class MemoryCache {
  private redis?: Redis;
  private localCache: Map<string, { value: any; expires: number }> = new Map();
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
    
    if (config.redis) {
      this.redis = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true
      });
    }

    // 定期清理本地缓存
    setInterval(() => this.cleanupLocalCache(), 60000);
  }

  async get(key: string): Promise<any> {
    // 先检查本地缓存
    const localValue = this.localCache.get(key);
    if (localValue && localValue.expires > Date.now()) {
      return localValue.value;
    }

    // 检查Redis缓存
    if (this.redis) {
      try {
        const redisValue = await this.redis.get(key);
        if (redisValue) {
          const parsed = JSON.parse(redisValue);
          // 同步到本地缓存
          this.setLocal(key, parsed, this.config.defaultTTL);
          return parsed;
        }
      } catch (error) {
        console.warn('Redis缓存读取失败:', error);
      }
    }

    return null;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const actualTTL = ttl || this.config.defaultTTL;
    
    // 设置本地缓存
    this.setLocal(key, value, actualTTL);
    
    // 设置Redis缓存
    if (this.redis) {
      try {
        await this.redis.setex(key, actualTTL, JSON.stringify(value));
      } catch (error) {
        console.warn('Redis缓存写入失败:', error);
      }
    }
  }

  private setLocal(key: string, value: any, ttl: number): void {
    // 检查内存使用量
    if (this.getMemoryUsage() > this.config.maxMemorySize) {
      this.evictLRU();
    }

    this.localCache.set(key, {
      value,
      expires: Date.now() + ttl * 1000
    });
  }

  private cleanupLocalCache(): void {
    const now = Date.now();
    for (const [key, item] of this.localCache.entries()) {
      if (item.expires <= now) {
        this.localCache.delete(key);
      }
    }
  }

  private getMemoryUsage(): number {
    return process.memoryUsage().heapUsed / 1024 / 1024; // MB
  }

  private evictLRU(): void {
    // 简单的LRU实现：删除最旧的条目
    const entries = Array.from(this.localCache.entries());
    entries.sort((a, b) => a[1].expires - b[1].expires);
    
    // 删除最旧的25%
    const toDelete = Math.floor(entries.length * 0.25);
    for (let i = 0; i < toDelete; i++) {
      this.localCache.delete(entries[i][0]);
    }
  }
}
```

## 7. 安全考虑

### 7.1 数据库安全

```sql
-- 数据库安全配置

-- 1. 创建专用用户和角色
CREATE ROLE langgraph_app;
CREATE USER langgraph_user WITH PASSWORD 'secure_random_password';
GRANT langgraph_app TO langgraph_user;

-- 2. 最小权限原则
GRANT CONNECT ON DATABASE langgraph_memory TO langgraph_app;
GRANT USAGE ON SCHEMA public TO langgraph_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO langgraph_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO langgraph_app;

-- 3. 行级安全策略（RLS）
ALTER TABLE memory_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;

-- 为不同命名空间创建安全策略
CREATE POLICY memory_namespace_policy ON memory_store
    FOR ALL TO langgraph_app
    USING (namespace_path[1] = current_setting('app.current_project', true));

CREATE POLICY session_agent_policy ON agent_sessions
    FOR ALL TO langgraph_app
    USING (agent_id = current_setting('app.current_agent_id', true));

-- 4. 审计日志
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    user_name TEXT NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    old_values JSONB,
    new_values JSONB
);

-- 创建审计触发器函数
CREATE OR REPLACE FUNCTION audit_trigger_function()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO audit_log (table_name, operation, user_name, old_values)
        VALUES (TG_TABLE_NAME, TG_OP, current_user, row_to_json(OLD));
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit_log (table_name, operation, user_name, old_values, new_values)
        VALUES (TG_TABLE_NAME, TG_OP, current_user, row_to_json(OLD), row_to_json(NEW));
        RETURN NEW;
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO audit_log (table_name, operation, user_name, new_values)
        VALUES (TG_TABLE_NAME, TG_OP, current_user, row_to_json(NEW));
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 为关键表添加审计触发器
CREATE TRIGGER memory_store_audit
    AFTER INSERT OR UPDATE OR DELETE ON memory_store
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
```

### 7.2 应用层安全

```typescript
// security/SecurityManager.ts
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export interface SecurityConfig {
  jwtSecret: string;
  encryptionKey: string;
  allowedOrigins: string[];
  rateLimitWindow: number;
  rateLimitMax: number;
}

export class SecurityManager {
  private config: SecurityConfig;
  private rateLimitMap: Map<string, { count: number; resetTime: number }> = new Map();

  constructor(config: SecurityConfig) {
    this.config = config;
    
    // 定期清理速率限制记录
    setInterval(() => this.cleanupRateLimit(), 60000);
  }

  // JWT令牌验证
  verifyToken(token: string): any {
    try {
      return jwt.verify(token, this.config.jwtSecret);
    } catch (error) {
      throw new Error('无效的访问令牌');
    }
  }

  // 生成JWT令牌
  generateToken(payload: any, expiresIn: string = '24h'): string {
    return jwt.sign(payload, this.config.jwtSecret, { expiresIn });
  }

  // 数据加密
  encrypt(data: string): string {
    const cipher = crypto.createCipher('aes-256-cbc', this.config.encryptionKey);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  }

  // 数据解密
  decrypt(encryptedData: string): string {
    const decipher = crypto.createDecipher('aes-256-cbc', this.config.encryptionKey);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // 速率限制检查
  checkRateLimit(identifier: string): boolean {
    const now = Date.now();
    const record = this.rateLimitMap.get(identifier);

    if (!record || now > record.resetTime) {
      this.rateLimitMap.set(identifier, {
        count: 1,
        resetTime: now + this.config.rateLimitWindow
      });
      return true;
    }

    if (record.count >= this.config.rateLimitMax) {
      return false;
    }

    record.count++;
    return true;
  }

  // 输入验证和清理
  sanitizeInput(input: any): any {
    if (typeof input === 'string') {
      // 移除潜在的恶意字符
      return input.replace(/[<>"'&]/g, '');
    }
    
    if (Array.isArray(input)) {
      return input.map(item => this.sanitizeInput(item));
    }
    
    if (typeof input === 'object' && input !== null) {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(input)) {
        sanitized[this.sanitizeInput(key)] = this.sanitizeInput(value);
      }
      return sanitized;
    }
    
    return input;
  }

  // CORS检查
  checkOrigin(origin: string): boolean {
    return this.config.allowedOrigins.includes(origin) || 
           this.config.allowedOrigins.includes('*');
  }

  // 清理速率限制记录
  private cleanupRateLimit(): void {
    const now = Date.now();
    for (const [key, record] of this.rateLimitMap.entries()) {
      if (now > record.resetTime) {
        this.rateLimitMap.delete(key);
      }
    }
  }

  // 生成安全的随机字符串
  generateSecureRandom(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  // 哈希密码
  hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  // 验证密码
  verifyPassword(password: string, hashedPassword: string): boolean {
    const [salt, hash] = hashedPassword.split(':');
    const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return hash === verifyHash;
  }
}
```

## 8. 故障排除指南

### 8.1 常见问题诊断

```typescript
// diagnostics/DiagnosticsManager.ts
import { Pool } from 'pg';
import { SharedMemoryManager } from '../memory/SharedMemoryManager';

export interface DiagnosticResult {
  component: string;
  status: 'healthy' | 'warning' | 'error';
  message: string;
  details?: any;
  timestamp: Date;
}

export class DiagnosticsManager {
  private pool: Pool;
  private memoryManager: SharedMemoryManager;

  constructor(pool: Pool, memoryManager: SharedMemoryManager) {
    this.pool = pool;
    this.memoryManager = memoryManager;
  }

  // 全面健康检查
  async runHealthCheck(): Promise<DiagnosticResult[]> {
    const results: DiagnosticResult[] = [];

    // 数据库连接检查
    results.push(await this.checkDatabaseConnection());
    
    // 内存存储检查
    results.push(await this.checkMemoryStore());
    
    // 检查点存储检查
    results.push(await this.checkCheckpointStore());
    
    // 系统资源检查
    results.push(await this.checkSystemResources());
    
    return results;
  }

  // 数据库连接检查
  private async checkDatabaseConnection(): Promise<DiagnosticResult> {
    try {
      const client = await this.pool.connect();
      const start = Date.now();
      await client.query('SELECT 1');
      const duration = Date.now() - start;
      client.release();

      const status = duration > 1000 ? 'warning' : 'healthy';
      return {
        component: 'database',
        status,
        message: `数据库连接正常，响应时间: ${duration}ms`,
        details: { responseTime: duration, poolStatus: this.getPoolStatus() },
        timestamp: new Date()
      };
    } catch (error) {
      return {
        component: 'database',
        status: 'error',
        message: `数据库连接失败: ${error.message}`,
        details: { error: error.message },
        timestamp: new Date()
      };
    }
  }

  // 内存存储检查
  private async checkMemoryStore(): Promise<DiagnosticResult> {
    try {
      const testKey = `health_check_${Date.now()}`;
      const testValue = { test: true, timestamp: Date.now() };
      
      // 测试写入
      await this.memoryManager.setSharedMemory(
        { project: 'test', environment: 'health', agent_type: 'diagnostic' },
        testKey,
        testValue,
        { expiresIn: 60 }
      );
      
      // 测试读取
      const retrieved = await this.memoryManager.getSharedMemory(
        { project: 'test', environment: 'health', agent_type: 'diagnostic' },
        testKey
      );
      
      // 清理测试数据
      await this.memoryManager.deleteSharedMemory(
        { project: 'test', environment: 'health', agent_type: 'diagnostic' },
        testKey
      );
      
      if (retrieved && retrieved.value.test === true) {
        return {
          component: 'memory_store',
          status: 'healthy',
          message: '内存存储读写正常',
          timestamp: new Date()
        };
      } else {
        return {
          component: 'memory_store',
          status: 'error',
          message: '内存存储读取失败',
          timestamp: new Date()
        };
      }
    } catch (error) {
      return {
        component: 'memory_store',
        status: 'error',
        message: `内存存储错误: ${error.message}`,
        details: { error: error.message },
        timestamp: new Date()
      };
    }
  }

  // 检查点存储检查
  private async checkCheckpointStore(): Promise<DiagnosticResult> {
    try {
      const checkpointer = this.memoryManager.getCheckpointer();
      
      // 测试检查点操作
      const testThreadId = `health_check_${Date.now()}`;
      const testCheckpoint = {
        v: 1,
        ts: new Date().toISOString(),
        id: 'test_checkpoint',
        channel_values: { test: 'data' },
        channel_versions: {},
        versions_seen: {}
      };
      
      // 测试保存检查点
      await checkpointer.put({
        configurable: { thread_id: testThreadId }
      }, testCheckpoint, {});
      
      // 测试获取检查点
      const retrieved = await checkpointer.get({
        configurable: { thread_id: testThreadId }
      });
      
      if (retrieved) {
        return {
          component: 'checkpoint_store',
          status: 'healthy',
          message: '检查点存储正常',
          timestamp: new Date()
        };
      } else {
        return {
          component: 'checkpoint_store',
          status: 'error',
          message: '检查点存储读取失败',
          timestamp: new Date()
        };
      }
    } catch (error) {
      return {
        component: 'checkpoint_store',
        status: 'error',
        message: `检查点存储错误: ${error.message}`,
        details: { error: error.message },
        timestamp: new Date()
      };
    }
  }

  // 系统资源检查
  private async checkSystemResources(): Promise<DiagnosticResult> {
    const memoryUsage = process.memoryUsage();
    const memoryUsageMB = {
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      external: Math.round(memoryUsage.external / 1024 / 1024)
    };

    const heapUsagePercent = (memoryUsageMB.heapUsed / memoryUsageMB.heapTotal) * 100;
    
    let status: 'healthy' | 'warning' | 'error' = 'healthy';
    let message = '系统资源正常';
    
    if (heapUsagePercent > 90) {
      status = 'error';
      message = '内存使用率过高';
    } else if (heapUsagePercent > 75) {
      status = 'warning';
      message = '内存使用率较高';
    }

    return {
      component: 'system_resources',
      status,
      message: `${message}，堆内存使用率: ${heapUsagePercent.toFixed(1)}%`,
      details: { memoryUsage: memoryUsageMB, heapUsagePercent },
      timestamp: new Date()
    };
  }

  // 获取连接池状态
  private getPoolStatus() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount
    };
  }

  // 生成诊断报告
  async generateDiagnosticReport(): Promise<string> {
    const results = await this.runHealthCheck();
    
    let report = '# LangGraphJS 多Agent记忆共享系统诊断报告\n\n';
    report += `生成时间: ${new Date().toISOString()}\n\n`;
    
    const healthyCount = results.filter(r => r.status === 'healthy').length;
    const warningCount = results.filter(r => r.status === 'warning').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    
    report += `## 总体状态\n`;
    report += `- 正常: ${healthyCount}\n`;
    report += `- 警告: ${warningCount}\n`;
    report += `- 错误: ${errorCount}\n\n`;
    
    report += `## 详细检查结果\n\n`;
    
    for (const result of results) {
      const statusIcon = {
        healthy: '✅',
        warning: '⚠️',
        error: '❌'
      }[result.status];
      
      report += `### ${statusIcon} ${result.component}\n`;
      report += `**状态**: ${result.status}\n`;
      report += `**消息**: ${result.message}\n`;
      
      if (result.details) {
        report += `**详情**: \`\`\`json\n${JSON.stringify(result.details, null, 2)}\n\`\`\`\n`;
      }
      
      report += `\n`;
    }
    
    return report;
  }
}
```

### 8.2 性能监控

```typescript
// monitoring/PerformanceMonitor.ts
export interface PerformanceMetrics {
  timestamp: Date;
  memoryOperations: {
    reads: number;
    writes: number;
    deletes: number;
    avgResponseTime: number;
  };
  databaseConnections: {
    active: number;
    idle: number;
    waiting: number;
  };
  systemResources: {
    memoryUsage: number;
    cpuUsage: number;
  };
  agentActivity: {
    activeAgents: number;
    completedTasks: number;
    failedTasks: number;
  };
}

export class PerformanceMonitor {
  private metrics: PerformanceMetrics[] = [];
  private pool: Pool;
  private memoryManager: SharedMemoryManager;
  private metricsInterval: NodeJS.Timeout;

  constructor(pool: Pool, memoryManager: SharedMemoryManager) {
    this.pool = pool;
    this.memoryManager = memoryManager;
    
    // 每分钟收集一次指标
    this.metricsInterval = setInterval(() => {
      this.collectMetrics();
    }, 60000);
  }

  private async collectMetrics(): Promise<void> {
    try {
      const metrics: PerformanceMetrics = {
        timestamp: new Date(),
        memoryOperations: await this.getMemoryOperationMetrics(),
        databaseConnections: this.getDatabaseConnectionMetrics(),
        systemResources: this.getSystemResourceMetrics(),
        agentActivity: await this.getAgentActivityMetrics()
      };
      
      this.metrics.push(metrics);
      
      // 保留最近24小时的指标
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      this.metrics = this.metrics.filter(m => m.timestamp > cutoff);
      
    } catch (error) {
      console.error('指标收集失败:', error);
    }
  }

  private async getMemoryOperationMetrics() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          operation_type,
          COUNT(*) as count,
          AVG(EXTRACT(EPOCH FROM (NOW() - created_at))) as avg_age
        FROM memory_access_log 
        WHERE created_at > NOW() - INTERVAL '1 minute'
        GROUP BY operation_type
      `);
      
      const operations = { reads: 0, writes: 0, deletes: 0, avgResponseTime: 0 };
      let totalOps = 0;
      let totalTime = 0;
      
      for (const row of result.rows) {
        const count = parseInt(row.count);
        totalOps += count;
        totalTime += row.avg_age * count;
        
        if (row.operation_type === 'read') operations.reads = count;
        else if (row.operation_type === 'write') operations.writes = count;
        else if (row.operation_type === 'delete') operations.deletes = count;
      }
      
      operations.avgResponseTime = totalOps > 0 ? totalTime / totalOps : 0;
      return operations;
      
    } finally {
      client.release();
    }
  }

  private getDatabaseConnectionMetrics() {
    return {
      active: this.pool.totalCount - this.pool.idleCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount
    };
  }

  private getSystemResourceMetrics() {
    const memoryUsage = process.memoryUsage();
    return {
      memoryUsage: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
      cpuUsage: process.cpuUsage().user / 1000000 // 转换为秒
    };
  }

  private async getAgentActivityMetrics() {
    const client = await this.pool.connect();
    try {
      const activeAgentsResult = await client.query(`
        SELECT COUNT(DISTINCT agent_id) as count
        FROM agent_sessions 
        WHERE last_active_at > NOW() - INTERVAL '5 minutes'
      `);
      
      const tasksResult = await client.query(`
        SELECT 
          COUNT(*) FILTER (WHERE operation_data->>'status' = 'completed') as completed,
          COUNT(*) FILTER (WHERE operation_data->>'status' = 'failed') as failed
        FROM memory_access_log 
        WHERE created_at > NOW() - INTERVAL '1 minute'
          AND operation_data->>'status' IS NOT NULL
      `);
      
      return {
        activeAgents: parseInt(activeAgentsResult.rows[0]?.count || '0'),
        completedTasks: parseInt(tasksResult.rows[0]?.completed || '0'),
        failedTasks: parseInt(tasksResult.rows[0]?.failed || '0')
      };
      
    } finally {
      client.release();
    }
  }

  // 获取性能报告
  getPerformanceReport(hours: number = 1): PerformanceMetrics[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.metrics.filter(m => m.timestamp > cutoff);
  }

  // 检测性能异常
  detectAnomalies(): string[] {
    const recent = this.getPerformanceReport(1);
    if (recent.length === 0) return [];
    
    const anomalies: string[] = [];
    const latest = recent[recent.length - 1];
    
    // 检查内存使用
    if (latest.systemResources.memoryUsage > 1024) { // 1GB
      anomalies.push('内存使用过高');
    }
    
    // 检查数据库连接
    if (latest.databaseConnections.waiting > 5) {
      anomalies.push('数据库连接等待过多');
    }
    
    // 检查响应时间
    if (latest.memoryOperations.avgResponseTime > 1000) { // 1秒
      anomalies.push('内存操作响应时间过长');
    }
    
    // 检查失败率
    const totalTasks = latest.agentActivity.completedTasks + latest.agentActivity.failedTasks;
    if (totalTasks > 0) {
      const failureRate = latest.agentActivity.failedTasks / totalTasks;
      if (failureRate > 0.1) { // 10%失败率
        anomalies.push('任务失败率过高');
      }
    }
    
    return anomalies;
  }

  stop(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
  }
}
```

### 8.3 日志管理

```typescript
// logging/Logger.ts
import winston from 'winston';
import path from 'path';

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug'
}

export interface LogContext {
  agentId?: string;
  sessionId?: string;
  threadId?: string;
  namespace?: string[];
  operation?: string;
  duration?: number;
  error?: Error;
  [key: string]: any;
}

export class Logger {
  private winston: winston.Logger;

  constructor(logLevel: LogLevel = LogLevel.INFO) {
    this.winston = winston.createLogger({
      level: logLevel,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        // 控制台输出
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        }),
        
        // 文件输出
        new winston.transports.File({
          filename: path.join('logs', 'error.log'),
          level: 'error'
        }),
        new winston.transports.File({
          filename: path.join('logs', 'combined.log')
        })
      ]
    });
  }

  error(message: string, context?: LogContext): void {
    this.winston.error(message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.winston.warn(message, context);
  }

  info(message: string, context?: LogContext): void {
    this.winston.info(message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.winston.debug(message, context);
  }

  // 记录Agent操作
  logAgentOperation(
    operation: string,
    agentId: string,
    context: LogContext = {}
  ): void {
    this.info(`Agent操作: ${operation}`, {
      ...context,
      agentId,
      operation
    });
  }

  // 记录内存操作
  logMemoryOperation(
    operation: string,
    namespace: string[],
    key: string,
    context: LogContext = {}
  ): void {
    this.info(`内存操作: ${operation}`, {
      ...context,
      operation,
      namespace,
      memoryKey: key
    });
  }

  // 记录性能指标
  logPerformance(
    operation: string,
    duration: number,
    context: LogContext = {}
  ): void {
    const level = duration > 1000 ? LogLevel.WARN : LogLevel.INFO;
    this.winston.log(level, `性能: ${operation} 耗时 ${duration}ms`, {
      ...context,
      operation,
      duration
    });
  }

  // 记录错误详情
  logError(
    error: Error,
    operation: string,
    context: LogContext = {}
  ): void {
    this.error(`操作失败: ${operation}`, {
      ...context,
      operation,
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name
      }
    });
  }
}
```

## 9. 使用示例

### 9.1 完整应用示例

```typescript
// app.ts
import { createDatabasePool } from './database/config';
import { SharedMemoryManager } from './memory/SharedMemoryManager';
import { MultiAgentCoordinator } from './agents/MultiAgentCoordinator';
import { ChatOpenAI } from '@langchain/openai';
import { Logger, LogLevel } from './logging/Logger';
import { DiagnosticsManager } from './diagnostics/DiagnosticsManager';
import { PerformanceMonitor } from './monitoring/PerformanceMonitor';

async function main() {
  // 初始化日志
  const logger = new Logger(LogLevel.INFO);
  
  try {
    // 1. 创建数据库连接池
    const pool = createDatabasePool({
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      database: process.env.DATABASE_NAME || 'langgraph_memory',
      username: process.env.DATABASE_USER || 'langgraph',
      password: process.env.DATABASE_PASSWORD || 'password',
      maxConnections: 20
    });

    // 2. 初始化共享记忆管理器
    const memoryManager = new SharedMemoryManager(pool);
    await memoryManager.initialize();
    logger.info('共享记忆管理器初始化完成');

    // 3. 初始化LLM
    const llm = new ChatOpenAI({
      modelName: 'gpt-4',
      temperature: 0.7
    });

    // 4. 创建多Agent协调器
    const coordinator = new MultiAgentCoordinator({
      memoryManager,
      namespace: {
        project: 'demo',
        environment: 'production',
        agent_type: 'coordinator'
      },
      llm
    });

    // 5. 初始化诊断和监控
    const diagnostics = new DiagnosticsManager(pool, memoryManager);
    const monitor = new PerformanceMonitor(pool, memoryManager);

    // 6. 运行健康检查
    const healthResults = await diagnostics.runHealthCheck();
    const healthyComponents = healthResults.filter(r => r.status === 'healthy').length;
    logger.info(`系统健康检查完成: ${healthyComponents}/${healthResults.length} 组件正常`);

    // 7. 执行示例工作流
    const userQuery = '请分析人工智能在医疗领域的应用前景';
    logger.info(`开始执行工作流: ${userQuery}`);
    
    const startTime = Date.now();
    const result = await coordinator.executeWorkflow(userQuery);
    const duration = Date.now() - startTime;
    
    logger.logPerformance('工作流执行', duration);
    console.log('\n=== 工作流执行结果 ===');
    console.log(result);

    // 8. 生成诊断报告
    const diagnosticReport = await diagnostics.generateDiagnosticReport();
    console.log('\n=== 系统诊断报告 ===');
    console.log(diagnosticReport);

    // 9. 检查性能异常
    const anomalies = monitor.detectAnomalies();
    if (anomalies.length > 0) {
      logger.warn('检测到性能异常', { anomalies });
    }

    // 10. 清理资源
    process.on('SIGINT', async () => {
      logger.info('正在关闭应用...');
      monitor.stop();
      await coordinator.cleanupSession();
      await pool.end();
      process.exit(0);
    });

  } catch (error) {
    logger.logError(error as Error, '应用启动');
    process.exit(1);
  }
}

// 启动应用
if (require.main === module) {
  main().catch(console.error);
}
```

## 10. 总结

本技术方案提供了一个完整的LangGraphJS多Agent记忆共享解决方案，具有以下特点：

### 10.1 核心优势

* **高可靠性**：基于PostgreSQL的持久化存储，确保数据安全

* **高性能**：优化的数据库设计和连接池管理

* **可扩展性**：支持水平扩展和多实例部署

* **实时同步**：Agent间记忆的实时共享和同步

* **安全性**：完善的安全机制和访问控制

* **可监控性**：全面的诊断和性能监控

### 10.2 适用场景

* 多Agent协作系统

* 大规模AI应用

* 需要持久化记忆的对话系统

* 企业级AI解决方案

### 10.3 部署建议

1. **开发环境**：使用Docker Compose快速搭建
2. **生产环境**：推荐使用Kubernetes进行容器化部署
3. **监控告警**：集成Prometheus和Grafana进行监控
4. **备份策略**：定期备份PostgreSQL数据

通过本方案，开发团队可以快速构建一个稳定、高效的多Agent记忆共享系统，为复杂的AI应用提供强大的基础设施支持。
