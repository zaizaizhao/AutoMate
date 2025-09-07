# ExcuteTestAgent 技术实现文档

## 1. 概述

`ExcuteTestAgent` 是一个专门用于执行MCP工具调用的智能代理，负责从数据库中读取 `PlanAgent` 生成的测试计划数据，并通过LLM调用相应的MCP工具。该代理专注于工具调用执行，调用结果直接存储到PostgreSQL记忆系统中。

## 2. 架构设计

### 2.1 整体架构

```mermaid
graph TD
    A[ExcuteTestAgent] --> B[LLM]
    A --> C[SharedMemoryManager]
    A --> D[MCP Client Manager]
    
    B --> E[Tool Calling]
    C --> F[(task_plans表)]
    C --> G[(memory_store表)]
    
    D --> H[Test Server Tools]
    D --> I[JSON Writer Tools]
    
    E --> H
    E --> I
    
    subgraph "AI层"
        B
        E
    end
    
    subgraph "数据层"
        F
        G
    end
    
    subgraph "工具层"
        H
        I
    end
```

### 2.2 核心组件

* **TaskReader**: 从数据库读取待执行的测试任务

* **LLMToolCaller**: 通过LLM调用MCP工具

* **MemoryStore**: 将调用结果存储到PostgreSQL记忆系统

## 3. 数据结构

### 3.1 TaskPlanedForTest 接口

```typescript
interface TaskPlanedForTest {
  id: string;
  plan_id: string;
  task_name: string;
  tool_name: string;
  tool_args: Record<string, any>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  created_at: Date;
  updated_at: Date;
}
```

### 3.2 工具调用结果

```typescript
interface ToolCallResult {
  taskId: string;
  toolName: string;
  toolArgs: Record<string, any>;
  result: any;
  timestamp: Date;
}
```

## 4. 核心实现

### 4.1 ExcuteTestAgent 类结构

```typescript
export class ExcuteTestAgent extends BaseAgent {
  private llm: any;
  private mcpClientManager: MCPClientManager;
  
  constructor(config: AgentConfig) {
    super(config);
    this.llm = config.llm;
    this.mcpClientManager = new MCPClientManager();
  }

  // 主要执行节点
  async ExcuteTestNode(state: typeof MessagesAnnotation.State, config: LangGraphRunnableConfig) {
    const threadId = config?.configurable?.thread_id;
    console.log(`[ExcuteTestNode] Starting MCP tool execution for thread: ${threadId}`);
    
    try {
      // 1. 读取待执行的测试任务
      const pendingTasks = await this.readPendingTasks(threadId);
      
      if (pendingTasks.length === 0) {
        console.log('[ExcuteTestNode] No pending tasks found');
        return { messages: [...state.messages] };
      }
      
      // 2. 通过LLM调用MCP工具
      const results = await this.executeTasksWithLLM(pendingTasks);
      
      // 3. 存储结果到记忆系统
      await this.storeResultsToMemory(results, threadId);
      
      return {
        messages: [
          ...state.messages,
          new AIMessage({
            content: `已完成 ${results.length} 个MCP工具调用，结果已存储到记忆系统`,
            additional_kwargs: {
              tool_call_count: results.length
            }
          })
        ]
      };
    } catch (error) {
      console.error('[ExcuteTestNode] MCP tool execution failed:', error);
      throw error;
    }
  }
}
```

### 4.2 任务读取器 (TaskReader)

```typescript
class TaskReader {
  constructor(private memoryManager: SharedMemoryManager) {}
  
  async readPendingTasks(threadId?: string): Promise<TaskPlanedForTest[]> {
    const query = `
      SELECT * FROM task_plans 
      WHERE status = 'pending'
      ${threadId ? 'AND thread_id = $1' : ''}
      ORDER BY created_at ASC
    `;
    
    const params = threadId ? [threadId] : [];
    const result = await this.memoryManager.executeQuery(query, params);
    
    return result.rows.map(row => ({
      id: row.id,
      plan_id: row.plan_id,
      task_name: row.task_name,
      tool_name: row.tool_name,
      tool_args: JSON.parse(row.tool_args),
      status: row.status,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at)
    }));
  }
}
```

