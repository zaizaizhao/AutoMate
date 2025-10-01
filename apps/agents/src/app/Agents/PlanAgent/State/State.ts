import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
/**
 * PlanAgent状态注解
 * 
 * 支持LLM驱动的迭代数据查询机制，包括：
 * - 数据充分性评估
 * - 迭代数据获取
 * - 查询轮次限制
 * - 查询历史跟踪
 */
export const PlanAgentAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  // 当前工具索引，用于跟踪处理进度
  currentToolIndex: Annotation<number>({
    reducer: (x, y) => y ?? x ?? 0,
    default: () => 0,
  }),
  // 当前正在处理的工具信息
  currentTool: Annotation<any>({
    reducer: (x, y) => y ?? x ?? null,
    default: () => null,
  }),
  // 数据库查询结果，存储从data-query-node获取的数据
  queryResults: Annotation<Record<string, any>>({
    reducer: (x, y) => ({ ...x, ...y }),
    default: () => ({}),
  }),
  // 已生成的计划列表
  generatedPlans: Annotation<any[]>({
    reducer: (x, y) => [...(x ?? []), ...(y ?? [])],
    default: () => [],
  }),
  // 批次信息
  batchInfo: Annotation<{
    batchIndex: number;
    totalBatches: number;
    toolsPerBatch: number;
    totalTools: number;
  } | null>({
    reducer: (x, y) => y ?? x ?? null,
    default: () => null,
  }),
  // 工具列表
  toolsList: Annotation<any[]>({
    reducer: (x, y) => y ?? x ?? [],
    default: () => [],
  }),
  
  // LLM驱动数据查询相关字段
  
  /**
   * 数据查询请求：由LLM在plan-generation-node中生成
   * 当LLM评估当前数据不足时，会生成此请求以获取更多数据
   */
  dataQueryRequest: Annotation<{
    needsMoreData: boolean;    // 是否需要更多数据
    missingData?: string[];    // 缺失的数据类型列表
    reason: string;            // 需要更多数据的原因
    confidence: number;        // 评估结果的置信度 (0-1)
  } | null>({
    reducer: (x, y) => y ?? x ?? null,
    default: () => null,
  }),
  
  /**
   * 查询轮次：跟踪当前的数据查询轮次
   * 用于实现查询轮次限制，防止无限循环
   */
  queryRound: Annotation<number>({
    reducer: (x, y) => y ?? x ?? 0,
    default: () => 0,
  }),
  
  /**
   * 数据评估结果：LLM对当前数据充分性的评估
   * 包含详细的评估信息和建议
   */
  dataAssessment: Annotation<{
    isDataSufficient: boolean; // 数据是否充足
    missingData: string[];     // 缺失的数据类型
    assessmentReason: string;  // 评估理由
    confidence: number;        // 评估置信度
  } | null>({
    reducer: (x, y) => y ?? x ?? null,
    default: () => null,
  }),
  
  /**
   * 查询历史：记录所有数据查询的历史信息
   * 用于调试、监控和避免重复查询
   */
  queryHistory: Annotation<Array<{
    round: number;             // 查询轮次
    request: any;              // 查询请求详情
    timestamp: string;         // 查询时间戳
    queriesExecuted: number;   // 执行的查询数量
    success: boolean;          // 查询是否成功
  }>>({
    reducer: (x, y) => [...(x ?? []), ...(y ?? [])],
    default: () => [],
  }),
})
