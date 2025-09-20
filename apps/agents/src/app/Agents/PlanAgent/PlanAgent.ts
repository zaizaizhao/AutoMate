import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { BaseAgent, AgentConfig } from "../../BaseAgent/BaseAgent.js";

import { AIMessage } from "@langchain/core/messages";
// import { ConfigurationSchema } from "../../ModelUtils/Config.js";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { loadChatModel } from "../../ModelUtils/ChatModel.js";
import { TOOL_MESSAGE_EXTRACT_PROMPT } from "./Prompts.js";
import { getTestServerTools } from "src/app/mcp-servers/mcp-client.js";
import type { TaskPlanedForTest } from "../../Memory/SharedMemoryManager.js";
import { planOutputSchema } from "./StructuredOutputSchema.js";

export class PlanAgent extends BaseAgent {
  private llm: any;
  // 记录最近一次运行的 thread_id，供路由函数读取批次进度
  private lastThreadId: string | null = null;

  constructor(config: AgentConfig) {
    super(config);
  }

  protected async initializellm() {
    this.llm = await loadChatModel("openai/moonshotai/Kimi-K2-Instruct");
  }

  async planNode(
    state: typeof MessagesAnnotation.State,
    config: LangGraphRunnableConfig
  ) {
    //通过state.messages来获取传入的消息
    // 多轮planNode的调用 thread_id保持不变
    console.log(
      "[PlanAgent] config thread_id:",
      config?.configurable?.thread_id
    );

    // 确保LLM已初始化
    if (!this.llm) {
      console.log("[PlanAgent] Initializing LLM...");
      await this.initializellm();
    }
    // 规划阶段需要了解可用工具，但不实际调用工具：以上下文形式提供工具清单与入参模式
    const tools = await getTestServerTools();

    // === 每轮仅注入 5 个工具（与用户输入无关，顺序遍历） ===
    const threadId = (config?.configurable as any)?.thread_id ?? "default";
    this.lastThreadId = threadId;
    const batchMemKey = `planNode:${threadId}:toolBatch`;
    // 使用运行时传入的 store（如果是 CLI 注入的 InMemory AsyncBatchedStore，则忽略，回退到 SharedMemoryManager）
    const candidateStore: any = (config as any)?.store;
    const candidateType = candidateStore?.constructor?.name;
    const underlyingType = candidateStore?.store?.constructor?.name;
    const isAsyncBatchedInMemory =
      candidateType === "AsyncBatchedStore" && underlyingType === "InMemoryStore";
    const forceShared =
      (process.env.FORCE_SHARED_MEMORY ?? process.env.USE_SHARED_STORE ?? "")
        .toString() === "1";
    const store: any = !candidateStore || isAsyncBatchedInMemory || forceShared ? undefined : candidateStore;
    const usingStore = !!(store && typeof store.get === "function");
    console.log("[PlanAgent] Store debug:", {
      hasStore: !!candidateStore,
      hasGet: !!(candidateStore && typeof candidateStore.get === "function"),
      hasPut: !!(candidateStore && typeof candidateStore.put === "function"),
      storeType: candidateType,
      underlyingStoreType: underlyingType,
      usingStore,
      decision: store ? "use runtime store" : isAsyncBatchedInMemory ? "ignore AsyncBatchedStore(InMemory) -> use shared memory" : forceShared ? "env forced shared memory" : "no store provided"
    });
    const ns = [
      "plans",
      this.config.namespace.project,
      this.config.namespace.environment,
      this.config.namespace.agent_type,
      threadId,
    ];

    // 读取/初始化批次状态（优先使用 store，其次回退到 SharedMemoryManager），并规范化 store.get 返回的记录格式
    const existingBatchStateRaw = usingStore
      ? await store.get(ns, "toolBatch")
      : await this.getSharedMemory(batchMemKey);
    const existingBatchState =
      existingBatchStateRaw &&
      typeof existingBatchStateRaw === "object" &&
      "value" in (existingBatchStateRaw as any)
        ? (existingBatchStateRaw as any).value
        : existingBatchStateRaw;
    console.log(
      `[PlanAgent] Read batchState via ${usingStore ? "store" : "sharedMemory"} (normalized):`,
      existingBatchState
    );
    const toolsPerBatch = existingBatchState?.toolsPerBatch ?? 5;
    const totalTools = tools.length;
    const totalBatches = Math.ceil(totalTools / toolsPerBatch);
    const batchIndex = existingBatchState?.batchIndex ?? 0; // 从 0 开始
    const startIndex = batchIndex * toolsPerBatch;
    const endIndex = startIndex + toolsPerBatch;

    console.log(
      `[PlanAgent] Batch info: threadId=${threadId}, batchIndex=${batchIndex}, toolsPerBatch=${toolsPerBatch}, totalTools=${totalTools}, totalBatches=${totalBatches}, slice=[${startIndex}, ${endIndex})`
    );
    // 计算当前批次应注入的工具子集
    const selectedTools = tools.slice(startIndex, endIndex);

    // 如果当前批次已经存在任务，跳过LLM规划，直接推进到下一批（幂等保障）
    try {
      const existingTasksForBatch = await this.getBatchTasks(
        threadId,
        batchIndex
      );
      if (existingTasksForBatch && existingTasksForBatch.length > 0) {
        if (startIndex < totalTools) {
          const nextBatchIndex = Math.min(batchIndex + 1, totalBatches);
          const newState = {
            batchIndex: nextBatchIndex,
            toolsPerBatch,
            totalTools,
            totalBatches,
          };
          if (store && typeof store.put === "function") {
            await store.put(ns, "toolBatch", newState);
          } else {
            await this.saveSharedMemory(batchMemKey, newState);
          }
          const targets = store ? "store" : "sharedMemory";
          console.log(
            `[PlanAgent] Detected existing tasks for plan=${threadId}, batch=${batchIndex}. Skipping re-plan and advancing to ${nextBatchIndex}. Persisted batchState to: ${targets}`
          );
        }
        return {
          messages: [
            new AIMessage({
              content: `检测到批次 ${batchIndex} 已有任务，跳过规划并推进下一批。`,
            }),
          ],
        };
      }
    } catch (e) {
      console.warn(
        "[PlanAgent] Failed to check existing tasks for idempotency:",
        e
      );
    }

    // 如果是首次或工具清单发生变化，则（重新）保存批次元信息
    if (
      !existingBatchState ||
      existingBatchState.totalTools !== totalTools ||
      existingBatchState.toolsPerBatch !== toolsPerBatch
    ) {
      const payload = {
        batchIndex, // 保持当前批次索引
        toolsPerBatch,
        totalTools,
        totalBatches,
      };
      if (store && typeof store.put === "function") {
        console.log("[PlanAgent] About to call store.put with:", { ns, key: "toolBatch", payload });
        console.log("[PlanAgent] Store type debug info:", {
          storeConstructorName: store.constructor.name,
          storeKeys: Object.keys(store),
          hasUnderlyingStore: !!store.store,
          underlyingStoreType: store.store ? store.store.constructor.name : 'none',
          storePrototype: Object.getPrototypeOf(store).constructor.name
        });
        try {
          console.log(store);
          
          await store.put(ns, "toolBatch", payload);
          console.log("[PlanAgent] store.put completed successfully",payload);
          
          // 尝试强制刷新AsyncBatchedStore
          if (store.store && typeof store.store.put === "function") {
            console.log("[PlanAgent] Attempting direct call to underlying store.put");
            await store.store.put(ns, "toolBatch_direct", payload);
            console.log("[PlanAgent] Direct store.put completed");
          }
          
          // 使用put方法替代batch方法避免AsyncBatchedStore问题
          if (store && typeof store.put === "function") {
            console.log("[PlanAgent] Using put method instead of batch to avoid AsyncBatchedStore issue");
            await store.put(ns, "toolBatch_batch", payload);
            console.log("[PlanAgent] store.put completed");
          }
        } catch (error) {
          console.error("[PlanAgent] store.put failed:", error);
          throw error;
        }
      } else {
        await this.saveSharedMemory(batchMemKey, payload);
      }
      const targets = store ? "store" : "sharedMemory";
      console.log(
        `[PlanAgent] Initialized/updated batch meta. Persisted to: ${targets}`
      );
    }

    const selectedToolMeta = selectedTools.map((t: any) => ({
      name: t?.name ?? t?.toolName ?? "",
      description: t?.description ?? "",
      // 兼容多种工具实现的schema字段命名
      inputSchema:
        t?.schema ?? t?.input_schema ?? t?.parametersSchema ?? undefined,
    }));

    let systemPrompt = TOOL_MESSAGE_EXTRACT_PROMPT.replace(
      "{system_time}",
      new Date().toISOString()
    );

    // 当前批次的信息，帮助模型在输出中设置正确的 batchIndex，并仅围绕该批次工具生成任务
    const batchInfoContext =
      `You are generating test tasks ONLY for the current tool batch.\n` +
      `BATCH_INFO=\n${JSON.stringify(
        {
          threadId,
          batchIndex,
          totalBatches,
          toolsPerBatch,
          totalTools,
          startIndex,
          endIndex: Math.min(endIndex, totalTools),
          toolNames: selectedToolMeta.map((t) => t.name),
        },
        null,
        2
      )}`;

    const toolsContext = `You have the following available tools for THIS BATCH (5 per call). Use the exact value in the \"name\" field as task.toolName when planning. Do NOT invent new tool names. Keep parameters aligned with inputSchema.\nTOOLS_JSON=\n${JSON.stringify(selectedToolMeta, null, 2)}`;

    // —— 规划上下文摘要（从共享内存读取，不存在则从最后一条用户指令提取并持久化） ——
    const planningContextKey = `planNode:${threadId}:planningContext`;
    let planningContextItem =
      store && typeof store.get === "function"
        ? await store.get(ns, "planningContext")
        : await this.getSharedMemory(planningContextKey);
    let planningContext: string;
    if (!planningContextItem) {
      const msgs: any[] = Array.isArray((state as any)?.messages)
        ? (state as any).messages
        : [];
      let lastUserText = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        const role =
          m?.role || m?.type || (m as any)?._getType?.() || "unknown";
        if (role === "user" || role === "human") {
          const c = m?.content;
          if (typeof c === "string") {
            lastUserText = c;
          } else {
            try {
              lastUserText = JSON.stringify(c);
            } catch {
              lastUserText = String(c);
            }
          }
          break;
        }
      }
      const truncate = (s: string, max = 800) =>
        s && s.length > max ? s.slice(0, max) + "..." : s;
      const planningContextObj = {
        note: "This is the planning context summary for generating test tasks.",
        userGoal: truncate(lastUserText || "N/A"),
        constraints: [
          "Only plan test tasks for the current batch of tools (5 per call).",
          "Output must strictly follow planOutputSchema (valid JSON) with no extra text/markdown.",
          "Do not reference tools outside this batch.",
          "Align parameters with each tool's inputSchema.",
          `Set top-level batchIndex to ${batchIndex}.`,
        ],
      };
      if (store && typeof store.put === "function") {
        await store.put(ns, "planningContext", planningContextObj);
      } else {
        await this.saveSharedMemory(planningContextKey, planningContextObj);
      }
      planningContext = `PLANNING_CONTEXT=\n${JSON.stringify(planningContextObj, null, 2)}`;
    } else {
      const ctx =
        typeof planningContextItem === "string"
          ? planningContextItem
          : JSON.stringify(planningContextItem, null, 2);
      planningContext = `PLANNING_CONTEXT=\n${ctx}`;
    }
    const planningContextMsg = planningContext;

