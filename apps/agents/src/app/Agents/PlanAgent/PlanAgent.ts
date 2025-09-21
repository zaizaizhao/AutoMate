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
// import { sqlToolPrompts, TOOL_MESSAGE_EXTRACT_PROMPT } from "./Prompts.js";
import { getPostgresqlHubTools, getTestServerTools } from "src/app/mcp-servers/mcp-client.js";
import type { TaskPlanedForTest } from "../../Memory/SharedMemoryManager.js";

import { createReactAgent } from "@langchain/langgraph/prebuilt";

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

  /**
   * 第一阶段：数据查询规划阶段
   * 让LLM自由调用数据库工具，进行数据探索和分析，无格式约束
   */
  private async executeDataQueryStage(
    _threadId: string,
    batchIndex: number,
    selectedToolMeta: any[],
    planningContext: string
  ): Promise<{ success: boolean; conversationHistory: any[]; realData: any }> {
    console.log(`[PlanAgent] Starting Stage 1: Data Query & Planning for batch ${batchIndex}`);
    
    const stage1SystemPrompt = `You are a test planning assistant in the DATA QUERY & PLANNING stage.

Your primary goal is to:
1. EXPLORE and QUERY the database to understand available data
2. IDENTIFY real IDs, relationships, and data patterns
3. PLAN test scenarios based on REAL data (not mock data)
4. Use tools freely to gather information

IMPORTANT GUIDELINES:
- ALWAYS query the database first to understand the data structure
- Use REAL IDs from database queries, never generate mock IDs like "user123", "task456", etc.
- Explore relationships between entities
- Understand data constraints and validation rules
- This stage allows natural language output - you don't need to format as JSON yet
- Focus on data discovery and understanding

Current batch tools available: ${selectedToolMeta.map(t => t.name).join(', ')}

${planningContext}`;

    const dataQueryAgent = await createReactAgent({
      llm: this.llm,
      tools: await getPostgresqlHubTools()
    });

    try {
      const stage1Response = await dataQueryAgent.invoke({
        messages: [
          { role: "system", content: stage1SystemPrompt },
          { role: "user", content: `Please explore the database and plan test tasks for the current batch of tools. Focus on understanding the real data available and identifying actual IDs and relationships that should be used in test scenarios.` }
        ]
      });

      // 提取完整的对话历史，包括工具调用和结果
      const conversationHistory = this.extractConversationHistory(stage1Response);
      const realData = this.extractRealDataFromHistory(conversationHistory);
      
      console.log(`[PlanAgent] Stage 1 completed. Found ${Object.keys(realData).length} types of real data`);
      
      return {
        success: true,
        conversationHistory,
        realData
      };
    } catch (error) {
      console.error("[PlanAgent] Stage 1 (Data Query) failed:", error);
      return {
        success: false,
        conversationHistory: [],
        realData: {}
      };
    }
  }

  /**
   * 从对话历史中提取完整的消息流，包括工具调用
   */
  private extractConversationHistory(response: any): any[] {
    const history: any[] = [];
    
    if (response && Array.isArray(response.messages)) {
      return response.messages;
    }
    
    // 如果不是标准格式，尝试其他提取方式
    if (response && response.content) {
      history.push(response);
    }
    
    return history;
  }

  /**
   * 从对话历史中提取真实数据（ID、关系等）
   */
  private extractRealDataFromHistory(history: any[]): any {
    const realData: any = {
      userIds: [],
      taskIds: [],
      projectIds: [],
      relationships: [],
      constraints: []
    };
    
    for (const message of history) {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      
      // 提取数据库查询结果中的ID模式
      const idPatterns = {
        userIds: /user[_-]?id["']?\s*:?\s*["']?(\d+|[a-f0-9-]{36})["']?/gi,
        taskIds: /task[_-]?id["']?\s*:?\s*["']?(\d+|[a-f0-9-]{36})["']?/gi,
        projectIds: /project[_-]?id["']?\s*:?\s*["']?(\d+|[a-f0-9-]{36})["']?/gi
      };
      
      for (const [key, pattern] of Object.entries(idPatterns)) {
        const matches = content.match(pattern);
        if (matches) {
          const ids = matches.map((match: any) => {
            const idMatch = match.match(/["']?(\d+|[a-f0-9-]{36})["']?$/);
            return idMatch ? idMatch[1] : null;
          }).filter(Boolean);
          realData[key].push(...ids);
        }
      }
    }
    
    // 去重
    for (const key of Object.keys(realData)) {
      if (Array.isArray(realData[key])) {
        realData[key] = [...new Set(realData[key])];
      }
    }
    
    return realData;
  }

  /**
   * 第二阶段：格式化阶段
   * 基于第一阶段的数据查询结果，生成符合outputRules的结构化JSON
   */
  private async executeFormattingStage(
    _threadId: string,
    batchIndex: number,
    selectedToolMeta: any[],
    conversationHistory: any[],
    realData: any,
    outputRules: string
  ): Promise<{ success: boolean; parsedTasks: any }> {
    console.log(`[PlanAgent] Starting Stage 2: Formatting for batch ${batchIndex}`);
    
    const stage2SystemPrompt = `You are a test planning assistant in the FORMATTING stage.

Your goal is to generate a structured JSON response based on the data exploration results from Stage 1.

IMPORTANT GUIDELINES:
- Use ONLY the real data discovered in Stage 1
- DO NOT generate new mock IDs or data
- Follow the exact JSON format specified in OUTPUT_RULES
- Each task must use real IDs from the database queries
- Focus on formatting, not on new data discovery

Real data available from Stage 1:
${JSON.stringify(realData, null, 2)}

Tools for this batch: ${selectedToolMeta.map(t => `${t.name}: ${t.description}`).join('\n')}

${outputRules}`;

    const stage1Summary = this.summarizeStage1Results(conversationHistory, realData);
    
    const formattingAgent = await createReactAgent({
      llm: this.llm,
      tools: [] // 第二阶段不提供工具，专注格式化
    });

    try {
      const stage2Response = await formattingAgent.invoke({
        messages: [
          { role: "system", content: stage2SystemPrompt },
          { role: "user", content: `Based on the Stage 1 data exploration results below, generate the required JSON format for test tasks:\n\nStage 1 Summary:\n${stage1Summary}\n\nPlease generate the JSON response following the exact format specified in OUTPUT_RULES.` }
        ]
      });

      // 解析第二阶段的JSON响应
      const parsed = this.parseStage2Response(stage2Response);
      
      if (parsed) {
        console.log(`[PlanAgent] Stage 2 completed successfully. Generated ${parsed.tasks?.length || 0} tasks`);
        return {
          success: true,
          parsedTasks: parsed
        };
      } else {
        console.error("[PlanAgent] Stage 2 failed to generate valid JSON");
        return {
          success: false,
          parsedTasks: null
        };
      }
    } catch (error) {
      console.error("[PlanAgent] Stage 2 (Formatting) failed:", error);
      return {
        success: false,
        parsedTasks: null
      };
    }
  }

  /**
   * 总结第一阶段的结果，为第二阶段提供清晰的输入
   */
  private summarizeStage1Results(conversationHistory: any[], realData: any): string {
    const summary = {
      dataExploration: "Stage 1 explored the database and gathered the following information:",
      realDataFound: realData,
      keyFindings: [] as string[],
      toolCallResults: [] as any[]
    };

    // 提取工具调用结果
    for (const message of conversationHistory) {
      if (message.type === 'tool' || message.role === 'tool') {
        summary.toolCallResults.push({
          tool: message.name || 'unknown',
          result: message.content
        });
      }
    }

    // 生成关键发现
    if (realData.userIds?.length > 0) {
      summary.keyFindings.push(`Found ${realData.userIds.length} real user IDs: ${realData.userIds.slice(0, 3).join(', ')}${realData.userIds.length > 3 ? '...' : ''}`);
    }
    if (realData.taskIds?.length > 0) {
      summary.keyFindings.push(`Found ${realData.taskIds.length} real task IDs: ${realData.taskIds.slice(0, 3).join(', ')}${realData.taskIds.length > 3 ? '...' : ''}`);
    }
    if (realData.projectIds?.length > 0) {
      summary.keyFindings.push(`Found ${realData.projectIds.length} real project IDs: ${realData.projectIds.slice(0, 3).join(', ')}${realData.projectIds.length > 3 ? '...' : ''}`);
    }

    return JSON.stringify(summary, null, 2);
  }

  /**
   * 解析第二阶段的JSON响应
   */
  private parseStage2Response(response: any): any {
    try {
      // 归一化响应为消息数组
      let msgs: any[] = [];
      if (response && Array.isArray((response as any).messages)) {
        msgs = (response as any).messages as any[];
      } else if (response && (response as any).content) {
        msgs = [response as any];
      } else if (Array.isArray(response)) {
        msgs = response as any[];
      }

      if (!msgs || msgs.length === 0) {
        console.error("[PlanAgent] No response messages from formatting agent");
        return null;
      }

      const last = msgs[msgs.length - 1] as any;
      const rawContent = last?.content;

      const extractText = (c: any): string => {
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          return c
            .map((p: any) => {
              if (typeof p === "string") return p;
              if (p && typeof p === "object") {
                if (typeof p.text === "string") return p.text;
                if (typeof p.content === "string") return p.content;
              }
              return "";
            })
            .filter(Boolean)
            .join("\n")
            .trim();
        }
        if (c && typeof c === "object") {
          if (typeof (c as any).text === "string") return (c as any).text;
        }
        try {
          return JSON.stringify(c);
        } catch {
          return "";
        }
      };

      let text = extractText(rawContent) || "";
      console.log("[PlanAgent] Stage 2 raw response content:", text);

      // 去除markdown代码块围栏
      text = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();

      // 从文本中提取首个完整且配平的 JSON
      const extractBalancedJson = (s: string): string | null => {
        const firstBrace = s.indexOf("{");
        const firstBracket = s.indexOf("[");
        const start = firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);
        if (start === -1) return null;
        const startChar = s[start];
        const open = startChar === "{" ? "{" : "[";
        const close = startChar === "{" ? "}" : "]";
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = start; i < s.length; i++) {
          const ch = s[i];
          if (escape) {
            escape = false;
            continue;
          }
          if (inString) {
            if (ch === "\\") {
              escape = true;
            } else if (ch === '"') {
              inString = false;
            }
            continue;
          } else {
            if (ch === '"') {
              inString = true;
              continue;
            }
            if (ch === open) depth++;
            else if (ch === close) {
              depth--;
              if (depth === 0) return s.slice(start, i + 1);
            }
          }
        }
        return null;
      };

      // 先直接解析；失败则尝试配平提取
      try {
        const parsed = JSON.parse(text);
        console.log("[PlanAgent] Stage 2 successfully parsed JSON (direct)");
        return parsed;
      } catch {
        const extracted = extractBalancedJson(text);
        if (extracted) {
          try {
            const parsed = JSON.parse(extracted);
            console.log("[PlanAgent] Stage 2 successfully parsed JSON (extracted)");
            return parsed;
          } catch (e) {
            console.error("[PlanAgent] Stage 2 failed to parse extracted JSON:", e);
          }
        } else {
          console.error("[PlanAgent] Stage 2 no JSON found in response");
        }
      }
    } catch (e) {
      console.error("[PlanAgent] Error while parsing Stage 2 response:", e);
    }
    
    return null;
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
          console.log("[PlanAgent] store.put completed successfully", payload);

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

    // Removed unused variables from old single-stage implementation
    // systemPrompt, batchInfoContext, toolsContext are handled within the two-stage methods

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
    // planningContext is used directly in stage methods

    // —— 输出规则（强约束，仅允许结构化 JSON） ——
    const outputRules = [
      "OUTPUT_RULES:",
      "- You MUST return only a JSON object with the following structure:",
      "- Root object must have: batchIndex (number), tasks (array)",
      "- Each task object must have:",
      "  * batchIndex: number (must equal root batchIndex)",
      "  * taskId: string (1-64 chars, only letters/numbers/underscore/dot/colon/dash)",
      "  * toolName: string (exact tool name from tools list)",
      "  * description: string (task description)",
      "  * parameters: object or string (tool parameters)",
      "  * complexity: 'low' | 'medium' | 'high'",
      "  * isRequiredValidateByDatabase: boolean (true for operations that modify DB or need validation)",
      "- All taskIds within same batch must be unique",
      "- Each task's batchIndex must equal the root batchIndex",
      "- Tasks must ONLY use tools in this batch; use exact tool name from tools list.",
      "- Parameters must conform to the tool inputSchema.",
      "- No code fences, no markdown, no natural language outside JSON.",
    ].join("\n");

    try {
      // 第一阶段：数据查询规划阶段
      console.log(`[PlanAgent] Starting Stage 1: Data Query Planning`);
      const stage1Result = await this.executeDataQueryStage(
        threadId,
        batchIndex,
        selectedToolMeta,
        planningContext
      );

      if (!stage1Result.success) {
        console.error(`[PlanAgent] Stage 1 failed for batch ${batchIndex}`);
        return {
          messages: [
            new AIMessage({
              content: `第一阶段数据查询失败，批次 ${batchIndex}`,
            }),
          ],
        };
      }

      // 第二阶段：格式化阶段
      console.log(`[PlanAgent] Starting Stage 2: Formatting`);
      const stage2Result = await this.executeFormattingStage(
        threadId,
        batchIndex,
        selectedToolMeta,
        stage1Result.conversationHistory,
        stage1Result.realData,
        outputRules
      );

      if (!stage2Result.success || !stage2Result.parsedTasks) {
        console.error(`[PlanAgent] Stage 2 failed for batch ${batchIndex}`);
        return {
          messages: [
            new AIMessage({
              content: `第二阶段格式化失败，批次 ${batchIndex}`,
            }),
          ],
        };
      }

      const parsed = stage2Result.parsedTasks;

      console.log(
        "[PlanAgent] Two-stage planning completed successfully"
      );

      if (parsed) {
        // —— 持久化当前批次的规划结果到 task_plans ——
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

  routeModelOutput(
    _state: typeof MessagesAnnotation.State
  ): "plan-node" {
    // Always route to plan-node for batch processing
    return "plan-node"
  }

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
