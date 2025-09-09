import { AIMessage } from "@langchain/core/messages";
import { END, LangGraphRunnableConfig, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AgentConfig, BaseAgent } from "../../../BaseAgent/BaseAgent.js";
import { getTestServerTools } from "../../../mcp-servers/mcp-client.js";
import { loadChatModel } from "../../../ModelUtils/ChatModel.js";
import { buildSystemPrompt, buildToolInvocationUserPrompt } from "../Prompts/Prompts.js";

// interface TaskPlanedForTest {
//     id: string;
//     plan_id: string;
//     task_name: string;
//     tool_name: string;
//     tool_args: Record<string, any>;
//     status: 'pending' | 'running' | 'completed' | 'failed';
//     created_at: Date;
//     updated_at: Date;
// }

interface ToolCallResult {
    taskId: string;
    toolName: string;
    toolArgs: Record<string, any>;
    result: any;
    timestamp: Date;
}

export class ExecuteTestAgent extends BaseAgent {
    private llm: any;
    // private lastThreadId: string | null = null;

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
        // 严格的图结构不会使用 primaryStore
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
        let existingBatchState = (existingBatchStateRaw && typeof existingBatchStateRaw === "object" && "value" in (existingBatchStateRaw as any))
            ? (existingBatchStateRaw as any).value
            : existingBatchStateRaw;
        console.log(`[ExecuteTestNode] Read batchState via ${usingRuntimeStore ? 'runtimeStore' : 'sharedMemory'} (normalized):`, existingBatchState);

        // 在第一次执行该线程时，将 PlanAgent 的批次记录重置为 0，避免一开始就处于完成状态
        // 判定“第一次执行”：内存中尚无 executeProgress 记录
        const nsExecReset = [
            "plans",
            this.config.namespace.project,
            this.config.namespace.environment,
            this.config.namespace.agent_type,
            threadId,
        ];
        let execProgressProbeRaw = usingRuntimeStore ? await runtimeStore.get(nsExecReset, "executeProgress") : undefined;
        let execProgressProbe = (execProgressProbeRaw && typeof execProgressProbeRaw === "object" && "value" in (execProgressProbeRaw as any))
            ? (execProgressProbeRaw as any).value
            : execProgressProbeRaw;
        const isFirstExecution = !execProgressProbe;
        if (existingBatchState && isFirstExecution) {
            try {
                const toolsPerBatch = existingBatchState?.toolsPerBatch ?? 5;
                const totalTools = existingBatchState?.totalTools ?? 0;
                const totalBatches = existingBatchState?.totalBatches ?? (Math.ceil(totalTools / toolsPerBatch) || 1);
                const resetState = {
                    batchIndex: 0,
                    toolsPerBatch,
                    totalTools,
                    totalBatches,
                };
                if (usingRuntimeStore && typeof runtimeStore.put === "function") {
                    await runtimeStore.put(nsPlans, "toolBatch", resetState);
                }
                if (primaryStore && typeof primaryStore.put === "function" && primaryStore !== runtimeStore) {
                    await primaryStore.put(nsPlans, "toolBatch", resetState);
                }
                // 初始化执行进度为第0批第0个任务
                const initProgress = { batchIndex: 0, taskIndex: 0 };
                if (usingRuntimeStore && typeof runtimeStore.put === "function") {
                    await runtimeStore.put(nsExecReset, "executeProgress", initProgress);
                }
                if (primaryStore && typeof primaryStore.put === "function" && primaryStore !== runtimeStore) {
                    await primaryStore.put(nsExecReset, "executeProgress", initProgress);
                }
                existingBatchState = resetState;
                console.log("[ExecuteTestNode] Detected first execution for this thread. Reset toolBatch to batchIndex=0 and initialized executeProgress.");
            } catch (e) {
                console.warn("[ExecuteTestNode] Failed to reset batchState on first execution:", e);
            }
        }

        let batchIndex: number = existingBatchState?.batchIndex ?? 0; // 默认从0开始
        let totalBatches: number = existingBatchState?.totalBatches ?? 1;