    // —— 输出规则（强约束，仅允许结构化 JSON） ——
    const outputRules = [
      "OUTPUT_RULES:",
      "- You MUST return only a JSON object matching planOutputSchema.",
      "- No code fences, no markdown, no natural language outside JSON.",
      "- Tasks must ONLY use tools in this batch; use exact tool name from tools list.",
      "- Parameters must conform to the tool inputSchema.",
      "- Set top-level batchIndex correctly and include batchIndex for each task.",
    ].join("\n");

    const planning = (
      await loadChatModel("openai/moonshotai/Kimi-K2-Instruct")
    ).withStructuredOutput(planOutputSchema, {
      name: "planOutputSchema",
      includeRaw: true,
    });

    try {
      const response = await planning.invoke([
        { role: "system", content: systemPrompt },
        { role: "system", content: planningContextMsg },
        { role: "system", content: batchInfoContext },
        { role: "system", content: toolsContext },
        { role: "system", content: outputRules },
      ]);

      console.log(
        "[PlanAgent] LLM response start:==============================================="
      );
      if (response && typeof response === "object" && "parsed" in response) {
        console.log(
          "[PlanAgent] Parsed structured output:",
          (response as any).parsed
        );
        // 可选：打印原始消息，便于排查模型是否仍返回markdown
        if ((response as any).raw) {
          console.log(
            "[PlanAgent] Raw message content:",
            (response as any).raw.content
          );
        }
        console.log(
          "[PlanAgent] LLM response end:==============================================="
        );

        // —— 持久化当前批次的规划结果到 task_plans ——
        const parsed: any = (response as any).parsed;
        const tasksArray: any[] = Array.isArray(parsed?.tasks)
          ? parsed.tasks
          : [];
        console.log(
          `[PlanAgent] Parsed tasks count: ${tasksArray.length} for batch=${batchIndex}`
        );
        if (tasksArray.length > 0) {
          // 计算当前批次已有的最大顺序号，避免重复
          const existing = await this.getBatchTasks(threadId, batchIndex);
          const safeThreadId = String(threadId).replace(
            /[^A-Za-z0-9_.:-]/g,
            "_"
          );
          const prefix = `${safeThreadId}-${batchIndex}-`;
          const maxSeq = existing.reduce((max, it) => {
            const id = (it as any)?.taskId ?? "";
            if (typeof id === "string" && id.startsWith(prefix)) {
              const tail = id.slice(prefix.length);
              const n = parseInt(tail, 10);
              if (!isNaN(n)) return Math.max(max, n);
            }
            return max;
          }, 0);
          let seq = maxSeq + 1;

          const toSave = tasksArray.map((t: any) => {
            // 验证和处理 parameters 字段
            let validParameters = {};
            try {
              const rawParams = t?.parameters;
              if (rawParams === null || rawParams === undefined) {
                validParameters = {};
              } else if (typeof rawParams === 'object' && rawParams !== null) {
                // 如果已经是对象，检查是否可以正常序列化
                JSON.stringify(rawParams);
                validParameters = rawParams;
              } else if (typeof rawParams === 'string') {
                // 如果是字符串，尝试解析为JSON
                if (rawParams.trim() === '' || rawParams === '.' || rawParams.includes(':={}')) {
                  // 处理已知的异常格式
                  validParameters = {};
                  console.warn(`[PlanAgent] Invalid parameters format detected and converted to empty object: "${rawParams}"`);
                } else {
                  try {
                    validParameters = JSON.parse(rawParams);
                  } catch (parseError) {
                    validParameters = {};
                    console.warn(`[PlanAgent] Failed to parse parameters as JSON, using empty object. Raw value: "${rawParams}", Error:`, parseError);
                  }
                }
              } else {
                // 其他类型直接设为空对象
                validParameters = {};
                console.warn(`[PlanAgent] Unexpected parameters type (${typeof rawParams}), using empty object. Raw value:`, rawParams);
              }
            } catch (error) {
              validParameters = {};
              console.warn(`[PlanAgent] Error processing parameters, using empty object. Raw value:`, t?.parameters, 'Error:', error);
            }

            return {
              batchIndex:
                typeof t?.batchIndex === "number"
                  ? t.batchIndex
                  : typeof parsed?.batchIndex === "number"
                    ? parsed.batchIndex
                    : batchIndex,
              taskId: `${safeThreadId}-${batchIndex}-${seq++}`,
              toolName: t?.toolName ?? "",
              description: t?.description ?? "",
              parameters: validParameters,
              complexity: t?.complexity ?? "medium",
              isRequiredValidateByDatabase: !!t?.isRequiredValidateByDatabase,
            };
          });

          console.log(
            `[PlanAgent] Persisting ${toSave.length} task(s) to DB. planId=${threadId}, batch=${batchIndex}`
          );
          try {
            await this.memoryManager.saveTaskPlans(threadId, toSave);
            console.log("[PlanAgent] Task plans saved to DB successfully.");
          } catch (e) {
            console.error("[PlanAgent] saveTaskPlans error:", e);
          }
        } else {
          console.log(
            `[PlanAgent] No tasks produced by LLM for planId=${threadId}, batch=${batchIndex}. Skipping DB persist.`
          );
        }
        // 无论本批次是否产生任务，都推进到下一批，避免卡在某个批次
        if (startIndex < totalTools) {
          const nextBatchIndex = Math.min(batchIndex + 1, totalBatches);
          const newState = {
            batchIndex: nextBatchIndex,
            toolsPerBatch,
            totalTools,
            totalBatches,
          };
          if (store && typeof store.put === "function") {
            await store.put(ns, "toolBatch", newState);
          } else {
            await this.saveSharedMemory(batchMemKey, newState);
          }
          const targets = store ? "store" : "sharedMemory";
          console.log(
            `[PlanAgent] Advanced to next batch: ${batchIndex} -> ${nextBatchIndex}. Persisted batchState to: ${targets}`
          );
        }
      }
    } catch (error) {
      console.error("[PlanAgent] planning.invoke error:", error);
    }

