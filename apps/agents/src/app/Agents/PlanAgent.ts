import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { BaseAgent } from "../BaseAgent/BaseAgent.js";

import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ConfigurationSchema } from "../ModelUtils/Config.js";
import { RunnableConfig } from "@langchain/core/runnables";
import { loadChatModel } from "../ModelUtils/index.js";

export class PlanAgent extends BaseAgent {
  private llm :any
  protected async initializellm() {
    this.llm = await loadChatModel("openai/deepseek-ai/DeepSeek-V3"); 
  }
  
  async planNode(state: typeof MessagesAnnotation.State, config: RunnableConfig) {
      console.log("[PlanAgent] planNode started");
      console.log("[PlanAgent] state.messages:", state.messages);
      
      const lastMessage = state.messages[state.messages.length - 1];
      console.log("[PlanAgent] lastMessage:", lastMessage);
      
      // 确保LLM已初始化
      if (!this.llm) {
        console.log("[PlanAgent] Initializing LLM...");
        await this.initializellm();
      }
      console.log("this is this",this);
      
      console.log("[PlanAgent] LLM initialized:", !!this.llm);
      const llm = await loadChatModel("openai/deepseek-ai/DeepSeek-V3")
      try {
        const response = await llm.invoke([
          new SystemMessage('你是一个专业的研究助手，负责收集和分析信息。'),
          new HumanMessage("请提供研究分析")
        ]);
        
        console.log("[PlanAgent] LLM response:", response);
        
        // 保存研究结果到共享记忆
        // const newResearch = {
        //   timestamp: new Date().toISOString(),
        //   query: lastMessage.content,
        //   findings: response.content,
        //   agent_id: this.config?.agentId || 'plan-agent'
        // };
        
        console.log("[PlanAgent] Returning messages:", [response]);
        
        return {
          messages: [response]
        };
      } catch (error) {
        console.error("[PlanAgent] Error in planNode:", error);
        
        // 返回错误消息
        const errorMessage = new AIMessage({
          content: `执行出错: ${error}`
        });
        
        return {
          messages: [errorMessage]
        };
      }
    }

  public buildGraph() {
    console.log("[PlanAgent] Building graph...");
    // 计划节点
    const workflow = new StateGraph(MessagesAnnotation, ConfigurationSchema)
      .addNode("plan-node", this.planNode.bind(this))
      .addEdge(START, "plan-node")
      .addEdge("plan-node", END);
    
    console.log("[PlanAgent] Graph built successfully");
    return workflow.compile();
  }
}
