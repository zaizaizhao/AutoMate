import { AIMessage, BaseMessage } from "@langchain/core/messages";
import {
  END,
  LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { createReactAgent, ToolNode } from "@langchain/langgraph/prebuilt";
import { AgentConfig, BaseAgent } from "../../../BaseAgent/BaseAgent.js";
import { getPostgresqlHubTools, getTestServerTools } from "../../../mcp-servers/mcp-client.js";
import { loadChatModel } from "../../../ModelUtils/ChatModel.js";
import {
  buildSystemPrompt,
  buildToolInvocationUserPrompt,
} from "../Prompts/Prompts.js";
import { evaluationOutputSchema } from "../OutPutStructure/StructuredOutPutSchema.js";
import { formatEvaluationPrompt } from "../Prompts/EvaluatePrompt.js";


export class ExecuteTestAgent extends BaseAgent {
  private llm: any;
  // private lastThreadId: string | null = null;

  protected async initializellm() {
    this.llm = await loadChatModel("openai/moonshotai/Kimi-K2-Instruct");
  }

  constructor(config: AgentConfig) {
    super(config);
  }

  async ExecuteTestNode(
    _state: typeof MessagesAnnotation.State,
    config: LangGraphRunnableConfig
  ) {
    console.log(
      "[ExcuteTestNode] config thread_id:",
      config?.configurable?.thread_id
    );

    // 确保LLM已初始化
    if (!this.llm) {
      console.log("[ExcuteTestNode] Initializing LLM...");
      await this.initializellm();
    }
    const tools = await getTestServerTools();
    const toolCallingModel = this.llm.bindTools(tools);

    const threadId = (config?.configurable as any)?.thread_id ?? "default";
    // Prefer runtime store unless it's the CLI-injected InMemory AsyncBatchedStore, or env forces shared memory
    const candidateStore: any = (config as any)?.store;
    const candidateType = candidateStore?.constructor?.name;
    const underlyingType = candidateStore?.store?.constructor?.name;
    const isAsyncBatchedInMemory =
      candidateType === "AsyncBatchedStore" && underlyingType === "InMemoryStore";
    const forceShared =
      (process.env.FORCE_SHARED_MEMORY ?? process.env.USE_SHARED_STORE ?? "")
        .toString() === "1";
    const runtimeStore: any =
      !candidateStore || isAsyncBatchedInMemory || forceShared
        ? undefined
        : candidateStore;
    const usingRuntimeStore = !!(
      runtimeStore && typeof runtimeStore.get === "function"
    );
    console.log("[ExecuteTestNode] Store debug:", {
      hasStore: !!candidateStore,
      hasGet: !!(candidateStore && typeof candidateStore.get === "function"),
      hasPut: !!(candidateStore && typeof candidateStore.put === "function"),
      storeType: candidateType,
      underlyingStoreType: underlyingType,
      usingRuntimeStore,
      decision: runtimeStore
        ? "use runtime store"
        : isAsyncBatchedInMemory
        ? "ignore AsyncBatchedStore(InMemory) -> use shared memory"
        : forceShared
        ? "env forced shared memory"
        : "no store provided",
    });

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
    let existingBatchState =
      existingBatchStateRaw &&
      typeof existingBatchStateRaw === "object" &&
      "value" in (existingBatchStateRaw as any)
        ? (existingBatchStateRaw as any).value
        : existingBatchStateRaw;
    console.log(
      `[ExecuteTestNode] Read batchState via ${usingRuntimeStore ? "runtimeStore" : "sharedMemory"} (normalized):`,
      existingBatchState
    );

    // 在第一次执行该线程时，将 PlanAgent 的批次记录重置为 0，避免一开始就处于完成状态
    // 判定“第一次执行”：内存中尚无 executeProgress 记录
    const nsExecReset = [
      "plans",
      this.config.namespace.project,
      this.config.namespace.environment,
      this.config.namespace.agent_type,
      threadId,
    ];
    const execMemKey = `executeNode:${threadId}:executeProgress`;
    let execProgressProbeRaw = usingRuntimeStore
      ? await runtimeStore.get(nsExecReset, "executeProgress")
      : await this.getSharedMemory(execMemKey);
    let execProgressProbe =
      execProgressProbeRaw &&
      typeof execProgressProbeRaw === "object" &&
      "value" in (execProgressProbeRaw as any)
        ? (execProgressProbeRaw as any).value
        : execProgressProbeRaw;
    const isFirstExecution = !execProgressProbe;
    if (existingBatchState && isFirstExecution) {
      try {
        const toolsPerBatch = existingBatchState?.toolsPerBatch ?? 5;
        const totalTools = existingBatchState?.totalTools ?? 0;
        const totalBatches =
          existingBatchState?.totalBatches ??
          (Math.ceil(totalTools / toolsPerBatch) || 1);
        const resetState = {
          batchIndex: 0,
          toolsPerBatch,
          totalTools,
          totalBatches,
        };
        if (usingRuntimeStore && typeof runtimeStore.put === "function") {
          await runtimeStore.put(nsPlans, "toolBatch", resetState);
        } else {
          await this.saveSharedMemory(batchMemKey, resetState);
        }
        // 初始化执行进度为第0批第0个任务
        const initProgress = { batchIndex: 0, taskIndex: 0 };
        if (usingRuntimeStore && typeof runtimeStore.put === "function") {
          await runtimeStore.put(nsExecReset, "executeProgress", initProgress);
        } else {
          await this.saveSharedMemory(execMemKey, initProgress);
        }
        existingBatchState = resetState;
        console.log(
          "[ExecuteTestNode] Detected first execution for this thread. Reset toolBatch to batchIndex=0 and initialized executeProgress."
        );
      } catch (e) {
        console.warn(
          "[ExecuteTestNode] Failed to reset batchState on first execution:",
          e
        );
      }
    }

    let batchIndex: number = existingBatchState?.batchIndex ?? 0; // 默认从0开始
    let totalBatches: number = existingBatchState?.totalBatches ?? 1;

    // 提前终止保护：如果已经在最后一批之后，直接结束，不再尝试执行任务
    if ((batchIndex ?? 0) >= (totalBatches ?? 0)) {
      console.log(
        `[ExecuteTestNode] All batches completed (batchIndex=${batchIndex}, totalBatches=${totalBatches}). Ending.`
      );
      return {
        messages: [
          new AIMessage({
            content: `All batches completed (batchIndex=${batchIndex}, totalBatches=${totalBatches}).`,
          }),
        ],
      };
    }

    // 从数据库读取当前批次的任务（PlanAgent 预先写入 task_plans）
    let tasks = await this.memoryManager.getTaskPlansByBatch(
      threadId,
      batchIndex
    );
    console.log(
      `[ExecuteTestNode] Loaded tasks for planId=${threadId}, batch=${batchIndex}: count=${tasks.length}`
    );

    // 执行进度（保存在 store 中）
    const nsExec = [
      "plans",
      this.config.namespace.project,
      this.config.namespace.environment,
      this.config.namespace.agent_type,
      threadId,
    ];
    let execProgressRaw = usingRuntimeStore
      ? await runtimeStore.get(nsExec, "executeProgress")
      : await this.getSharedMemory(execMemKey);
    let execProgress =
      execProgressRaw &&
      typeof execProgressRaw === "object" &&
      "value" in (execProgressRaw as any)
        ? (execProgressRaw as any).value
        : (execProgressRaw ?? undefined);
    if (!execProgress || execProgress.batchIndex !== batchIndex) {
      execProgress = { batchIndex, taskIndex: 0 };
      // 保存到运行时存储或共享内存
      if (usingRuntimeStore && typeof runtimeStore.put === "function") {
        await runtimeStore.put(nsExec, "executeProgress", execProgress);
      } else {
        await this.saveSharedMemory(execMemKey, execProgress);
      }
    }

    // 无任务可执行时，结束本轮
    if (!tasks || tasks.length === 0) {
      return {
        messages: [
          new AIMessage({
            content: `No tasks for current batch ${batchIndex}.`,
          }),
        ],
      };
    }

    // 若本批次任务已全部执行，尝试推进到下一批（若存在），并重置进度
    if ((execProgress.taskIndex ?? 0) >= tasks.length) {
      console.log(
        `[ExecuteTestNode] *** BATCH COMPLETION CHECK *** Current batch ${batchIndex} has ${tasks.length} tasks, taskIndex=${execProgress.taskIndex}. All tasks completed.`
      );
      
      const nextBatch = Math.min((batchIndex ?? 0) + 1, totalBatches);
      if (existingBatchState && nextBatch !== batchIndex) {
        const newState = { ...existingBatchState, batchIndex: nextBatch };
        if (usingRuntimeStore && typeof runtimeStore.put === "function") {
          await runtimeStore.put(nsPlans, "toolBatch", newState);
        } else {
          await this.saveSharedMemory(batchMemKey, newState);
        }
        const newProgress = { batchIndex: nextBatch, taskIndex: 0 };
        if (usingRuntimeStore && typeof runtimeStore.put === "function") {
          await runtimeStore.put(nsExec, "executeProgress", newProgress);
        } else {
          await this.saveSharedMemory(execMemKey, newProgress);
        }
        console.log(
          `[ExecuteTestNode] Batch ${batchIndex} completed. Advanced to next batch: ${nextBatch}.`
        );

        // 重新加载新批次的任务列表并继续执行
        const newTasks = await this.memoryManager.getTaskPlansByBatch(
          threadId,
          nextBatch
        );

        if (!newTasks || newTasks.length === 0) {
          console.log(
            `[ExecuteTestNode] *** ALL BATCHES COMPLETED *** No tasks found for batch ${nextBatch}. Execution finished.`
          );
          return {
            messages: [
              new AIMessage({
                content: `No tasks for new batch ${nextBatch}.`,
              }),
            ],
          };
        }

        // 更新当前状态变量以继续执行新批次
        batchIndex = nextBatch;
        tasks = newTasks;
        execProgress = newProgress;

        console.log(
          `[ExecuteTestNode] Continuing with first task of batch ${nextBatch}.`
        );
        // 继续执行，不返回，让代码流继续到任务选择逻辑
      } else {
        // 没有下一批，结束
        console.log(
          `[ExecuteTestNode] *** ALL BATCHES COMPLETED *** Batch ${batchIndex} was the final batch. Total batches: ${totalBatches}. Execution finished.`
        );
        return {
          messages: [
            new AIMessage({
              content: `Batch ${batchIndex} execution completed. No further batches.`,
            }),
          ],
        };
      }
    }

    // 选择下一个任务
    const task = tasks[execProgress.taskIndex];
    const toolName = (task as any)?.toolName || (task as any)?.tool_name;
    const isLastTaskInCurrentBatch = execProgress.taskIndex >= tasks.length - 1;
    
    console.log(
      `[ExecuteTestNode] *** TASK SELECTION *** Executing task ${execProgress.taskIndex}/${tasks.length - 1} in batch ${batchIndex}. Tool: ${toolName}. IsLastTask: ${isLastTaskInCurrentBatch}`
    );
    const toolDef: any = (tools as any[]).find(
      (t: any) => t?.name === toolName || t?.toolName === toolName
    );
    if (!toolDef) {
      // 找不到工具则跳过该任务
      const skipped = {
        ...execProgress,
        taskIndex: execProgress.taskIndex + 1,
      };
      if (usingRuntimeStore && typeof runtimeStore.put === "function") {
        await runtimeStore.put(nsExec, "executeProgress", skipped);
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
            status: "failed" as const,
            errorMessage: `Tool not found: ${toolName}`,
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          await this.memoryManager.saveTaskTest(testResult);
          console.log(
            `[ExecuteTestNode] Saved failed test result for tool not found: ${testResult.testId}`
          );
        } catch (e) {
          console.warn(
            `[ExecuteTestNode] Failed to save test result for ${task?.taskId}:`,
            e
          );
        }
      }
      return {
        messages: [
          new AIMessage({
            content: `Tool not found for task ${task?.taskId || "unknown"}, skipped.`,
          }),
        ],
      };
    }

    const schema =
      toolDef?.schema ?? toolDef?.input_schema ?? toolDef?.parametersSchema;
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
          status: "running" as const,
          createdAt: new Date(),
          updatedAt: new Date(),
          startedAt: new Date(),
        };

        await this.memoryManager.saveTaskTest(testResult);
        console.log(
          `[ExecuteTestNode] Created running test record: ${testResult.testId}`
        );

        // 将testId保存到执行进度中，以便后续更新使用
        const progressWithTestId = { ...execProgress, currentTestId };
        if (usingRuntimeStore && typeof runtimeStore.put === "function") {
          await runtimeStore.put(nsExec, "executeProgress", progressWithTestId);
        }
      } catch (e) {
        console.warn(
          `[ExecuteTestNode] Failed to create running test record for ${(task as any).taskId}:`,
          e
        );
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
      { role: "user", content: userMsg },
    ]);

    return { messages: [response] };
  }

  async toolsNode(
    state: typeof MessagesAnnotation.State,
    config: LangGraphRunnableConfig
  ) {
    const tools = await getTestServerTools();

    // 处理DeepSeek-V3模型产生的格式问题
    const messages = [...state.messages] as any[];
    const lastMessage = messages[messages.length - 1] as AIMessage | any;

    // 检查是否有invalid_tool_calls需要清理
    if (
      lastMessage?.invalid_tool_calls &&
      Array.isArray(lastMessage.invalid_tool_calls) &&
      lastMessage.invalid_tool_calls.length > 0
    ) {
      console.log(
        "[toolsNode] Found invalid_tool_calls, attempting to clean:",
        lastMessage.invalid_tool_calls
      );

      const cleanedToolCalls: any[] = [];

      for (const invalidCall of lastMessage.invalid_tool_calls) {
        try {
          // 清理参数中的markdown格式
          let cleanedArgs = invalidCall.args;
          if (typeof cleanedArgs === "string") {
            // 移除markdown代码块格式
            cleanedArgs = cleanedArgs
              .replace(/^```[\w]*\n?/gm, "") // 移除开始的```
              .replace(/\n?```$/gm, "") // 移除结尾的```
              .replace(/^`+|`+$/g, "") // 移除单独的反引号
              .trim(); // 移除首尾空白

            // 尝试解析为JSON
            try {
              cleanedArgs = JSON.parse(cleanedArgs);
            } catch (parseError) {
              console.warn(
                "[toolsNode] Failed to parse cleaned args as JSON:",
                cleanedArgs,
                parseError
              );
              continue;
            }
          }

          // 构造清理后的工具调用
          const cleanedCall = {
            id:
              invalidCall.id ||
              `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: invalidCall.name,
            args: cleanedArgs,
          };

          cleanedToolCalls.push(cleanedCall);
          console.log(
            "[toolsNode] Successfully cleaned tool call:",
            cleanedCall
          );
        } catch (error) {
          console.warn(
            "[toolsNode] Failed to clean invalid tool call:",
            invalidCall,
            error
          );
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
            invalid_tool_calls: [], // 清空invalid_tool_calls
          },
        });
        messages[messages.length - 1] = updatedMessage;
        console.log(
          "[toolsNode] Updated message with cleaned tool calls:",
          cleanedToolCalls.length
        );
      }
    }

    // 确保所有消息都是正确的LangChain消息格式
    const validMessages = messages.map((msg: any) => {
      if (msg instanceof AIMessage) {
        return msg;
      }
      // 如果不是AIMessage实例，尝试转换
      if (msg && typeof msg === "object") {
        return new AIMessage({
          content: msg.content || "",
          tool_calls: msg.tool_calls || [],
          additional_kwargs: msg.additional_kwargs || {},
        });
      }
      return msg;
    });

    const node = new ToolNode(tools as any);
    return node.invoke(
      { ...state, messages: validMessages } as any,
      config as any
    );
  }

  async llmEvaluateNode(
    state: typeof MessagesAnnotation.State,
    config: LangGraphRunnableConfig
  ) {
    console.log(
      "[llmEvaluateNode] Starting LLM evaluation of tool execution result"
    );

    // 确保LLM已初始化
    if (!this.llm) {
      console.log("[llmEvaluateNode] Initializing LLM...");
      await this.initializellm();
    }

    const threadId = (config?.configurable as any)?.thread_id ?? "default";
    const runtimeStore: any =
      (config as any)?.store ?? (this.memoryManager?.getStore?.() as any);
    const usingRuntimeStore = !!(
      runtimeStore && typeof runtimeStore.get === "function"
    );

    // 获取执行进度
    const nsExec = [
      "plans",
      this.config.namespace.project,
      this.config.namespace.environment,
      this.config.namespace.agent_type,
      threadId,
    ];
    let execProgressRaw = usingRuntimeStore
      ? await runtimeStore.get(nsExec, "executeProgress")
      : undefined;
    let execProgress =
      execProgressRaw &&
      typeof execProgressRaw === "object" &&
      "value" in (execProgressRaw as any)
        ? (execProgressRaw as any).value
        : execProgressRaw;

    // 查找最近的工具执行结果
    const msgs: any[] = state.messages as any[];
    const lastToolMsg = [...msgs]
      .reverse()
      .find((m: any) => m?.tool_call_id && (m?.name || m?.tool_name));

    if (!lastToolMsg) {
      console.log(
        "[llmEvaluateNode] No tool execution result found, skipping evaluation"
      );
      return {
        messages: [
          new AIMessage({ content: "No tool execution result to evaluate." }),
        ],
      };
    }

    // 获取工具调用信息
    const lastAiWithCalls = [...msgs]
      .reverse()
      .find(
        (m: any) => (m as any)?.tool_calls && (m as any)?.tool_calls.length > 0
      );
    const toolCall = lastAiWithCalls?.tool_calls?.find(
      (tc: any) => tc?.id === lastToolMsg.tool_call_id
    );
    const usedArgs = toolCall?.args ?? {};
    const toolName = lastToolMsg.name || toolCall?.name || "unknown";
    const toolResult = lastToolMsg.content;

    try {
      // 创建带结构化输出的LLM实例
      // const evaluationLLM = this.llm.withStructuredOutput(
      //   evaluationOutputSchema,
      //   {
      //     name: "evaluationOutputSchema",
      //     includeRaw: true,
      //   }
      // );
      // 获取当前批次的任务信息
      const batchIndex = execProgress?.batchIndex ?? 0;
      const tasks = await this.memoryManager.getTaskPlansByBatch(
        threadId,
        batchIndex
      );
      const completedIndex = execProgress?.taskIndex ?? 0;
      const completedTask = tasks[completedIndex];
      // 这里可以获取是否需要数据库验证，如果需要数据库验证，则需要使用tool
      // 构造评估提示
      const evaluationPrompt = formatEvaluationPrompt({
        toolName,
        toolParams: usedArgs,
        toolResult,
        executionContext: {
          threadId,
          batchIndex: execProgress?.batchIndex,
          taskIndex: execProgress?.taskIndex,
        },
      });
      const dbTools = await getPostgresqlHubTools();
      console.log("[llmEvaluateNode] dbTools:", dbTools);
      const llm = await loadChatModel("openai/moonshotai/Kimi-K2-Instruct");
      const reactAgent = await createReactAgent({
        llm: llm,
        tools:dbTools,
        responseFormat:evaluationOutputSchema
      })
      // 使用正确的结构化输出方式
      // 根据LangGraph文档，应该通过structuredResponse字段访问结果
      const response = await reactAgent.invoke({messages:[{
          role: "system",
          content:
            "You are an expert tool execution evaluator. Analyze the tool execution results thoroughly and provide comprehensive structured feedback.",
        },
        { role: "user", content: evaluationPrompt },]}
      );
      console.log("调用llm完毕",response);
      // // 调试：打印response对象的完整结构
      // console.log('[DEBUG] Response object structure:', {
      //   response: response,
      //   responseKeys: Object.keys(response || {}),
      //   hasStructuredResponse: 'structuredResponse' in (response || {}),
      //   hasStructured_response: 'structured_response' in (response || {}),
      //   responseType: typeof response,
      //   responseConstructor: response?.constructor?.name
      // });

      const evaluationResult = response?.structuredResponse || response;
      const isSuccess = evaluationResult.status === "SUCCESS";
      const isError = evaluationResult.status === "FAILURE";

      console.log(`[llmEvaluateNode] LLM evaluation result:`, {
        status: evaluationResult.status,
        reason: evaluationResult.reason,
        confidence: evaluationResult.confidence,
        failureAnalysis: evaluationResult.failureAnalysis,
      });



      // 更新测试结果到task_test表
      if (completedTask?.taskId) {
        try {
          const status = isError ? "failed" : "completed";
          const currentTestId = (execProgress as any)?.currentTestId;

          // 构造详细的测试结果数据
          const detailedTestResult = {
            output: toolResult,
            llmEvaluation: {
              status: evaluationResult.status,
              reason: evaluationResult.reason,
              confidence: evaluationResult.confidence,
              failureAnalysis: evaluationResult.failureAnalysis,
              remediationSuggestions: evaluationResult.remediationSuggestions,
              executionContext: evaluationResult.executionContext,
            },
          };

          // 构造错误消息（如果失败）
          const errorMessage = isError
            ? `LLM Evaluation: ${evaluationResult.reason}${evaluationResult.failureAnalysis ? ` | Root Cause: ${evaluationResult.failureAnalysis.rootCause}` : ""}`
            : undefined;

          if (currentTestId) {
            // 更新已存在的测试记录
            await this.memoryManager.updateTaskTestStatus(
              currentTestId,
              status,
              detailedTestResult,
              errorMessage,
              undefined,
              evaluationResult
            );
            console.log(
              `[llmEvaluateNode] Updated test result: ${currentTestId} with structured LLM evaluation`
            );
          } else {
            // 如果没有找到testId，创建新记录（兼容性处理）
            const testResult = {
              testId: `test_${completedTask.taskId}_${Date.now()}`,
              taskId: completedTask.taskId,
              threadId: threadId,
              toolName: toolName,
              testData: usedArgs,
              testResult: detailedTestResult,
              status: status as "completed" | "failed",
              errorMessage,
              evaluationResult: evaluationResult,
              createdAt: new Date(),
              updatedAt: new Date(),
              completedAt: new Date(),
            };

            await this.memoryManager.saveTaskTest(testResult);
            console.log(
              `[llmEvaluateNode] Created new test result with structured evaluation: ${testResult.testId}`
            );
          }

          // 处理多条测试数据的情况（如果工具返回多个结果）
          const c = toolResult;
          if (c && typeof c === "object") {
            let additionalResults: any[] = [];

            if (Array.isArray(c.testData)) {
              additionalResults = c.testData
                .slice(1)
                .map((data: any, index: number) => ({
                  testId: `test_${completedTask.taskId}_${Date.now()}_${index + 1}`,
                  taskId: completedTask.taskId,
                  threadId: threadId,
                  toolName: toolName,
                  testData: data.input || data,
                  testResult: {
                    output: data.output || data.result || data,
                    llmEvaluation: "SUCCESS",
                  },
                  status: data.error || data.failed ? "failed" : "completed",
                  errorMessage: data.error || data.errorMessage,
                  evaluationResult: evaluationResult,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  completedAt: new Date(),
                }));
            } else if (Array.isArray(c.results) && c.results.length > 1) {
              additionalResults = c.results
                .slice(1)
                .map((result: any, index: number) => ({
                  testId: `test_${completedTask.taskId}_${Date.now()}_${index + 1}`,
                  taskId: completedTask.taskId,
                  threadId: threadId,
                  toolName: toolName,
                  testData: usedArgs,
                  testResult: { output: result, llmEvaluation: "SUCCESS" },
                  status:
                    result.error || result.failed ? "failed" : "completed",
                  errorMessage: result.error || result.errorMessage,
                  evaluationResult: evaluationResult,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  completedAt: new Date(),
                }));
            }

            if (additionalResults.length > 0) {
              await this.memoryManager.saveTaskTestBatch(additionalResults);
              console.log(
                `[llmEvaluateNode] Saved ${additionalResults.length} additional test results for task ${completedTask.taskId}`
              );
            }
          }
        } catch (e) {
          console.warn(
            `[llmEvaluateNode] Failed to update test result for ${completedTask?.taskId}:`,
            e
          );
        }
      }

      // 获取当前批次信息以检查是否为最后一个任务
      const currentBatchIndex = execProgress?.batchIndex ?? 0;
      const currentTaskIndex = execProgress?.taskIndex ?? 0;
      const isLastTaskInBatch = currentTaskIndex >= tasks.length - 1;
      
      console.log(
        `[llmEvaluateNode] Task evaluation completed for batch ${currentBatchIndex}, task ${currentTaskIndex}/${tasks.length - 1}. IsLastTask: ${isLastTaskInBatch}`
      );

      // 工具结果已评估并落库，推进执行指针到下一个任务
      const progressed = {
        ...execProgress,
        taskIndex: (execProgress?.taskIndex ?? 0) + 1,
      };
      if (usingRuntimeStore && typeof runtimeStore.put === "function") {
        await runtimeStore.put(nsExec, "executeProgress", progressed);
      }
      console.log(
        `[llmEvaluateNode] Advanced executeProgress to taskIndex=${progressed.taskIndex}. Data storage completed for task ${completedTask?.taskId}`
      );
      
      // 如果这是最后一个任务，添加额外的日志确认数据已完全存储
      if (isLastTaskInBatch) {
        const currentTestId = (execProgress as any)?.currentTestId;
        console.log(
          `[llmEvaluateNode] *** LAST TASK COMPLETED *** Batch ${currentBatchIndex} task ${currentTaskIndex} evaluation and storage finished. TestId: ${currentTestId || 'fallback'}`
        );
      }

      return {
        messages: [
          new AIMessage({
            content: `Tool execution evaluated by LLM: ${isSuccess ? "SUCCESS" : "FAILURE"}. ${isSuccess ? "Tool executed successfully." : "Tool execution failed."}`,
          }),
        ],
      };
    } catch (error) {
      console.error("[llmEvaluateNode] Error during LLM evaluation:", error);
      // 如果LLM评估失败，回退到代码判断
      const c = toolResult;
      let isError = false;
      if (c && typeof c === "object") {
        isError = Boolean((c as any).error) || (c as any).success === false;
      } else if (typeof c === "string") {
        isError = /error|failed|exception|traceback/i.test(c);
      }

      return {
        messages: [
          new AIMessage({
            content: `LLM evaluation failed, using fallback code evaluation: ${isError ? "FAILURE" : "SUCCESS"}`,
          }),
        ],
      };
    }
  }

  routeModelOutput(
    state: typeof MessagesAnnotation.State
  ): "execute-tool-node" | "llm-evaluate-node" | typeof END {
    const messages = state.messages as any[];
    const lastMessage = messages[messages.length - 1] as AIMessage | any;

    // 检查是否有工具调用
    if (
      lastMessage?.tool_calls &&
      Array.isArray(lastMessage.tool_calls) &&
      lastMessage.tool_calls.length > 0
    ) {
      console.log(
        "[routeModelOutput] Found tool calls, routing to execute-tool-node"
      );
      return "execute-tool-node";
    }

    // 检查是否有invalid_tool_calls（DeepSeek-V3模型的格式问题）
    if (
      lastMessage?.invalid_tool_calls &&
      Array.isArray(lastMessage.invalid_tool_calls) &&
      lastMessage.invalid_tool_calls.length > 0
    ) {
      console.log(
        "[routeModelOutput] Found invalid_tool_calls, routing to execute-tool-node for cleanup"
      );
      return "execute-tool-node";
    }

    console.log("[routeModelOutput] No tool calls found, ending execution");
    return END;
  }

  routeToolOutput(
    state: typeof MessagesAnnotation.State
  ): "llm-evaluate-node" | typeof END {
    const messages = state.messages as any[];
    const lastToolMsg = [...messages]
      .reverse()
      .find((m: any) => m?.tool_call_id && (m?.name || m?.tool_name));

    if (lastToolMsg) {
      console.log(
        "[routeToolOutput] Tool execution result found, routing to LLM evaluation"
      );
      return "llm-evaluate-node";
    }

    return END;
  }

  public buildGraph() {
    return new StateGraph(MessagesAnnotation)
      .addNode("execute-test-node", this.ExecuteTestNode.bind(this))
      .addNode("execute-tool-node", this.toolsNode.bind(this))
      .addNode("llm-evaluate-node", this.llmEvaluateNode.bind(this))
      .addEdge(START, "execute-test-node")
      .addConditionalEdges(
        "execute-test-node",
        this.routeModelOutput.bind(this),
        ["execute-tool-node", END]
      )
      .addConditionalEdges(
        "execute-tool-node",
        this.routeToolOutput.bind(this),
        ["llm-evaluate-node", END]
      )
      .addEdge("llm-evaluate-node", "execute-test-node")
      .compile({
        checkpointer: this.memoryManager.getCheckpointer(),
        interruptBefore: [],
        interruptAfter: [],
      }).withConfig({ recursionLimit: 256 });
  }
}