        // 提前终止保护：如果已经在最后一批之后，直接结束，不再尝试执行任务
        if ((batchIndex ?? 0) >= (totalBatches ?? 0)) {
            console.log(`[ExecuteTestNode] All batches completed (batchIndex=${batchIndex}, totalBatches=${totalBatches}). Ending.`);
            return { messages: [new AIMessage({ content: `All batches completed (batchIndex=${batchIndex}, totalBatches=${totalBatches}).` })] };
        }

        // 从数据库读取当前批次的任务（PlanAgent 预先写入 task_plans）
        let tasks = await this.memoryManager.getTaskPlansByBatch(threadId, batchIndex);
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
        let execProgress = (execProgressRaw && typeof execProgressRaw === "object" && ("value" in (execProgressRaw as any)))
            ? (execProgressRaw as any).value
            : execProgressRaw ?? undefined;
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
                // 更新测试结果到task_test表（使用已存在的testId）
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
                        
                        // 从执行进度中获取当前测试的testId
                        const currentTestId = (execProgress as any)?.currentTestId;
                        
                        if (currentTestId) {
                            // 更新已存在的测试记录
                            await this.memoryManager.updateTaskTestStatus(
                                currentTestId,
                                status,
                                { output: lastToolMsg.content },
                                isError ? (typeof c === 'string' ? c : JSON.stringify(c)) : undefined
                            );
                            console.log(`[ExecuteTestNode] Updated test result: ${currentTestId} with status: ${status}`);
                        } else {
                            // 如果没有找到testId，创建新记录（兼容性处理）
                            const testResult = {
                                testId: `test_${completedTask.taskId}_${Date.now()}`,
                                taskId: completedTask.taskId,
                                threadId: threadId,
                                toolName: toolName,
                                testData: usedArgs,
                                testResult: { output: lastToolMsg.content },
                                status: status as 'completed' | 'failed',
                                errorMessage: isError ? (typeof c === 'string' ? c : JSON.stringify(c)) : undefined,
                                createdAt: new Date(),
                                updatedAt: new Date(),
                                completedAt: new Date()
                            };
                            
                            await this.memoryManager.saveTaskTest(testResult);
                            console.log(`[ExecuteTestNode] Created new test result (fallback): ${testResult.testId}`);
                        }
                        