### 4.3 LLM工具调用器 (LLMToolCaller)

```typescript
class LLMToolCaller {
  constructor(
    private llm: any,
    private mcpClientManager: MCPClientManager
  ) {}
  
  async executeTasksWithLLM(tasks: TaskPlanedForTest[]): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = [];
    
    // 获取可用的MCP工具
    const availableTools = await this.mcpClientManager.getTestServerTools();
    
    for (const task of tasks) {
      console.log(`[LLMToolCaller] Processing task: ${task.task_name}`);
      
      try {
        // 构建LLM调用提示
        const prompt = this.buildToolCallPrompt(task, availableTools);
        
        // 通过LLM调用工具
        const toolResult = await this.callToolWithLLM(prompt, availableTools);
        
        const result: ToolCallResult = {
          taskId: task.id,
          toolName: task.tool_name,
          toolArgs: task.tool_args,
          result: toolResult,
          timestamp: new Date()
        };
        
        results.push(result);
        console.log(`[LLMToolCaller] Task ${task.task_name} completed`);
        
      } catch (error) {
        console.error(`[LLMToolCaller] Task ${task.task_name} failed:`, error);
        
        // 即使失败也记录结果
        const result: ToolCallResult = {
          taskId: task.id,
          toolName: task.tool_name,
          toolArgs: task.tool_args,
          result: { error: error.message },
          timestamp: new Date()
        };
        
        results.push(result);
      }
    }
    
    return results;
  }
  
  private buildToolCallPrompt(task: TaskPlanedForTest, availableTools: any[]): string {
    return `
请使用工具 "${task.tool_name}" 执行以下任务：

任务名称: ${task.task_name}
工具参数: ${JSON.stringify(task.tool_args, null, 2)}