    return { messages: [new AIMessage({ content: "计划生成完成（本批次）" })] };
  }
  // agent执行终端机制
  startOrContinuePlan() {}

  async getBatchTasks(
    planId: string,
    batchIndex: number
  ): Promise<TaskPlanedForTest[]> {
    try {
      return await this.memoryManager.getTaskPlansByBatch(planId, batchIndex);
    } catch (error) {
      console.error(
        `[PlanAgent] Error getting tasks for plan ${planId}, batch ${batchIndex}:`,
        error
      );
      return [];
    }
  }

  async takeActionOrGeneratePlan(
    _state: typeof MessagesAnnotation.State,
    config: LangGraphRunnableConfig
  ): Promise<"plan-node" | typeof END> {
    try {
      const threadId =
        (config?.configurable as any)?.thread_id ??
        this.lastThreadId ??
        "default";
      if (!threadId) {
        // 首轮或没有获取到 threadId，默认继续到 plan-node
        return "plan-node";
      }
      const batchMemKey = `planNode:${threadId}:toolBatch`;
      // 使用与 planNode 一致的存储选择逻辑：忽略 CLI 注入的 InMemory AsyncBatchedStore，必要时强制使用共享内存
      const candidateStore: any = (config as any)?.store;
      const candidateType = candidateStore?.constructor?.name;
      const underlyingType = candidateStore?.store?.constructor?.name;
      const isAsyncBatchedInMemory =
        candidateType === "AsyncBatchedStore" && underlyingType === "InMemoryStore";
      const forceShared =
        (process.env.FORCE_SHARED_MEMORY ?? process.env.USE_SHARED_STORE ?? "")
          .toString() === "1";
      const store: any = !candidateStore || isAsyncBatchedInMemory || forceShared ? undefined : candidateStore;
      const usingStore = !!(store && typeof store.get === "function");
      console.log("[PlanAgent] Router store debug:", {
        hasStore: !!candidateStore,
        hasGet: !!(candidateStore && typeof candidateStore.get === "function"),
        hasPut: !!(candidateStore && typeof candidateStore.put === "function"),
        storeType: candidateType,
        underlyingStoreType: underlyingType,
        usingStore,
        decision: store ? "use runtime store" : isAsyncBatchedInMemory ? "ignore AsyncBatchedStore(InMemory) -> use shared memory" : forceShared ? "env forced shared memory" : "no store provided"
      });
      const ns = [
        "plans",
        this.config.namespace.project,
        this.config.namespace.environment,
        this.config.namespace.agent_type,
        threadId,
      ];
      const batchStateRaw = usingStore
        ? await store.get(ns, "toolBatch")
        : await this.getSharedMemory(batchMemKey);
      const batchState =
        batchStateRaw &&
        typeof batchStateRaw === "object" &&
        "value" in (batchStateRaw as any)
          ? ((batchStateRaw as any).value as {
              batchIndex: number;
              toolsPerBatch: number;
              totalTools: number;
              totalBatches: number;
            } | null)
          : (batchStateRaw as {
              batchIndex: number;
              toolsPerBatch: number;
              totalTools: number;
              totalBatches: number;
            } | null);
      console.log(
        "[PlanAgent] Router read batchState (normalized):",
        batchState
      );

      if (
        batchState &&
        typeof batchState.batchIndex === "number" &&
        typeof batchState.totalBatches === "number"
      ) {
        // 当 batchIndex >= totalBatches 时，说明所有批次已完成
        if (batchState.batchIndex >= batchState.totalBatches) {
          console.log(
            `[PlanAgent] All batches completed (batchIndex=${batchState.batchIndex}, totalBatches=${batchState.totalBatches}). Ending.`
          );
          return END;
        }
      }
      return "plan-node";
    } catch (err) {
      console.warn("[PlanAgent] Router error, defaulting to continue:", err);
      return "plan-node";
    }
  }

  public buildGraph() {
    const builder = new StateGraph(MessagesAnnotation)
      .addNode("plan-node", this.planNode.bind(this))
      .addEdge(START, "plan-node")
      .addConditionalEdges(
        "plan-node",
        this.takeActionOrGeneratePlan.bind(this),
        ["plan-node", END]
      );

    return builder.compile({
      checkpointer: this.memoryManager.getCheckpointer(),
      // store 配置通过 LangGraph 运行时传递
      interruptBefore: [],
      interruptAfter: [],
    }).withConfig({ recursionLimit: 256 });
  }
}
