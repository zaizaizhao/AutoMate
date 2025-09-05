import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { BaseAgent } from "../BaseAgent/BaseAgent.js";

import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ConfigurationSchema } from "../ModelUtils/Config.js";

export class PlanAgent extends BaseAgent {
  protected buildGraph(): StateGraph<typeof MessagesAnnotation.State,typeof ConfigurationSchema.State> {
    // 计划节点
    const planNode = async (state: typeof MessagesAnnotation.State) => {    
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

    const workflow = new StateGraph(MessagesAnnotation,ConfigurationSchema)
   .addNode("plan-node", planNode)
   .addEdge(START, "plan-node")
   .addEdge("plan-node", END)
   return workflow;
  }
}