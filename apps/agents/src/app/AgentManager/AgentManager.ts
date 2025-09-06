// agents/MultiAgentCoordinator.ts
// import { SharedMemoryManager, MemoryNamespace } from '../memory/SharedMemoryManager';
// import { ResearchAgent, AnalysisAgent, SummaryAgent } from './CollaborativeAgents';
import { HumanMessage } from '@langchain/core/messages';
import { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { ConfigurableChatModelCallOptions, ConfigurableModel } from 'langchain/chat_models/universal';
import { PlanAgent } from '../Agents/PlanAgent.js';
import { MemoryNamespace, SharedMemoryManager } from '../Memory/SharedMemoryManager.js';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';

export interface CoordinatorConfig {
    modelName: string;
    //   memoryManager: SharedMemoryManager;
    //   namespace: MemoryNamespace;
    llm: ConfigurableModel<BaseLanguageModelInput, ConfigurableChatModelCallOptions>;
}

export class MultiAgentCoordinator {
    private memoryManager: SharedMemoryManager;
    private namespace: MemoryNamespace;
    // private llm: ConfigurableModel<BaseLanguageModelInput, ConfigurableChatModelCallOptions>;
    private agents: Map<string, any> = new Map();

    constructor() {
        // this.memoryManager = config.memoryManager;
        // this.namespace = config.namespace;

        // this.llm = config.llm;
        // this.initializeAgents();
    }

    public initializeAgents(): any {
        // 初始化研究Agent
        const planAgent = new PlanAgent({
            agentId: 'research-001',
            agentType: 'planAgent',
            namespace: { ...this.namespace, agent_type: 'planAgent' },
            // llm: this.llm,
            memoryManager: this.memoryManager
        });

        const planAgentNode = planAgent.buildGraph();
        const multiAgentGraph = new StateGraph(MessagesAnnotation)
            .addNode("plan-agent", planAgentNode)
            .addEdge(START, "plan-agent")
            .addEdge("plan-agent", END)
        // this.agents.set('research', planAgentNode);
        return multiAgentGraph

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

}