                        // 处理多条测试数据的情况（如果工具返回多个结果）
                        if (c && typeof c === 'object') {
                            let additionalResults: any[] = [];
                            
                            if (Array.isArray(c.testData)) {
                                additionalResults = c.testData.slice(1).map((data: any, index: number) => ({
                                    testId: `test_${completedTask.taskId}_${Date.now()}_${index + 1}`,
                                    taskId: completedTask.taskId,
                                    threadId: threadId,
                                    toolName: toolName,
                                    testData: data.input || data,
                                    testResult: { output: data.output || data.result || data },
                                    status: (data.error || data.failed) ? 'failed' : 'completed',
                                    errorMessage: data.error || data.errorMessage,
                                    createdAt: new Date(),
                                    updatedAt: new Date(),
                                    completedAt: new Date()
                                }));
                            } else if (Array.isArray(c.results) && c.results.length > 1) {
                                additionalResults = c.results.slice(1).map((result: any, index: number) => ({
                                    testId: `test_${completedTask.taskId}_${Date.now()}_${index + 1}`,
                                    taskId: completedTask.taskId,
                                    threadId: threadId,
                                    toolName: toolName,
                                    testData: usedArgs,
                                    testResult: { output: result },
                                    status: (result.error || result.failed) ? 'failed' : 'completed',
                                    errorMessage: result.error || result.errorMessage,
                                    createdAt: new Date(),
                                    updatedAt: new Date(),
                                    completedAt: new Date()
                                }));
                            }
                            
                            if (additionalResults.length > 0) {
                                await this.memoryManager.saveTaskTestBatch(additionalResults);
                                console.log(`[ExecuteTestNode] Saved ${additionalResults.length} additional test results for task ${completedTask.taskId}`);
                            }
                        }
                    } catch (e) {
                        console.warn(`[ExecuteTestNode] Failed to update test result for ${completedTask?.taskId}:`, e);
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
                
                // 重新加载新批次的任务列表并继续执行
                const newTasks = await this.memoryManager.getTaskPlansByBatch(threadId, nextBatch);
                
                if (!newTasks || newTasks.length === 0) {
                    return { messages: [new AIMessage({ content: `No tasks for new batch ${nextBatch}.` })] };
                }
                
                // 更新当前状态变量以继续执行新批次
                batchIndex = nextBatch;
                tasks = newTasks;
                execProgress = newProgress;
                
                console.log(`[ExecuteTestNode] Continuing with first task of batch ${nextBatch}.`);
                // 继续执行，不返回，让代码流继续到任务选择逻辑
            } else {
                // 没有下一批，结束
                return { messages: [new AIMessage({ content: `Batch ${batchIndex} execution completed. No further batches.` })] };
            }
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
            // 保存工具不存在的测试结果
            if (task?.taskId) {
                try {
                    const testResult = {
                        testId: `test_${task.taskId}_${Date.now()}`,
                        taskId: task.taskId,
                        threadId: threadId,
                        toolName: toolName,
                        testData: {},
                        testResult: { error: `Tool not found: ${toolName}` },
                        status: 'failed' as const,
                        errorMessage: `Tool not found: ${toolName}`,
                        createdAt: new Date(),
                        updatedAt: new Date()
                    };
                    
                    await this.memoryManager.saveTaskTest(testResult);
                    console.log(`[ExecuteTestNode] Saved failed test result for tool not found: ${testResult.testId}`);
                } catch (e) {
                    console.warn(`[ExecuteTestNode] Failed to save test result for ${task?.taskId}:`, e);
                }
            }
            return { messages: [new AIMessage({ content: `Tool not found for task ${task?.taskId || "unknown"}, skipped.` })] };
        }

        const schema = toolDef?.schema ?? toolDef?.input_schema ?? toolDef?.parametersSchema;
        const suggestedParams = (task as any)?.parameters ?? {};

        // 创建运行中的测试记录，并保存testId到执行进度中
        let currentTestId: string | undefined;
        if ((task as any)?.taskId) {
            try {
                currentTestId = `test_${(task as any).taskId}_${Date.now()}`;
                const testResult = {
                    testId: currentTestId,
                    taskId: (task as any).taskId,
                    threadId: threadId,
                    toolName: toolName,
                    testData: suggestedParams,
                    status: 'running' as const,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    startedAt: new Date()
                };
                
                await this.memoryManager.saveTaskTest(testResult);
                console.log(`[ExecuteTestNode] Created running test record: ${testResult.testId}`);
                
                // 将testId保存到执行进度中，以便后续更新使用
                const progressWithTestId = { ...execProgress, currentTestId };
                if (usingRuntimeStore && typeof runtimeStore.put === "function") {
                    await runtimeStore.put(nsExec, "executeProgress", progressWithTestId);
                }
                if (primaryStore && typeof primaryStore.put === "function" && primaryStore !== runtimeStore) {
                    await primaryStore.put(nsExec, "executeProgress", progressWithTestId);
                }
            } catch (e) {
                console.warn(`[ExecuteTestNode] Failed to create running test record for ${(task as any).taskId}:`, e);
            }
        }

        // 注意：不在此处预推进任务指针，避免一次工具执行推进两次。
        // 指针在下一轮（持久化工具结果后）再前移。

        // 构造对 LLM 的指令，让其调用指定工具并生成/补全参数（需满足工具 schema）
        const userMsg = buildToolInvocationUserPrompt({
            taskId: (task as any)?.taskId,
            toolName,
            schema,
            suggestedParams,
        });

        const response = await toolCallingModel.invoke([
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: userMsg }
        ]);
        

        return { messages: [response] };
    }

    async toolsNode(state: typeof MessagesAnnotation.State, config: LangGraphRunnableConfig) {
        const tools = await getTestServerTools();
        
        // 处理DeepSeek-V3模型产生的格式问题
        const messages = [...state.messages] as any[];
        const lastMessage = messages[messages.length - 1] as AIMessage | any;
        
        // 检查是否有invalid_tool_calls需要清理
        if (lastMessage?.invalid_tool_calls && Array.isArray(lastMessage.invalid_tool_calls) && lastMessage.invalid_tool_calls.length > 0) {
            console.log("[toolsNode] Found invalid_tool_calls, attempting to clean:", lastMessage.invalid_tool_calls);
            
            const cleanedToolCalls: any[] = [];
            
            for (const invalidCall of lastMessage.invalid_tool_calls) {
                try {
                    // 清理参数中的markdown格式
                    let cleanedArgs = invalidCall.args;
                    if (typeof cleanedArgs === 'string') {
                        // 移除markdown代码块格式
                        cleanedArgs = cleanedArgs
                            .replace(/^```[\w]*\n?/gm, '') // 移除开始的```
                            .replace(/\n?```$/gm, '')      // 移除结尾的```
                            .replace(/^`+|`+$/g, '')      // 移除单独的反引号
                            .trim();                       // 移除首尾空白
                        
                        // 尝试解析为JSON
                        try {
                            cleanedArgs = JSON.parse(cleanedArgs);
                        } catch (parseError) {
                            console.warn("[toolsNode] Failed to parse cleaned args as JSON:", cleanedArgs, parseError);
                            continue;
                        }
                    }
                    
                    // 构造清理后的工具调用
                    const cleanedCall = {
                        id: invalidCall.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        name: invalidCall.name,
                        args: cleanedArgs
                    };
                    
                    cleanedToolCalls.push(cleanedCall);
                    console.log("[toolsNode] Successfully cleaned tool call:", cleanedCall);
                } catch (error) {
                    console.warn("[toolsNode] Failed to clean invalid tool call:", invalidCall, error);
                }
            }
            
            // 如果成功清理了工具调用，更新消息
            if (cleanedToolCalls.length > 0) {
                // 确保消息是正确的AIMessage格式
                const updatedMessage = new AIMessage({
                    content: lastMessage.content || "",
                    tool_calls: cleanedToolCalls,
                    additional_kwargs: {
                        ...lastMessage.additional_kwargs,
                        invalid_tool_calls: [] // 清空invalid_tool_calls
                    }
                });
                messages[messages.length - 1] = updatedMessage;
                console.log("[toolsNode] Updated message with cleaned tool calls:", cleanedToolCalls.length);
            }
        }
        
        // 确保所有消息都是正确的LangChain消息格式
        const validMessages = messages.map((msg: any) => {
            if (msg instanceof AIMessage) {
                return msg;
            }
            // 如果不是AIMessage实例，尝试转换
            if (msg && typeof msg === 'object') {
                return new AIMessage({
                    content: msg.content || "",
                    tool_calls: msg.tool_calls || [],
                    additional_kwargs: msg.additional_kwargs || {}
                });
            }
            return msg;
        });
        
        const node = new ToolNode(tools as any);
        return node.invoke({ ...state, messages: validMessages } as any, config as any);
    }

    routeModelOutput(state: typeof MessagesAnnotation.State): "execute-tool-node" | typeof END {
        const messages = state.messages as any[];
        const lastMessage = messages[messages.length - 1] as AIMessage | any;
        
        // 检查正常的工具调用
        const toolCalls = (lastMessage as any)?.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            return "execute-tool-node";
        }
        
        // 检查格式错误的工具调用（DeepSeek-V3可能产生）
        const invalidToolCalls = (lastMessage as any)?.invalid_tool_calls;
        if (Array.isArray(invalidToolCalls) && invalidToolCalls.length > 0) {
            console.log("[routeModelOutput] Found invalid_tool_calls, routing to tool execution for cleanup:", invalidToolCalls.length);
            return "execute-tool-node";
        }
        
        // 检查工具调用片段
        const toolCallChunks = (lastMessage as any)?.tool_call_chunks;
        if (Array.isArray(toolCallChunks) && toolCallChunks.length > 0) {
            console.log("[routeModelOutput] Found tool_call_chunks, routing to tool execution:", toolCallChunks.length);
            return "execute-tool-node";
        }
        
        // 没有任何工具调用意图，视为本轮可结束
        return END;
    }

    public buildGraph() {
        return new StateGraph(MessagesAnnotation)
            .addNode("execute-test-node", this.ExecuteTestNode.bind(this))
            .addNode("execute-tool-node", this.toolsNode.bind(this))
            .addEdge(START, "execute-test-node")
            .addConditionalEdges(
                "execute-test-node",
                this.routeModelOutput.bind(this),
                ["execute-tool-node", END]
            )
            .addEdge("execute-tool-node", "execute-test-node")
            .compile({
                checkpointer: this.memoryManager.getCheckpointer(),
                store: this.memoryManager.getStore(),
                interruptBefore: [],
                interruptAfter: []
            });
    }

}