// agents/BaseAgent.ts
import { StateGraph } from '@langchain/langgraph';
import { Command, MessagesAnnotation } from "@langchain/langgraph";
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { MemoryNamespace, SharedMemoryManager } from '../Memory/SharedMemoryManager.js';

export interface AgentConfig {
  agentId: string;
  agentType: string;
  namespace: MemoryNamespace;
  llm: ChatOpenAI;
  memoryManager: SharedMemoryManager;
}

export abstract class BaseAgent {
  protected config: AgentConfig;
  protected graph: StateGraph<typeof MessagesAnnotation.State>;
  protected memoryManager: SharedMemoryManager;

  constructor(config: AgentConfig) {
    this.config = config;
    this.memoryManager = config.memoryManager;
    this.graph = this.buildGraph();
  }

  protected abstract buildGraph(): StateGraph<typeof MessagesAnnotation.State>;

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