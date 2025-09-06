import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { BaseAgent } from "../../BaseAgent/BaseAgent.js";

import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ConfigurationSchema } from "../../ModelUtils/Config.js";
import { RunnableConfig } from "@langchain/core/runnables";
import { loadChatModel } from "../../ModelUtils/index.js";
import { TOOL_MESSAGE_EXTRACT_PROMPT } from "./Prompts.js";
import { getTestServerTools } from "src/app/mcp-servers/mcp-client.js";

export class PlanAgent extends BaseAgent {
  private llm: any
  protected async initializellm() {
    this.llm = await loadChatModel("openai/deepseek-ai/DeepSeek-V3");
  }

  async planNode(state: typeof MessagesAnnotation.State, config: RunnableConfig) {
    //通过state.messages来获取传入的消息
    const lastMessage = state.messages[state.messages.length - 1];
    console.log("[PlanAgent] lastMessage:", lastMessage);

    // 确保LLM已初始化
    if (!this.llm) {
      console.log("[PlanAgent] Initializing LLM...");
      await this.initializellm();
    }
    const tools = await getTestServerTools();
    let systemPrompt = TOOL_MESSAGE_EXTRACT_PROMPT.replace(
      "{system_time}",
      new Date().toISOString(),
    )
    const llm = (await loadChatModel("openai/deepseek-ai/DeepSeek-V3")).bindTools(tools)
    try {
      const response = await llm.invoke([
        {
          role: "system",
          content: systemPrompt,
        },
        ...state.messages,
      ]);
      console.log("[PlanAgent] LLM response:", response);
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
