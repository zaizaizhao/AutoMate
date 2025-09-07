import { AIMessage } from "@langchain/core/messages";
import { END, LangGraphRunnableConfig, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AgentConfig, BaseAgent } from "src/app/BaseAgent/BaseAgent.js";
import { getTestServerTools } from "src/app/mcp-servers/mcp-client.js";
import { loadChatModel } from "src/app/ModelUtils/ChatModel.js";

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

interface ToolCallResult {
    taskId: string;
    toolName: string;
    toolArgs: Record<string, any>;
    result: any;
    timestamp: Date;
}

export class ExecuteTestAgent extends BaseAgent {
    private llm: any;
    private lastThreadId: string | null = null;

    protected async initializellm() {
        this.llm = await loadChatModel("openai/deepseek-ai/DeepSeek-V3");
    }

    constructor(config: AgentConfig) {
        super(config);
    }

    async ExecuteTestNode(state: typeof MessagesAnnotation.State, config: LangGraphRunnableConfig) {
        console.log("[ExcuteTestNode] config thread_id:", config?.configurable?.thread_id);

        // 确保LLM已初始化
        if (!this.llm) {
            console.log("[ExcuteTestNode] Initializing LLM...");
            await this.initializellm();
        }
        const tools = await getTestServerTools();

        const threadId = (config?.configurable as any)?.thread_id ?? "default";
        const store: any = (config as any)?.store ?? (this.memoryManager?.getStore?.() as any);
        const usingStore = !!(store && typeof store.get === "function");
        const ns = [
            "test",
            this.config.namespace.project,
            this.config.namespace.environment,
            this.config.namespace.agent_type,
            threadId,
        ];

        const batchMemKey = `planNode:${threadId}:toolBatch`;
        // 读取/初始化批次状态（优先使用 store，其次回退到 SharedMemoryManager），并规范化 store.get 返回的记录格式
        const existingBatchStateRaw = usingStore
            ? await store.get(ns, "toolBatch")
            : await this.getSharedMemory(batchMemKey);
        const existingBatchState = (existingBatchStateRaw && typeof existingBatchStateRaw === "object" && "value" in (existingBatchStateRaw as any))
            ? (existingBatchStateRaw as any).value
            : existingBatchStateRaw;
        console.log(`[PlanAgent] Read batchState via ${usingStore ? 'store' : 'sharedMemory'} (normalized):`, existingBatchState);
        const toolsPerBatch = existingBatchState?.toolsPerBatch ?? 5;
        const totalTools = tools.length;
        const totalBatches = Math.ceil(totalTools / toolsPerBatch);
        const batchIndex = existingBatchState?.batchIndex ?? 0; // 从 0 开始
        const startIndex = batchIndex * toolsPerBatch;
        const endIndex = startIndex + toolsPerBatch;
        return { messages: [new AIMessage({ content: "testAiAgent调用" })] };
    }

    async toolsNode(_tools: any) {
        const tool = await getTestServerTools();
        return new ToolNode(tool)
    }

    routeModelOutput(state: typeof MessagesAnnotation.State): string {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1];
        // If the LLM is invoking tools, route there.
        if ((lastMessage as AIMessage)?.tool_calls?.length || 0 > 0) {
            return "execute-tool-node";
        }
        // Otherwise end the graph.
        else {
            return "__end__";
        }
    }

    public buildGraph() {
        const builder = new StateGraph(MessagesAnnotation)
            .addNode("excute-test-node", this.ExecuteTestNode.bind(this))
            .addNode("execute-tool-node", this.toolsNode.bind(this))
            .addEdge(START, "excute-test-node")
            .addConditionalEdges(
                "excute-test-node",
                // Next, we pass in the function that will determine the sink node(s), which
                // will be called after the source node is called.
                this.routeModelOutput,
            )
            .addEdge("execute-tool-node","excute-test-node")
            .addEdge("excute-test-node", END)

        return builder.compile({
            checkpointer: this.memoryManager.getCheckpointer(),
            store: this.memoryManager.getStore(),
            interruptBefore: [],
            interruptAfter: []
        });
    }

}