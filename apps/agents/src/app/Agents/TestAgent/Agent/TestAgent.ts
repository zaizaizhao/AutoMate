import { AIMessage } from "@langchain/core/messages";
import { END, LangGraphRunnableConfig, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AgentConfig, BaseAgent } from "src/app/BaseAgent/BaseAgent.js";
import { getTestServerTools } from "src/app/mcp-servers/mcp-client.js";
import { loadChatModel } from "src/app/ModelUtils/ChatModel.js";
import { buildSystemPrompt, buildToolInvocationUserPrompt } from "src/app/Agents/TestAgent/Prompts/Prompts.js";

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
        const toolCallingModel = this.llm.bindTools(tools);

        const threadId = (config?.configurable as any)?.thread_id ?? "default";
        const runtimeStore: any = (config as any)?.store ?? (this.memoryManager?.getStore?.() as any);
        const primaryStore: any = (this.memoryManager?.getStore?.() as any);
        const usingRuntimeStore = !!(runtimeStore && typeof runtimeStore.get === "function");

        // 与 PlanAgent 保持一致的命名空间，用于读取批次信息
        const nsPlans = [
            "plans",
            this.config.namespace.project,
            this.config.namespace.environment,
            this.config.namespace.agent_type,
            threadId,
        ];

        const batchMemKey = `planNode:${threadId}:toolBatch`;
        // 读取/初始化批次状态（优先使用 runtimeStore，其次回退到 SharedMemoryManager），并规范化返回
        const existingBatchStateRaw = usingRuntimeStore
            ? await runtimeStore.get(nsPlans, "toolBatch")
            : await this.getSharedMemory(batchMemKey);
        const existingBatchState = (existingBatchStateRaw && typeof existingBatchStateRaw === "object" && "value" in (existingBatchStateRaw as any))
            ? (existingBatchStateRaw as any).value
            : existingBatchStateRaw;
        console.log(`[ExecuteTestNode] Read batchState via ${usingRuntimeStore ? 'runtimeStore' : 'sharedMemory'} (normalized):`, existingBatchState);

        const batchIndex: number = existingBatchState?.batchIndex ?? 0; // 默认从0开始
        const totalBatches: number = existingBatchState?.totalBatches ?? 1;

        // 提前终止保护：如果已经在最后一批之后，直接结束，不再尝试执行任务
        if ((batchIndex ?? 0) >= (totalBatches ?? 0)) {
            console.log(`[ExecuteTestNode] All batches completed (batchIndex=${batchIndex}, totalBatches=${totalBatches}). Ending.`);
            return { messages: [new AIMessage({ content: `All batches completed (batchIndex=${batchIndex}, totalBatches=${totalBatches}).` })] };
        }

        // 从数据库读取当前批次的任务（PlanAgent 预先写入 task_plans）
        const tasks = await this.memoryManager.getTaskPlansByBatch(threadId, batchIndex);
        console.log(`[ExecuteTestNode] Loaded tasks for planId=${threadId}, batch=${batchIndex}: count=${tasks.length}`);

        // 执行进度（保存在 store 中）
        const nsExec = [
            "plans",
            this.config.namespace.project,
            this.config.namespace.environment,
            this.config.namespace.agent_type,
            threadId,
        ];
        let execProgressRaw = usingRuntimeStore ? await runtimeStore.get(nsExec, "executeProgress") : undefined;
        let execProgress = (execProgressRaw && typeof execProgressRaw === "object" && "value" in (execProgressRaw as any))
            ? (execProgressRaw as any).value
            : execProgressRaw;
        if (!execProgress || execProgress.batchIndex !== batchIndex) {
            execProgress = { batchIndex, taskIndex: 0 };
            // 双写到运行时和主存储，保证可见性
            if (usingRuntimeStore && typeof runtimeStore.put === "function") {
                await runtimeStore.put(nsExec, "executeProgress", execProgress);
            }
            if (primaryStore && typeof primaryStore.put === "function" && primaryStore !== runtimeStore) {
                await primaryStore.put(nsExec, "executeProgress", execProgress);
            }
        }

        // 如果上一轮工具已执行，持久化其结果到 PostgreSQL memory_store
        try {
            const msgs: any[] = state.messages as any[];
            const lastToolMsg = [...msgs].reverse().find((m: any) => m?.tool_call_id && (m?.name || m?.tool_name));
            if (lastToolMsg) {
                const lastAiWithCalls = [...msgs].reverse().find((m: any) => (m as any)?.tool_calls && (m as any)?.tool_calls.length > 0);
                const toolCall = lastAiWithCalls?.tool_calls?.find((tc: any) => tc?.id === lastToolMsg.tool_call_id);
                const usedArgs = toolCall?.args ?? {};
                const toolName = lastToolMsg.name || toolCall?.name || "unknown";
                // 当前已完成的任务索引：使用当前位置（不再预推进）
                const completedIndex = execProgress?.taskIndex ?? 0;
                const completedTask = tasks[completedIndex];

                const nsRes = [
                    "test-results",
                    this.config.namespace.project,
                    this.config.namespace.environment,
                    this.config.namespace.agent_type,
                    threadId,
                    `batch-${batchIndex}`,
                ];
                const key = completedTask?.taskId || `${toolName}-${Date.now()}`;
                const record: ToolCallResult = {
                    taskId: completedTask?.taskId || key,
                    toolName,
                    toolArgs: usedArgs,
                    result: lastToolMsg.content,
                    timestamp: new Date(),
                };
                if (primaryStore && typeof primaryStore.put === "function") {
                    await primaryStore.put(nsRes, key, record);
                    console.log(`[ExecuteTestNode] Stored tool result to primaryStore memory_store: ns=${JSON.stringify(nsRes)}, key=${key}`);
                }
                // 同步更新任务状态到数据库：根据内容判断成功/失败，并记录参数与结果
                if (completedTask?.taskId) {
                    try {
                        const c = lastToolMsg.content as any;
                        let isError = false;
                        if (c && typeof c === 'object') {
                            isError = Boolean((c as any).error) || (c as any).success === false;
                        } else if (typeof c === 'string') {
                            isError = /error|failed|exception|traceback/i.test(c);
                        }
                        const status = isError ? 'failed' : 'completed';
                        await this.memoryManager.updateTaskPlanStatus(
                            completedTask.taskId,
                            status,
                            { args: usedArgs, output: lastToolMsg.content },
                            isError ? (typeof c === 'string' ? c : JSON.stringify(c)) : undefined
                        );
                        console.log(`[ExecuteTestNode] Updated task status in DB: ${completedTask.taskId} -> ${status}`);
                    } catch (e) {
                        console.warn(`[ExecuteTestNode] Failed to update task status for ${completedTask?.taskId}:`, e);
                    }
                }

                // 工具结果已落库，推进执行指针到下一个任务
                const progressed = { ...execProgress, taskIndex: (execProgress?.taskIndex ?? 0) + 1 };
                if (usingRuntimeStore && typeof runtimeStore.put === "function") {
                    await runtimeStore.put(nsExec, "executeProgress", progressed);
                }
                if (primaryStore && typeof primaryStore.put === "function" && primaryStore !== runtimeStore) {
                    await primaryStore.put(nsExec, "executeProgress", progressed);
                }
                execProgress = progressed;
                console.log(`[ExecuteTestNode] Advanced executeProgress to taskIndex=${execProgress.taskIndex}`);
            }
        } catch (err) {
            console.warn("[ExecuteTestNode] Persisting tool result failed:", err);
        }

        // 无任务可执行时，结束本轮
        if (!tasks || tasks.length === 0) {
            return { messages: [new AIMessage({ content: `No tasks for current batch ${batchIndex}.` })] };
        }

        // 若本批次任务已全部执行，尝试推进到下一批（若存在），并重置进度
        if ((execProgress.taskIndex ?? 0) >= tasks.length) {
            const nextBatch = Math.min((batchIndex ?? 0) + 1, totalBatches);
            if (existingBatchState && nextBatch !== batchIndex) {
                const newState = { ...existingBatchState, batchIndex: nextBatch };
                if (usingRuntimeStore && typeof runtimeStore.put === "function") {
                    await runtimeStore.put(nsPlans, "toolBatch", newState);
                }
                if (primaryStore && typeof primaryStore.put === "function" && primaryStore !== runtimeStore) {
                    await primaryStore.put(nsPlans, "toolBatch", newState);
                }
                const newProgress = { batchIndex: nextBatch, taskIndex: 0 };
                if (usingRuntimeStore && typeof runtimeStore.put === "function") {
                    await runtimeStore.put(nsExec, "executeProgress", newProgress);
                }
                if (primaryStore && typeof primaryStore.put === "function" && primaryStore !== runtimeStore) {
                    await primaryStore.put(nsExec, "executeProgress", newProgress);
                }
                console.log(`[ExecuteTestNode] Batch ${batchIndex} completed. Advanced to next batch: ${nextBatch}.`);
                return { messages: [new AIMessage({ content: `Batch ${batchIndex} execution completed. Advanced to ${nextBatch}.` })] };
            }
            // 没有下一批，结束
            return { messages: [new AIMessage({ content: `Batch ${batchIndex} execution completed. No further batches.` })] };
        }

        // 选择下一个任务
        const task = tasks[execProgress.taskIndex];
        const toolName = (task as any)?.toolName || (task as any)?.tool_name;
        const toolDef: any = (tools as any[]).find((t: any) => t?.name === toolName || t?.toolName === toolName);
        if (!toolDef) {
            // 找不到工具则跳过该任务
            const skipped = { ...execProgress, taskIndex: execProgress.taskIndex + 1 };
            if (usingRuntimeStore && typeof runtimeStore.put === "function") {
                await runtimeStore.put(nsExec, "executeProgress", skipped);
            }
            if (primaryStore && typeof primaryStore.put === "function" && primaryStore !== runtimeStore) {
                await primaryStore.put(nsExec, "executeProgress", skipped);
            }
            // 更新任务状态为失败（工具不存在）
            if (task?.taskId) {
                try {
                    await this.memoryManager.updateTaskPlanStatus(task.taskId, 'failed', undefined, `Tool not found: ${toolName}`);
                    console.log(`[ExecuteTestNode] Task ${task.taskId} marked as failed: tool not found.`);
                } catch (e) {
                    console.warn(`[ExecuteTestNode] Failed to mark task ${task?.taskId} as failed:`, e);
                }
            }
            return { messages: [new AIMessage({ content: `Tool not found for task ${task?.taskId || "unknown"}, skipped.` })] };
        }

        const schema = toolDef?.schema ?? toolDef?.input_schema ?? toolDef?.parametersSchema;
        const suggestedParams = (task as any)?.parameters ?? {};

        // 将任务标记为运行中
        if ((task as any)?.taskId) {
            try {
                await this.memoryManager.updateTaskPlanStatus((task as any).taskId, 'running');
            } catch (e) {
                console.warn(`[ExecuteTestNode] Failed to mark task ${(task as any).taskId} as running:`, e);
            }
        }
 
         // 预先推进指针（工具执行完成后我们会持久化该次结果）
         const nextProgress = { ...execProgress, taskIndex: execProgress.taskIndex + 1 };
         if (usingRuntimeStore && typeof runtimeStore.put === "function") {
             await runtimeStore.put(nsExec, "executeProgress", nextProgress);
         }
         if (primaryStore && typeof primaryStore.put === "function" && primaryStore !== runtimeStore) {
             await primaryStore.put(nsExec, "executeProgress", nextProgress);
         }
 
         // 构造对 LLM 的指令，让其调用指定工具并生成/补全参数（需满足工具 schema）
        const userMsg = buildToolInvocationUserPrompt({
            taskId: (task as any)?.taskId,
            toolName,
            description: (task as any)?.description,
            suggestedParams,
            schema
        });

        const response = await toolCallingModel.invoke([
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: userMsg }
        ]);

        return { messages: [response] };
    }

    async toolsNode(_tools: any) {
        const tool = await getTestServerTools();
        return new ToolNode(tool)
    }

    routeModelOutput(state: typeof MessagesAnnotation.State): string {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1];
        // If the LLM is invoking tools, route there.
        if ((((lastMessage as AIMessage)?.tool_calls?.length) || 0) > 0) {
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
 
        return builder.compile({
            checkpointer: this.memoryManager.getCheckpointer(),
            store: this.memoryManager.getStore(),
            interruptBefore: [],
            interruptAfter: []
        });
    }

}