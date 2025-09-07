import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { BaseAgent, AgentConfig } from "../../BaseAgent/BaseAgent.js";

import { AIMessage } from "@langchain/core/messages";
import { ConfigurationSchema } from "../../ModelUtils/Config.js";
import { RunnableConfig } from "@langchain/core/runnables";
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
    this.llm = await loadChatModel("openai/deepseek-ai/DeepSeek-V3");
  }

  async planNode(state: typeof MessagesAnnotation.State, config: RunnableConfig) {
    //通过state.messages来获取传入的消息
    // 多轮planNode的调用 thread_id保持不变
    console.log("[PlanAgent] config thread_id:", config?.configurable?.thread_id);

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

    // 读取/初始化批次状态
    const existingBatchState = (await this.getSharedMemory(batchMemKey)) as
      | { batchIndex: number; toolsPerBatch: number; totalTools: number; totalBatches: number }
      | undefined;

    const toolsPerBatch = existingBatchState?.toolsPerBatch ?? 5;
    const totalTools = tools.length;
    const totalBatches = Math.ceil(totalTools / toolsPerBatch);
    const batchIndex = existingBatchState?.batchIndex ?? 0; // 从 0 开始
    const startIndex = batchIndex * toolsPerBatch;
    const endIndex = startIndex + toolsPerBatch;

    // 计算当前批次应注入的工具子集
    const selectedTools = tools.slice(startIndex, endIndex);

    // 如果是首次或工具清单发生变化，则（重新）保存批次元信息
    if (!existingBatchState || existingBatchState.totalTools !== totalTools || existingBatchState.toolsPerBatch !== toolsPerBatch) {
      await this.saveSharedMemory(batchMemKey, {
        batchIndex, // 保持当前批次索引
        toolsPerBatch,
        totalTools,
        totalBatches,
      });
    }

    const selectedToolMeta = selectedTools.map((t: any) => ({
      name: t?.name ?? t?.toolName ?? "",
      description: t?.description ?? "",
      // 兼容多种工具实现的schema字段命名
      inputSchema: t?.schema ?? t?.input_schema ?? t?.parametersSchema ?? undefined,
    }));

    let systemPrompt = TOOL_MESSAGE_EXTRACT_PROMPT.replace(
      "{system_time}",
      new Date().toISOString(),
    );

    // 当前批次的信息，帮助模型在输出中设置正确的 batchIndex，并仅围绕该批次工具生成任务
    const batchInfoContext = `You are generating test tasks ONLY for the current tool batch.\n` +
      `BATCH_INFO=\n${JSON.stringify({
        threadId,
        batchIndex,
        totalBatches,
        toolsPerBatch,
        totalTools,
        startIndex,
        endIndex: Math.min(endIndex, totalTools),
        toolNames: selectedToolMeta.map((t) => t.name),
      }, null, 2)}`;

    const toolsContext = `You have the following available tools for THIS BATCH (5 per call). Use the exact value in the \"name\" field as task.toolName when planning. Do NOT invent new tool names. Keep parameters aligned with inputSchema.\nTOOLS_JSON=\n${JSON.stringify(selectedToolMeta, null, 2)}`;

    // —— 规划上下文摘要（从共享内存读取，不存在则从最后一条用户指令提取并持久化） ——
    const planningContextKey = `planNode:${threadId}:planningContext`;
    let planningContextItem = await this.getSharedMemory(planningContextKey);
    let planningContext: string;
    if (!planningContextItem) {
      const msgs: any[] = Array.isArray((state as any)?.messages) ? (state as any).messages : [];
      let lastUserText = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        const role = m?.role || (typeof m?._getType === 'function' ? m._getType() : undefined);
        if (role === "user" || role === "human") {
          const c = m?.content;
          if (typeof c === "string") {
            lastUserText = c;
          } else {
            try { lastUserText = JSON.stringify(c); } catch { lastUserText = String(c); }
          }
          break;
        }
      }
      const truncate = (s: string, max = 800) => (s && s.length > max ? s.slice(0, max) + "..." : s);
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
      await this.saveSharedMemory(planningContextKey, planningContextObj);
      planningContext = `PLANNING_CONTEXT=\n${JSON.stringify(planningContextObj, null, 2)}`;
    } else {
      const ctx = typeof planningContextItem === "string" ? planningContextItem : JSON.stringify(planningContextItem, null, 2);
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
      await loadChatModel("openai/deepseek-ai/DeepSeek-V3")
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
        console.log("[PlanAgent] Parsed structured output:", (response as any).parsed);
        // 可选：打印原始消息，便于排查模型是否仍返回markdown
        if ((response as any).raw) {

          console.log("[PlanAgent] Raw message content:", (response as any).raw.content);
        }
        console.log(
          "[PlanAgent] LLM response end:==============================================="
        );

        // —— 持久化当前批次的规划结果到 task_plans ——
        const parsed: any = (response as any).parsed;
        const tasksArray: any[] = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
        if (tasksArray.length > 0) {
          // 计算当前批次已有的最大顺序号，避免重复
          const existing = await this.getBatchTasks(threadId, batchIndex);
          const safeThreadId = String(threadId).replace(/[^A-Za-z0-9_.:-]/g, "_");
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

          const toSave = tasksArray.map((t: any) => ({
            batchIndex: typeof t?.batchIndex === 'number' ? t.batchIndex : (typeof parsed?.batchIndex === 'number' ? parsed.batchIndex : batchIndex),
            taskId: `${safeThreadId}-${batchIndex}-${seq++}`,
            toolName: t.toolName,
            description: t.description,
            parameters: t.parameters,
            complexity: t.complexity,
            isRequiredValidateByDatabase: t.isRequiredValidateByDatabase,
          }));
          await this.memoryManager.saveTaskPlans(threadId, toSave);
          console.log(`[PlanAgent] Persisted ${toSave.length} tasks to task_plans for planId=${threadId}, batchIndex=${toSave[0].batchIndex}`);
        } else {
          console.warn("[PlanAgent] No tasks found in parsed output; nothing to persist.");
        }

        // 仅当仍有工具可用（未越界）时，自增批次索引
        if (startIndex < totalTools) {
          await this.saveSharedMemory(batchMemKey, {
            batchIndex: batchIndex + 1,
            toolsPerBatch,
            totalTools,
            totalBatches,
          });
        }

        return {
          messages: [
            new AIMessage({ content: JSON.stringify((response as any).parsed) }),
          ],
        };
      } else {
        console.warn(
          "[PlanAgent] Unexpected response shape from withStructuredOutput:",
          response,
        );
        return {
          messages: [new AIMessage({ content: JSON.stringify(response) })],
        };
      }
    } catch (error) {
      console.error("[PlanAgent] Error in planNode:", error);
      const errorMessage = new AIMessage({
        content: `执行出错: ${error}`,
      });
      return {
        messages: [errorMessage],
      };
    }
  }
  // agent执行终端机制
  startOrContinuePlan() {}

  async getBatchTasks(planId: string, batchIndex: number): Promise<TaskPlanedForTest[]> {
    try {
      return await this.memoryManager.getTaskPlansByBatch(planId, batchIndex);
    } catch (error) {
      console.error(`[PlanAgent] Error getting tasks for plan ${planId}, batch ${batchIndex}:`, error);
      return [];
    }
  }

  async takeActionOrGeneratePlan(
    _state: typeof MessagesAnnotation.State,
  ): Promise<"plan-node" | typeof END> {
    try {
      const threadId = this.lastThreadId;
      if (!threadId) {
        // 首轮或没有获取到 threadId，默认继续到 plan-node
        return "plan-node";
      }
      const batchMemKey = `planNode:${threadId}:toolBatch`;
      const batchState = (await this.getSharedMemory(batchMemKey)) as
        | { batchIndex: number; toolsPerBatch: number; totalTools: number; totalBatches: number }
        | null;

      if (batchState && typeof batchState.batchIndex === 'number' && typeof batchState.totalBatches === 'number') {
        // 当 batchIndex >= totalBatches 时，说明所有批次已完成
        if (batchState.batchIndex >= batchState.totalBatches) {
          console.log(`[PlanAgent] All batches completed (batchIndex=${batchState.batchIndex}, totalBatches=${batchState.totalBatches}). Ending.`);
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
        ["plan-node", END],
      );

    return builder.compile({
      checkpointer: this.memoryManager.getCheckpointer(),
      store: this.memoryManager.getStore(),
      interruptBefore: [],
      interruptAfter: []
    });
  }
}