可用工具列表:
${availableTools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n')}

请调用指定的工具并返回结果。
    `;
  }
  
  private async callToolWithLLM(prompt: string, tools: any[]): Promise<any> {
    // 使用LLM进行工具调用
    const response = await this.llm.invoke(
      [{ role: 'user', content: prompt }],
      {
        tools: tools,
        tool_choice: 'auto'
      }
    );
    
    // 处理工具调用结果
    if (response.tool_calls && response.tool_calls.length > 0) {
      const toolCall = response.tool_calls[0];
      const tool = tools.find(t => t.name === toolCall.name);
      
      if (tool) {
        return await tool.invoke(toolCall.args);
      }
    }
    
    return response.content;
  }
}
```

### 4.4 记忆存储器 (MemoryStore)

```typescript
class MemoryStore {
  constructor(private memoryManager: SharedMemoryManager) {}
  
  async storeResultsToMemory(results: ToolCallResult[], threadId: string): Promise<void> {
    for (const result of results) {
      // 构建存储键值
      const namespace = ['execute_results', threadId, result.taskId];
      const key = `tool_call_${result.toolName}_${Date.now()}`;
      
      // 准备存储数据
      const storeData = {
        taskId: result.taskId,
        toolName: result.toolName,
        toolArgs: result.toolArgs,
        result: result.result,
        timestamp: result.timestamp.toISOString(),
        executedBy: 'ExcuteTestAgent'
      };
      
      try {
        // 存储到PostgreSQL记忆系统
        await this.memoryManager.getStore().put(
          namespace,
          key,
          JSON.stringify(storeData)
        );
        
        console.log(`[MemoryStore] Stored result for task ${result.taskId} to memory system`);
        
      } catch (error) {
        console.error(`[MemoryStore] Failed to store result for task ${result.taskId}:`, error);
      }
    }
  }
  
  async getStoredResults(threadId: string, taskId?: string): Promise<any[]> {
    try {
      const namespace = ['execute_results', threadId];
      
      if (taskId) {
        namespace.push(taskId);
      }
      
      const results = await this.memoryManager.getStore().list(namespace);
      
      return results.map(item => {
        try {
          return JSON.parse(item.value);
        } catch {
          return item.value;
        }
      });
      
    } catch (error) {
      console.error('[MemoryStore] Failed to retrieve stored results:', error);
      return [];
    }
  }
}
```

### 4.5 完整实现示例

```typescript
// ExcuteTestAgent的完整实现
export class ExcuteTestAgent extends BaseAgent {
  private taskReader: TaskReader;
  private llmToolCaller: LLMToolCaller;
  private memoryStore: MemoryStore;
  
  constructor(config: AgentConfig) {
    super(config);
    this.taskReader = new TaskReader(this.memoryManager);
    this.llmToolCaller = new LLMToolCaller(config.llm, new MCPClientManager());
    this.memoryStore = new MemoryStore(this.memoryManager);
  }
  
  async readPendingTasks(threadId: string): Promise<TaskPlanedForTest[]> {
    return await this.taskReader.readPendingTasks(threadId);
  }
  
  async executeTasksWithLLM(tasks: TaskPlanedForTest[]): Promise<ToolCallResult[]> {
    return await this.llmToolCaller.executeTasksWithLLM(tasks);
  }
  
  async storeResultsToMemory(results: ToolCallResult[], threadId: string): Promise<void> {
    return await this.memoryStore.storeResultsToMemory(results, threadId);
  }
}
```

## 5. 核心流程

### 5.1 MCP工具调用流程

1. **任务读取**: 从`task_plans`表读取待执行的任务
2. **LLM处理**: 构建提示词，通过LLM理解任务并选择合适的工具
3. **工具调用**: LLM调用指定的MCP工具执行任务
4. **结果存储**: 将工具调用结果存储到PostgreSQL记忆系统

### 5.2 与现有系统集成

* **PlanAgent集成**: 读取PlanAgent生成的任务计划

* **SharedMemoryManager集成**: 使用统一的记忆管理系统

* **MCP工具集成**: 调用现有的MCP工具服务

## 6. 配置和部署

### 6.1 环境变量

```bash
# 数据库配置
DATABASE_URL=postgresql://user:password@localhost:5432/database

# MCP服务器配置
MCP_TEST_SERVER_URL=http://localhost:8080/mcp
MCP_JSON_WRITER_COMMAND=tsx
MCP_JSON_WRITER_ARGS=./src/mcp-servers/json-writer-server.ts

# LLM配置
OPENAI_API_KEY=your_openai_api_key
LLM_MODEL=gpt-4
```

## 7. 使用示例

### 7.1 基本使用

```typescript
// 创建ExcuteTestAgent实例
const agent = new ExcuteTestAgent({
  llm: llmInstance,
  memoryManager: sharedMemoryManager
});

// 在LangGraph中使用
const workflow = new StateGraph(MessagesAnnotation)
  .addNode('execute_test', agent.ExcuteTestNode.bind(agent))
  .addEdge(START, 'execute_test')
  .addEdge('execute_test', END);
```

### 7.2 查询执行结果

```typescript
// 获取特定线程的执行结果
const results = await agent.memoryStore.getStoredResults(threadId);
console.log('执行结果:', results);
```

## 8. 关键特性

### 8.1 智能工具调用

* 通过LLM理解任务需求

* 自动选择合适的MCP工具

* 处理工具调用参数和结果

### 8.2 记忆系统集成

* 统一的PostgreSQL存储

* 结构化的命名空间管理

* 便于后续查询和分析

## 9. 总结

`ExcuteTestAgent` 是一个专注于MCP工具调用的轻量级代理，通过LLM智能理解和执行测试任务，将结果存储到PostgreSQL记忆系统中。该代理与现有的PlanAgent和SharedMemoryManager无缝集成，为自动化测试提供了强大的工具调用能力。

### 9.1 核心优势

* **智能化**: 通过LLM理解任务并选择合适工具

* **简洁性**: 专注于工具调用，避免复杂的状态管理

* **集成性**: 与现有系统完美集成

* **可扩展**: 支持各种MCP工具的调用

