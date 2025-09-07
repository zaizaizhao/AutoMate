import { LangGraphRunnableConfig, MessagesAnnotation } from "@langchain/langgraph";
import { AgentConfig, BaseAgent } from "src/app/BaseAgent/BaseAgent.js";
import { getTestServerTools } from "src/app/mcp-servers/mcp-client.js";
import { loadChatModel } from "src/app/ModelUtils/ChatModel.js";

export class ExcuteTestAgent extends BaseAgent{
    private llm: any;
    protected async initializellm() {
        this.llm = await loadChatModel("openai/deepseek-ai/DeepSeek-V3");
    }

    constructor(config: AgentConfig) {
        super(config);
    }

    async ExcuteTestNode(state: typeof MessagesAnnotation.State, config: LangGraphRunnableConfig){
        console.log("[ExcuteTestNode] config thread_id:", config?.configurable?.thread_id);

        // 确保LLM已初始化
        if (!this.llm) {
        console.log("[ExcuteTestNode] Initializing LLM...");
            await this.initializellm();
        }
        const tools = await getTestServerTools();
    }
    
    public buildGraph() {
        throw new Error("Method not implemented.");
    }
    
}