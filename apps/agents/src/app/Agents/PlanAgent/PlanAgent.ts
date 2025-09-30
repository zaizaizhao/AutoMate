import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
  Annotation,
} from "@langchain/langgraph";

/**
 * PlanAgent状态注解，支持优化后的架构和LLM驱动的数据查询
 * 
 * 支持LLM驱动的迭代数据查询机制，包括：
 * - 数据充分性评估
 * - 迭代数据获取
 * - 查询轮次限制
 * - 查询历史跟踪
 */
const PlanAgentAnnotation = Annotation.Root({
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
import { BaseAgent, AgentConfig } from "../../BaseAgent/BaseAgent.js";
import { getDatabaseAdapter } from "./DatabaseAdapter.js";

import { AIMessage } from "@langchain/core/messages";
// import { ConfigurationSchema } from "../../ModelUtils/Config.js";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { loadChatModel } from "../../ModelUtils/ChatModel.js";
// 这些导入在新架构中不再需要
// import { buildUnifiedPlanPrompts, getSqlToolPrompts } from "./Prompts.js";
import { getPostgresqlHubTools, getTestServerTools } from "../../mcp-servers/mcp-client.js";
import type { TaskPlanedForTest } from "../../Memory/SharedMemoryManager.js";

// ReactAgent已被新架构替代，不再需要导入
// import { createReactAgent } from "@langchain/langgraph/prebuilt";

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
   * 解析SQL查询结果 - 处理JSON字符串格式的响应
   * @param result SQL工具返回的结果
   * @returns 解析后的数据或原始结果
   */
  private parseSqlResult(result: any): any {
    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        // 如果解析成功且有success和data字段，返回data中的rows
        if (parsed && typeof parsed === 'object' && parsed.success && parsed.data) {
          return parsed.data.rows || parsed.data;
        }
        // 否则返回整个解析结果
        return parsed;
      } catch (error) {
        console.warn('[PlanAgent] Failed to parse SQL result as JSON:', error);
        return result;
      }
    }
    return result;
  }

  /**
   * 调用 SQL 工具，兼容不同参数键名（sql | query）并统一解析返回
   */
  private async callSqlWithFallback(
    sqlTool: any,
    query: string
  ): Promise<{ raw: any; parsed: any; usedParam: 'sql' | 'query' }> {
    // 优先尝试 { sql }
    try {
      const raw1 = await sqlTool.call({ sql: query });
      const parsed1 = this.parseSqlResult(raw1);
      // 如果解析后为数组或含 rows，则认为成功
      const ok1 = Array.isArray(parsed1) || (parsed1 && typeof parsed1 === 'object' && Array.isArray((parsed1 as any).rows));
      if (ok1) {
        return { raw: raw1, parsed: Array.isArray(parsed1) ? parsed1 : (parsed1 as any).rows, usedParam: 'sql' };
      }
      // 若不是数组，继续尝试 { query }
    } catch (e) {
      // 继续回退
    }

    try {
      const raw2 = await sqlTool.call({ query });
      const parsed2 = this.parseSqlResult(raw2);
      const result2 = Array.isArray(parsed2) ? parsed2 : (parsed2 && (parsed2 as any).rows);
      return { raw: raw2, parsed: result2 ?? parsed2, usedParam: 'query' };
    } catch (e2) {
      // 双重失败，返回最后的异常信息占位
      return { raw: e2, parsed: null, usedParam: 'query' };
    }
  }

  /**
   * 数据查询节点 - 增强版，支持基于特定需求的目标查询
   * 
   * 支持两种查询模式：
   * 1. 特定查询模式：根据LLM的dataQueryRequest执行目标查询
   *    - 解析查询请求中的缺失数据类型
   *    - 构建并执行相应的SQL查询
   *    - 更新查询历史和轮次
   *    - 清除查询请求以避免重复执行
   * 
   * 2. 基础查询模式：获取数据库schema和样本数据
   *    - 获取所有表的结构信息
   *    - 获取前几个表的样本数据
   *    - 为后续的数据评估提供基础信息
   * 
   * @param state 当前PlanAgent状态
   * @param config LangGraph运行配置
   * @returns 更新后的状态，包含查询结果和历史信息
   */
  async dataQueryNode(
    state: typeof PlanAgentAnnotation.State,
    config: LangGraphRunnableConfig
  ): Promise<Partial<typeof PlanAgentAnnotation.State>> {
    const threadId = (config?.configurable as any)?.thread_id ?? this.lastThreadId ?? "default";
    const { dataQueryRequest, queryRound = 0, queryHistory = [] } = state;
    
    console.log(`[PlanAgent] DataQueryNode started for threadId: ${threadId}`);
    console.log(`[PlanAgent] Query round: ${queryRound + 1}`);
    console.log(`[PlanAgent] Using database URL: ${process.env.TEST_DATABASE_URL ? 'configured' : 'not configured'}`);
    
    if (dataQueryRequest) {
      console.log(`[PlanAgent] Specific data query requested:`, {
        needsMoreData: dataQueryRequest.needsMoreData,
        missingData: dataQueryRequest.missingData,
        reason: dataQueryRequest.reason
      });
    }

    try {
      // 获取数据库MCP工具
      console.log('[PlanAgent] Attempting to get database tools...');
      const dbTools = await getPostgresqlHubTools();
      console.log(`[PlanAgent] Database tools obtained: ${dbTools?.length || 0} tools`);
      
      if (dbTools && dbTools.length > 0) {
        console.log('[PlanAgent] Available database tools:', dbTools.map(tool => ({ name: tool.name, description: tool.description })));
      }

      if (!dbTools || dbTools.length === 0) {
        console.error('[PlanAgent] No database tools available - this may indicate MCP server connection issues');
        console.error('[PlanAgent] Please check:');
        console.error('[PlanAgent] 1. MCP server is running');
        console.error('[PlanAgent] 2. TEST_DATABASE_URL is correctly configured');
        console.error('[PlanAgent] 3. Database connection is accessible');
        return { queryResults: { error: 'No database tools available' } };
      }

      const queryResults: Record<string, any> = {};
      const sqlTool = dbTools.find(tool => tool.name === 'execute_sql');
      
      if (!sqlTool) {
        console.error('[PlanAgent] execute_sql tool not found in available tools');
        return { queryResults: { error: 'execute_sql tool not available' } };
      }

      console.log('[PlanAgent] Found execute_sql tool, proceeding with database queries...');

      // 如果有特定的数据查询请求，执行目标查询
      if (dataQueryRequest && dataQueryRequest.needsMoreData && dataQueryRequest.missingData) {
        console.log('[PlanAgent] Executing specific data queries based on LLM request...');
        const specificQueries = this.buildSpecificQueries(dataQueryRequest.missingData);
        
        for (const queryInfo of specificQueries) {
          try {
            console.log(`[PlanAgent] Executing specific query for ${queryInfo.type}: ${queryInfo.query}`);
            const { raw, parsed, usedParam } = await this.callSqlWithFallback(sqlTool, queryInfo.query);
            queryResults[queryInfo.key] = parsed;
            console.log(`[PlanAgent] Specific query ${queryInfo.type} successful:`, {
              usedParam,
              resultType: typeof raw,
              isArray: Array.isArray(parsed),
              length: Array.isArray(parsed) ? parsed.length : 'N/A'
            });
          } catch (error) {
            console.error(`[PlanAgent] Specific query ${queryInfo.type} failed:`, error);
            queryResults[`${queryInfo.key}_error`] = error instanceof Error ? error.message : String(error);
          }
        }
        
        // 更新查询历史
        const newQueryHistory = [...queryHistory, {
          round: queryRound + 1,
          request: dataQueryRequest,
          timestamp: new Date().toISOString(),
          queriesExecuted: specificQueries.length,
          success: specificQueries.length > Object.keys(queryResults).filter(k => k.includes('_error')).length
        }];
        
        return {
          queryResults,
          queryHistory: newQueryHistory,
          queryRound: queryRound + 1,
          dataQueryRequest: undefined // 清除请求，避免重复执行
        };
      }

      // 默认的基础schema查询（首次查询或无特定请求时）
      console.log('[PlanAgent] Executing basic schema queries...');
      const dbAdapter = getDatabaseAdapter();
      console.log(`[PlanAgent] Using database adapter for type: ${dbAdapter.constructor.name}`);
      
      const schemaQueries = [
        // 动态生成的表查询
        dbAdapter.getTableListQuery(),
        // 动态生成的列查询
        dbAdapter.getColumnInfoQuery()
      ];
      
      console.log(`[PlanAgent] Generated queries:`, schemaQueries);

      let querySuccessCount = 0;
      for (let i = 0; i < schemaQueries.length; i++) {
        const query = schemaQueries[i];
        const queryType = i === 0 ? 'tables' : 'columns';
        
        try {
          console.log(`[PlanAgent] Executing ${queryType} query: ${query}`);
          const { raw, parsed, usedParam } = await this.callSqlWithFallback(sqlTool, query);
          console.log(`[PlanAgent] Raw ${queryType} query result:`, {
            usedParam,
            type: typeof raw,
            isString: typeof raw === 'string',
            content: typeof raw === 'string' ? raw.substring(0, 200) + '...' : raw
          });

          queryResults[queryType] = parsed;
          querySuccessCount++;

          console.log(`[PlanAgent] ${queryType} query successful:`, {
            usedParam,
            resultType: typeof raw,
            parsedType: typeof parsed,
            isArray: Array.isArray(parsed),
            length: Array.isArray(parsed) ? parsed.length : 'N/A',
            sample: Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : parsed
          });
        } catch (error) {
          console.error(`[PlanAgent] ${queryType} query failed:`, {
            query,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            databaseUrl: process.env.TEST_DATABASE_URL ? 'configured' : 'not configured'
          });
          queryResults[`${queryType}_error`] = error instanceof Error ? error.message : String(error);
        }
      }

      // 如果基础查询都失败了，尝试更简单的查询
      if (querySuccessCount === 0) {
        console.log('[PlanAgent] Basic schema queries failed, trying simple table listing...');
        try {
          const simpleQuery = dbAdapter.getSimpleTableListQuery();
          console.log(`[PlanAgent] Executing simple query: ${simpleQuery}`);
          const { raw, parsed, usedParam } = await this.callSqlWithFallback(sqlTool, simpleQuery);
          queryResults.tables_simple = parsed;
          console.log('[PlanAgent] Simple table query successful:', { usedParam, type: typeof raw });
        } catch (error) {
          console.error('[PlanAgent] Even simple table query failed:', error);
          queryResults.connection_error = error instanceof Error ? error.message : String(error);
        }
      }

      // 获取一些示例数据（从主要表中）
      if (queryResults.tables && Array.isArray(queryResults.tables) && queryResults.tables.length > 0) {
        console.log(`[PlanAgent] Found ${queryResults.tables.length} tables, getting sample data...`);
        
        for (const tableRow of queryResults.tables.slice(0, 3)) { // 限制查询前3个表
          const tableName = tableRow.table_name || tableRow.TABLE_NAME;
          if (tableName) {
            try {
              console.log(`[PlanAgent] Getting sample data from table: ${tableName}`);
              const sampleQuery = dbAdapter.getSampleDataQuery(tableName, 5);
              const { raw, parsed, usedParam } = await this.callSqlWithFallback(sqlTool, sampleQuery);
              queryResults[`sample_${tableName}`] = parsed;
              console.log(`[PlanAgent] Sample data from ${tableName}:`, {
                usedParam,
                resultType: typeof raw,
                isArray: Array.isArray(parsed),
                length: Array.isArray(parsed) ? parsed.length : 'N/A'
              });
            } catch (error) {
              console.warn(`[PlanAgent] Failed to get sample data from ${tableName}:`, error instanceof Error ? error.message : String(error));
              queryResults[`sample_${tableName}_error`] = error instanceof Error ? error.message : String(error);
            }
          }
        }
      } else {
        console.warn('[PlanAgent] No tables found or tables result is not an array:', queryResults.tables);
      }

      // 记录最终结果统计
      const resultKeys = Object.keys(queryResults);
      const errorKeys = resultKeys.filter(key => key.includes('error'));
      const dataKeys = resultKeys.filter(key => !key.includes('error'));
      
      console.log('[PlanAgent] DataQueryNode completed:', {
        totalResults: resultKeys.length,
        dataResults: dataKeys.length,
        errors: errorKeys.length,
        hasData: dataKeys.length > 0
      });
      
      if (errorKeys.length > 0) {
        console.warn('[PlanAgent] Errors encountered:', errorKeys);
      }
      
      if (dataKeys.length === 0) {
        console.error('[PlanAgent] No data retrieved from database - this will affect plan generation');
      }

      return {
        queryResults
      };
    } catch (error) {
      console.error('[PlanAgent] DataQueryNode critical error:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        databaseUrl: process.env.TEST_DATABASE_URL ? 'configured' : 'not configured'
      });
      return {
        queryResults: { 
          error: error instanceof Error ? error.message : String(error),
          critical: true
        }
      };
    }
  }

  /**
   * 计划生成节点 - 增强版，支持LLM驱动的数据充分性评估
   * 
   * 工作流程：
   * 1. 获取当前状态和数据
   * 2. 使用LLM评估数据充分性
   * 3. 如果数据不足且未达到最大查询轮次：
   *    - 生成数据查询请求
   *    - 更新查询轮次和历史
   *    - 返回查询请求状态
   * 4. 如果数据充足或达到最大轮次：
   *    - 生成测试计划
   *    - 保存计划到数据库
   *    - 返回成功状态
   * 
   * @param state 当前PlanAgent状态
   * @returns 更新后的状态，包含数据评估结果或生成的计划
   */
  async planGenerationNode(
    state: typeof PlanAgentAnnotation.State,
    config: LangGraphRunnableConfig
  ): Promise<Partial<typeof PlanAgentAnnotation.State>> {
    const threadId = (config?.configurable as any)?.thread_id ?? this.lastThreadId ?? "default";
    console.log(`[PlanAgent] PlanGenerationNode started for threadId: ${threadId}`);

    try {
      // 确保LLM已初始化
      if (!this.llm) {
        console.log('[PlanAgent] LLM not initialized, initializing now...');
        await this.initializellm();
        if (!this.llm) {
          console.error('[PlanAgent] Failed to initialize LLM');
          return { generatedPlans: [] };
        }
      }

      const { currentTool, queryResults, batchInfo, currentToolIndex, queryRound, dataQueryRequest } = state;
      
      if (!currentTool) {
        console.warn('[PlanAgent] No current tool specified');
        return { generatedPlans: [] };
      }

      console.log(`[PlanAgent] Generating plan for tool: ${currentTool.name}, Query Round: ${queryRound || 0}`);

      // 根据工具schema动态查询相关的真实数据
      const enhancedQueryResults = await this.enhanceQueryResultsForTool(currentTool, queryResults || {});

      // 第一步：LLM评估数据充分性
      const dataAssessment = await this.assessDataSufficiency(currentTool, enhancedQueryResults, queryRound || 0);
      console.log(`[PlanAgent] Data assessment for ${currentTool.name}:`, dataAssessment);

      // 如果数据不足且未达到最大查询轮次，请求更多数据
      if (!dataAssessment.isDataSufficient && (queryRound || 0) < 8) {
        console.log(`[PlanAgent] Data insufficient for ${currentTool.name}, requesting additional data`);
        
        const queryRequest = {
          needsMoreData: true,
          missingData: dataAssessment.missingData,
          reason: dataAssessment.assessmentReason,
          confidence: dataAssessment.confidence
        };

        return {
          dataAssessment,
          dataQueryRequest: queryRequest,
          queryRound: (queryRound || 0) + 1,
          queryHistory: [{
            round: queryRound || 0,
            request: queryRequest,
            timestamp: new Date().toISOString(),
            queriesExecuted: 0,
            success: false
          }]
        };
      }

      // 数据充分，继续生成计划
      console.log(`[PlanAgent] Data sufficient for ${currentTool.name}, proceeding with plan generation`);
      
      // 构建针对单个工具的提示词
      const toolPrompt = this.buildSingleToolPrompt(currentTool, enhancedQueryResults, batchInfo, currentToolIndex);
      
      // 直接调用LLM生成单个工具的测试计划
      const response = await this.llm.invoke([
        { role: "system", content: toolPrompt },
        { role: "user", content: `Generate a test task for the tool "${currentTool.name}" using the provided real database data. Return a valid JSON object with the task details.` }
      ]);

      console.log(`[PlanAgent] LLM response for ${currentTool.name}:`, response);

      // 解析LLM响应
      let parsedPlan = null;
      try {
        const content = response.content || response;
        let text = typeof content === 'string' ? content : JSON.stringify(content);
        
        // 去除markdown代码块
        text = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();
        
        // 尝试解析JSON
        parsedPlan = JSON.parse(text);
        
        // 确保包含必要字段
        if (parsedPlan && typeof parsedPlan === 'object') {
          parsedPlan.toolName = parsedPlan.toolName || currentTool.name;
          parsedPlan.batchIndex = batchInfo?.batchIndex ?? 0;
          parsedPlan.expectedResult = parsedPlan.expectedResult || 'success';
          
          // 验证parameters字段
          if (!parsedPlan.parameters || typeof parsedPlan.parameters !== 'object') {
            parsedPlan.parameters = {};
          }
        }
      } catch (error) {
        console.error(`[PlanAgent] Failed to parse plan for ${currentTool.name}:`, error);
        // 创建一个基本的fallback计划
        parsedPlan = {
          toolName: currentTool.name,
          description: `Test task for ${currentTool.name}`,
          parameters: {},
          complexity: "medium",
          batchIndex: batchInfo?.batchIndex ?? 0,
          expectedResult: "success",
          isRequiredValidateByDatabase: false
        };
      }

      console.log(`[PlanAgent] Generated plan for ${currentTool.name}:`, parsedPlan);
      
      // 保存计划到数据库
      if (parsedPlan) {
        try {
          const taskPlan: any = {
            batchIndex: parsedPlan.batchIndex,
            taskId: `${threadId}_${currentTool.name}_${Date.now()}`,
            toolName: parsedPlan.toolName,
            description: parsedPlan.description,
            parameters: parsedPlan.parameters,
            complexity: parsedPlan.complexity,
            isRequiredValidateByDatabase: parsedPlan.isRequiredValidateByDatabase || false,
            expectedResult: parsedPlan.expectedResult
          };
          
          await this.memoryManager.saveTaskPlan(threadId, taskPlan);
          console.log(`[PlanAgent] Successfully saved plan to database for ${currentTool.name}`);
        } catch (saveError) {
          console.error(`[PlanAgent] Failed to save plan to database for ${currentTool.name}:`, saveError);
        }
      }
      
      // 记录成功的查询历史
      const successHistory = {
        round: queryRound || 0,
        request: dataQueryRequest || null,
        timestamp: new Date().toISOString(),
        queriesExecuted: Object.keys(enhancedQueryResults).length,
        success: true
      };
      
      return {
        generatedPlans: parsedPlan ? [parsedPlan] : [],
        currentTool: null, // 清除currentTool避免无限循环
        dataAssessment,
        dataQueryRequest: null, // 清除查询请求
        queryHistory: [successHistory]
      };
    } catch (error) {
      console.error('[PlanAgent] PlanGenerationNode error:', error);
      return { generatedPlans: [] };
    }
  }

  /**
   * LLM驱动的数据充分性评估方法
   * 
   * 使用LLM分析当前可用数据，判断是否足够生成有效的测试计划。
   * 如果数据不足，LLM会指出具体缺失的数据类型和原因。
   * 
   * 评估维度：
   * - 数据完整性：是否包含必要的实体数据
   * - 数据质量：数据是否真实、有效
   * - 数据关联性：是否包含必要的关联关系
   * - 测试覆盖度：数据是否支持全面的测试场景
   * 
   * @param tool 当前要测试的工具定义
   * @param queryResults 当前可用的查询结果数据
   * @param currentRound 当前查询轮次（用于调整评估策略）
   * @returns 数据充分性评估结果，包含是否充足、缺失数据、评估理由和置信度
   */
  private async assessDataSufficiency(
    tool: any,
    queryResults: Record<string, any>,
    currentRound: number
  ): Promise<{
    isDataSufficient: boolean;
    missingData: string[];
    assessmentReason: string;
    confidence: number;
  }> {
    try {
      const toolSchema = tool?.schema ?? tool?.input_schema ?? tool?.parametersSchema ?? {};
      const properties = toolSchema.properties || {};
      
      // 构建数据评估提示词
      const assessmentPrompt = `You are a data sufficiency analyst. Evaluate whether the provided database data is sufficient to generate a meaningful test task for the given tool.

TOOL INFORMATION:
Name: ${tool.name}
Description: ${tool.description || 'No description'}
Parameters: ${JSON.stringify(properties, null, 2)}

AVAILABLE DATA:
${JSON.stringify(queryResults, null, 2)}

CURRENT QUERY ROUND: ${currentRound}

EVALUATION CRITERIA:
1. Are there sufficient real data records to populate tool parameters?
2. Do the available data types match the tool's parameter requirements?
3. Is there enough variety in the data for meaningful testing?
4. Are there any critical missing data types that would prevent effective testing?

RETURN A JSON OBJECT WITH:
{
  "isDataSufficient": boolean,
  "missingData": ["list of missing data types or tables"],
  "assessmentReason": "detailed explanation of the assessment",
  "confidence": number (0-1, confidence in the assessment)
}

Be strict in your assessment - only mark as sufficient if you can generate a realistic, meaningful test with actual data.`;

      const response = await this.llm.invoke([
        { role: "system", content: assessmentPrompt },
        { role: "user", content: "Evaluate the data sufficiency for this tool. Return only the JSON assessment." }
      ]);

      // 解析LLM响应
      let assessment = null;
      try {
        const content = response.content || response;
        let text = typeof content === 'string' ? content : JSON.stringify(content);
        text = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();
        assessment = JSON.parse(text);
      } catch (parseError) {
        console.warn('[PlanAgent] Failed to parse data assessment, using fallback');
        // 基于简单规则的fallback评估
        const hasData = Object.keys(queryResults).some(key => 
          !key.includes('error') && queryResults[key] && 
          (Array.isArray(queryResults[key]) ? queryResults[key].length > 0 : true)
        );
        
        assessment = {
          isDataSufficient: hasData && currentRound >= 1,
          missingData: hasData ? [] : ['sample_data', 'table_records'],
          assessmentReason: hasData ? 'Basic data available' : 'No meaningful data found',
          confidence: 0.6
        };
      }

      // 验证和标准化评估结果
      return {
        isDataSufficient: Boolean(assessment?.isDataSufficient),
        missingData: Array.isArray(assessment?.missingData) ? assessment.missingData : [],
        assessmentReason: assessment?.assessmentReason || 'Assessment failed',
        confidence: typeof assessment?.confidence === 'number' ? 
          Math.max(0, Math.min(1, assessment.confidence)) : 0.5
      };
    } catch (error) {
      console.error('[PlanAgent] Data assessment error:', error);
      return {
        isDataSufficient: currentRound >= 2, // 默认2轮后认为充分
        missingData: ['assessment_failed'],
        assessmentReason: 'Assessment process failed, using fallback logic',
        confidence: 0.3
      };
    }
  }

  /**
   * 根据LLM评估的缺失数据构建通用的数据库发现查询
   * 
   * 采用动态发现策略，不依赖特定表名：
   * - schema_info: 获取数据库结构信息
   * - table_samples: 获取各表的样本数据
   * - relationships: 获取表间关系信息
   * - data_types: 获取列数据类型信息
   * 
   * 每个查询包含：
   * - type: 数据类型标识
   * - query: 具体的SQL查询语句
   * - key: 结果存储的键名
   * 
   * @param missingData LLM识别的缺失数据类型列表
   * @returns 结构化的查询定义数组
   */
  private buildSpecificQueries(missingData: string[]): Array<{type: string, query: string, key: string}> {
    const queries: Array<{type: string, query: string, key: string}> = [];
    const dbAdapter = getDatabaseAdapter();
    
    for (const missing of missingData) {
      const missingLower = missing.toLowerCase();
      
      // 根据缺失数据类型构建通用发现查询
       if (missingLower.includes('schema') || missingLower.includes('structure') || missingLower.includes('table')) {
         // 数据库结构信息 - 使用适配器
         queries.push({
           type: 'schema_info', 
           query: dbAdapter.getTableListQuery(), 
           key: 'schema_tables'
         });
         queries.push({
           type: 'column_info', 
           query: dbAdapter.getColumnInfoQuery(), 
           key: 'schema_columns'
         });
       } else if (missingLower.includes('sample') || missingLower.includes('data') || missingLower.includes('record')) {
         // 样本数据 - 先获取表列表，然后动态查询
         queries.push({
           type: 'table_discovery', 
           query: dbAdapter.getTableListQuery(), 
           key: 'available_tables'
         });
       } else if (missingLower.includes('relationship') || missingLower.includes('foreign') || missingLower.includes('reference')) {
         // 表关系信息 - 使用适配器
         queries.push({
           type: 'relationships', 
           query: dbAdapter.getForeignKeyQuery(), 
           key: 'table_relationships'
         });
       } else if (missingLower.includes('constraint') || missingLower.includes('key')) {
         // 约束和键信息 - 使用适配器
         queries.push({
           type: 'constraints', 
           query: dbAdapter.getConstraintsQuery(), 
           key: 'table_constraints'
         });
       } else {
         // 对于其他描述性文本，使用通用的数据库概览查询
         console.log(`[PlanAgent] Using generic database overview for: "${missing}"`);
         queries.push({
           type: 'database_overview', 
           query: dbAdapter.getDatabaseOverviewQuery(), 
           key: 'db_overview'
         });
       }
    }
    
    // 如果没有特定查询，添加基础的数据库发现查询
     if (queries.length === 0) {
       queries.push({
         type: 'basic_discovery', 
         query: dbAdapter.getTableListQuery(), 
         key: 'basic_tables'
       });
       queries.push({
         type: 'basic_stats', 
         query: dbAdapter.getDatabaseOverviewQuery(), 
         key: 'basic_stats'
       });
     }
    
    return queries;
  }

  // 根据工具schema动态查询相关的真实数据
  private async enhanceQueryResultsForTool(
    tool: any, 
    baseQueryResults: Record<string, any>
  ): Promise<Record<string, any>> {
    console.log(`[PlanAgent] Enhancing query results for tool: ${tool.name}`);
    
    try {
      const enhancedResults = { ...baseQueryResults };
      const toolSchema = tool?.schema ?? tool?.input_schema ?? tool?.parametersSchema ?? {};
      const properties = toolSchema.properties || {};
      
      // 获取数据库工具
      const dbTools = await getPostgresqlHubTools();
      const sqlTool = dbTools?.find(t => t.name === 'execute_sql');
      
      if (!sqlTool) {
        console.warn('[PlanAgent] No SQL tool available for enhanced queries');
        return enhancedResults;
      }

      // 分析工具参数，识别需要的数据类型
      const dataNeeds = this.analyzeToolDataNeeds(properties);
      console.log(`[PlanAgent] Identified data needs for ${tool.name}:`, dataNeeds);
      
      // 根据数据需求执行相应的SQL查询
      for (const need of dataNeeds) {
        try {
          const query = this.buildTargetedQuery(need, baseQueryResults);
          if (query) {
            console.log(`[PlanAgent] Executing targeted query for ${need.type}:`, query);
            const result = await sqlTool.call({ sql: query });
            const parsedResult = this.parseSqlResult(result);
            enhancedResults[`targeted_${need.type}`] = parsedResult;
            console.log(`[PlanAgent] Enhanced data for ${need.type}:`, {
              resultType: typeof result,
              isArray: Array.isArray(result),
              length: Array.isArray(result) ? result.length : 'N/A'
            });
          }
        } catch (error) {
          console.warn(`[PlanAgent] Failed to get enhanced data for ${need.type}:`, error);
          enhancedResults[`targeted_${need.type}_error`] = error instanceof Error ? error.message : String(error);
        }
      }
      
      return enhancedResults;
    } catch (error) {
      console.error('[PlanAgent] Error enhancing query results:', error);
      return baseQueryResults;
    }
  }

  // 分析工具参数，识别需要的数据类型
  private analyzeToolDataNeeds(properties: Record<string, any>): Array<{type: string, field: string, description?: string}> {
    const dataNeeds: Array<{type: string, field: string, description?: string}> = [];
    
    for (const [fieldName, fieldSchema] of Object.entries(properties)) {
      const fieldType = (fieldSchema as any)?.type;
      const fieldDescription = (fieldSchema as any)?.description || '';
      const lowerField = fieldName.toLowerCase();
      const lowerDesc = fieldDescription.toLowerCase();
      
      // 识别用户相关数据
      if (lowerField.includes('user') || lowerField.includes('customer') || 
          lowerDesc.includes('user') || lowerDesc.includes('customer')) {
        dataNeeds.push({ type: 'users', field: fieldName, description: fieldDescription });
      }
      
      // 识别订单相关数据
      if (lowerField.includes('order') || lowerField.includes('purchase') || 
          lowerDesc.includes('order') || lowerDesc.includes('purchase')) {
        dataNeeds.push({ type: 'orders', field: fieldName, description: fieldDescription });
      }
      
      // 识别产品相关数据
      if (lowerField.includes('product') || lowerField.includes('item') || 
          lowerDesc.includes('product') || lowerDesc.includes('item')) {
        dataNeeds.push({ type: 'products', field: fieldName, description: fieldDescription });
      }
      
      // 识别支付相关数据
      if (lowerField.includes('payment') || lowerField.includes('transaction') || 
          lowerDesc.includes('payment') || lowerDesc.includes('transaction')) {
        dataNeeds.push({ type: 'payments', field: fieldName, description: fieldDescription });
      }
      
      // 识别ID类型字段
      if (fieldType === 'integer' || fieldType === 'number') {
        if (lowerField.includes('id') && !dataNeeds.some(need => need.field === fieldName)) {
          // 根据ID字段名推断数据类型
          if (lowerField.includes('user')) {
            dataNeeds.push({ type: 'users', field: fieldName, description: fieldDescription });
          } else if (lowerField.includes('order')) {
            dataNeeds.push({ type: 'orders', field: fieldName, description: fieldDescription });
          } else if (lowerField.includes('product')) {
            dataNeeds.push({ type: 'products', field: fieldName, description: fieldDescription });
          }
        }
      }
    }
    
    // 去重
    const uniqueNeeds = dataNeeds.filter((need, index, self) => 
      index === self.findIndex(n => n.type === need.type)
    );
    
    return uniqueNeeds;
  }

  // 根据数据需求构建目标SQL查询
  private buildTargetedQuery(need: {type: string, field: string, description?: string}, baseResults: Record<string, any>): string | null {
    const tables = baseResults.tables;
    if (!Array.isArray(tables)) {
      return null;
    }
    
    // 查找匹配的表名
    const matchingTable = tables.find((tableRow: any) => {
      const tableName = (tableRow.table_name || tableRow.TABLE_NAME || '').toLowerCase();
      return tableName.includes(need.type.slice(0, -1)) || // 去掉复数s
             tableName.includes(need.type) ||
             (need.type === 'users' && (tableName.includes('user') || tableName.includes('customer'))) ||
             (need.type === 'orders' && (tableName.includes('order') || tableName.includes('purchase'))) ||
             (need.type === 'products' && (tableName.includes('product') || tableName.includes('item'))) ||
             (need.type === 'payments' && (tableName.includes('payment') || tableName.includes('transaction')));
    });
    
    if (!matchingTable) {
      console.log(`[PlanAgent] No matching table found for data type: ${need.type}`);
      return null;
    }
    
    const tableName = matchingTable.table_name || matchingTable.TABLE_NAME;
    
    try {
      // 使用数据库适配器构建查询
      const dbAdapter = getDatabaseAdapter();
      let orderByColumn = '';
      
      // 检查是否有列信息来确定排序字段
      if (baseResults.columns && Array.isArray(baseResults.columns)) {
        const tableColumns = baseResults.columns.filter((col: any) => 
          (col.table_name || col.TABLE_NAME || '').toLowerCase() === tableName.toLowerCase()
        );
        
        // 查找id相关字段
        const idColumn = tableColumns.find((col: any) => {
          const colName = (col.column_name || col.COLUMN_NAME || '').toLowerCase();
          return colName === 'id' || colName.endsWith('_id') || colName === 'uuid';
        });
        
        if (idColumn) {
          orderByColumn = idColumn.column_name || idColumn.COLUMN_NAME;
        } else {
          // 如果没有id字段，尝试使用第一个字段
          if (tableColumns.length > 0) {
            orderByColumn = tableColumns[0].column_name || tableColumns[0].COLUMN_NAME;
          }
        }
      } else {
        // 如果没有列信息，尝试使用常见的id字段名
        orderByColumn = 'id';
      }
      
      // 使用数据库适配器生成查询
      const query = dbAdapter.getSampleDataQueryWithOrder(tableName, 10, orderByColumn, 'DESC');
      console.log(`[PlanAgent] Built targeted query for ${need.type}: ${query}`);
      return query;
      
    } catch (error) {
      console.error(`[PlanAgent] Error building targeted query for ${need.type}:`, error);
      // 降级到最简单的查询
      const dbAdapter = getDatabaseAdapter();
      return dbAdapter.getSampleDataQuery(tableName, 10);
    }
  }

  // 构建单个工具的提示词
  private buildSingleToolPrompt(
    tool: any, 
    queryResults: Record<string, any>, 
    batchInfo: any, 
    toolIndex: number
  ): string {
    const toolSchema = tool?.schema ?? tool?.input_schema ?? tool?.parametersSchema ?? {};
    
    return `You are a test task generator. Generate a single test task for the specified tool using ONLY real database data.

TOOL INFORMATION:
Name: ${tool.name}
Description: ${tool.description || 'No description available'}
Schema: ${JSON.stringify(toolSchema, null, 2)}

REAL DATABASE DATA (USE THESE EXACT VALUES):
${JSON.stringify(queryResults, null, 2)}

CRITICAL INSTRUCTIONS FOR USING REAL DATA:
1. **ID Fields**: If the tool requires ID parameters, use ONLY the actual IDs from the database results above
   - Database IDs are typically UUIDs/GUIDs (e.g., "550e8400-e29b-41d4-a716-446655440000")
   - NEVER generate fake IDs like "123", "user1", etc.
   - Look for fields ending with "_id" or "id" in the database results

2. **String Fields**: Use actual names, emails, descriptions from the database
   - NEVER use placeholders like "John Doe", "test@example.com"
   - Extract real values from the query results

3. **Numeric Fields**: Use actual numeric values from the database
   - Prices, quantities, counts should come from real data
   - If no suitable numeric data exists, use 0 or 1 as fallback

4. **Enhanced Data**: Pay special attention to "targeted_*" fields in the query results
   - These contain specific data queried for this tool's requirements
   - Prioritize using data from these enhanced results over general schema data

BATCH INFORMATION:
Batch Index: ${batchInfo?.batchIndex ?? 0}
Tool Index: ${toolIndex}
Total Tools: ${batchInfo?.totalTools ?? 1}

OUTPUT REQUIREMENTS:
1. Generate exactly ONE test task for the specified tool
2. **MANDATORY**: Use ONLY real data from the database query results above
3. **CRITICAL**: All parameter values MUST come from actual database records
4. Return valid JSON with these fields:
   - toolName: string (must match the tool name exactly)
   - description: string (describe what real data is being tested)
   - parameters: object (ONLY real database values, NO fake/generated data)
   - complexity: "low" | "medium" | "high"
   - batchIndex: number (use the provided batch index)
   - expectedResult: "success" | "fail"
   - isRequiredValidateByDatabase: boolean (set to true if using database IDs)

5. **VALIDATION RULES**:
   - NO markdown formatting, NO extra text, ONLY valid JSON
   - NO placeholder values ("example", "test", "sample", etc.)
   - NO generated IDs (use actual UUIDs from database)
   - NO fake names/emails (use real ones from query results)
   - If enhanced "targeted_*" data exists, prioritize it over general data

Example output format (using real database values):
{
  "toolName": "get_user_profile",
  "description": "Test get_user_profile with real user UUID from database",
  "parameters": {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "email": "alice.johnson@company.com"
  },
  "complexity": "medium",
  "batchIndex": 0,
  "expectedResult": "success",
  "isRequiredValidateByDatabase": true
}

**REMEMBER**: Replace ALL values with actual data from the query results above!`;
  }

  /**
   * 路由决策 - 增强版，支持基于数据查询请求的动态路由
   * 
   * 路由逻辑：
   * 1. 检查数据查询请求：
   *    - 如果存在dataQueryRequest且未达到最大查询轮次(3轮) → data-query-node
   *    - 如果达到最大轮次，继续执行计划生成
   * 
   * 2. 检查基础数据：
   *    - 如果没有queryResults → data-query-node
   * 
   * 3. 检查工具处理状态：
   *    - 如果没有toolsList → next-tool-node (初始化工具列表)
   *    - 如果有未处理的工具 → plan-generation-node
   *    - 如果所有工具都已处理 → END
   * 
   * 查询轮次限制机制防止无限循环，确保系统稳定性。
   * 
   * @param state 当前PlanAgent状态
   * @param config LangGraph运行配置
   * @returns 下一个要执行的节点名称
   */
  async routeDecision(
    state: typeof PlanAgentAnnotation.State,
    config: LangGraphRunnableConfig
  ): Promise<"data-query-node" | "plan-generation-node" | "next-tool-node" | typeof END> {
    const threadId = (config?.configurable as any)?.thread_id ?? this.lastThreadId ?? "default";
    console.log(`[PlanAgent] RouteDecision for threadId: ${threadId}`);

    try {
      const { 
        queryResults, 
        currentToolIndex, 
        toolsList, 
        batchInfo, 
        dataQueryRequest, 
        queryRound 
      } = state;

      // 优先检查是否有数据查询请求（来自plan-generation-node的数据不足判断）
      if (dataQueryRequest && dataQueryRequest.needsMoreData) {
        const currentRound = queryRound ?? 0;
        const maxRounds = 8; // 最大查询轮次限制
        
        if (currentRound < maxRounds) {
          console.log(`[PlanAgent] Data query requested (round ${currentRound + 1}/${maxRounds}), routing to data-query-node`);
          console.log(`[PlanAgent] Missing data types: ${dataQueryRequest.missingData?.join(', ')}`);
          return "data-query-node";
        } else {
          console.log(`[PlanAgent] Max query rounds (${maxRounds}) reached, proceeding with available data`);
          // 清除查询请求，强制继续生成计划
          // 这将在下次路由时被处理
        }
      }

      // 如果没有查询结果，先执行数据查询
      if (!queryResults || Object.keys(queryResults).length === 0) {
        console.log('[PlanAgent] No query results, routing to data-query-node');
        return "data-query-node";
      }

      // 如果没有工具列表或批次信息，需要初始化
      if (!toolsList || toolsList.length === 0 || !batchInfo) {
        console.log('[PlanAgent] Missing tools or batch info, routing to next-tool-node for initialization');
        return "next-tool-node";
      }

      // 检查是否还有工具需要处理
      const currentIndex = currentToolIndex ?? 0;
      if (currentIndex >= toolsList.length) {
        console.log('[PlanAgent] All tools processed, ending');
        return END;
      }

      // 检查是否刚刚生成了计划，避免无限循环
      if (state.generatedPlans && state.generatedPlans.length > 0) {
        const lastPlan = state.generatedPlans[state.generatedPlans.length - 1];
        if (lastPlan && state.currentTool && lastPlan.toolName === state.currentTool.name) {
          console.log(`[PlanAgent] Plan already generated for tool ${state.currentTool.name}, routing to next-tool-node`);
          // 计划生成完成后，递增工具索引并清空当前工具
          const nextIndex = (currentToolIndex ?? 0) + 1;
          // 更新状态并路由到next-tool-node
          state.currentToolIndex = nextIndex;
          state.currentTool = null;
          return "next-tool-node";
        }
      }

      // 如果当前工具已设置且未生成计划，生成计划
      if (state.currentTool) {
        console.log(`[PlanAgent] Current tool set (${state.currentTool.name}), routing to plan-generation-node`);
        return "plan-generation-node";
      }

      // 否则切换到下一个工具
      console.log('[PlanAgent] No current tool, routing to next-tool-node');
      return "next-tool-node";
    } catch (error) {
      console.error('[PlanAgent] RouteDecision error:', error);
      return END;
    }
  }

  // 工具切换节点：设置当前要处理的工具
  async nextToolNode(
    state: typeof PlanAgentAnnotation.State,
    config: LangGraphRunnableConfig
  ): Promise<Partial<typeof PlanAgentAnnotation.State>> {
    const threadId = (config?.configurable as any)?.thread_id ?? this.lastThreadId ?? "default";
    console.log(`[PlanAgent] NextToolNode for threadId: ${threadId}`);

    try {
      let { currentToolIndex, toolsList, batchInfo } = state;

      // 如果没有工具列表，初始化批次信息和工具列表
      if (!toolsList || toolsList.length === 0 || !batchInfo) {
        console.log('[PlanAgent] Initializing batch info and tools list');
        
        // 初始化批次信息
        const batchMemKey = `planNode:${threadId}:toolBatch`;
        const candidateStore: any = (config as any)?.store;
        const candidateType = candidateStore?.constructor?.name;
        const underlyingType = candidateStore?.store?.constructor?.name;
        const isAsyncBatchedInMemory = candidateType === "AsyncBatchedStore" && underlyingType === "InMemoryStore";
        const forceShared = (process.env.FORCE_SHARED_MEMORY ?? process.env.USE_SHARED_STORE ?? "").toString() === "1";
        const store: any = !candidateStore || isAsyncBatchedInMemory || forceShared ? undefined : candidateStore;
        
        const ns = ["plans", this.config.namespace.project, this.config.namespace.environment, this.config.namespace.agent_type, threadId];
        
        let batchStateRaw;
        if (store && typeof store.get === "function") {
          batchStateRaw = await store.get(ns, "toolBatch");
        } else {
          batchStateRaw = await this.getSharedMemory(batchMemKey);
        }

        const batchState = batchStateRaw && typeof batchStateRaw === "object" && "value" in batchStateRaw
          ? (batchStateRaw as any).value
          : batchStateRaw;

        if (!batchState) {
          // 初始化新的批次状态
          const toolsPerBatch = 5;
          const allTools = await this.getAllTools();
          const totalTools = allTools.length;
          const totalBatches = Math.ceil(totalTools / toolsPerBatch);
          
          batchInfo = {
            batchIndex: 0,
            totalBatches,
            toolsPerBatch,
            totalTools
          };
          
          const startIndex = 0;
          const endIndex = Math.min(toolsPerBatch, totalTools);
          toolsList = allTools.slice(startIndex, endIndex);
          
          console.log(`[PlanAgent] Initialized new batch: ${JSON.stringify(batchInfo)}`);
        } else {
          batchInfo = {
            batchIndex: batchState.batchIndex ?? 0,
            totalBatches: batchState.totalBatches ?? 1,
            toolsPerBatch: batchState.toolsPerBatch ?? 5,
            totalTools: batchState.totalTools ?? 0
          };
          
          const allTools = await this.getAllTools();
          const startIndex = batchInfo.batchIndex * batchInfo.toolsPerBatch;
          const endIndex = Math.min(startIndex + batchInfo.toolsPerBatch, batchInfo.totalTools);
          toolsList = allTools.slice(startIndex, endIndex);
          
          console.log(`[PlanAgent] Loaded existing batch: ${JSON.stringify(batchInfo)}`);
        }
        
        currentToolIndex = 0;
      }

      // 设置当前工具（跳过已生成计划的工具，并持久化索引）
      let currentIndex = currentToolIndex ?? 0;

      // 如果已有生成的计划，跳过已处理过的工具
      const plannedNames = Array.isArray(state.generatedPlans)
        ? new Set(state.generatedPlans.map((p: any) => p?.toolName))
        : new Set<string>();

      while (currentIndex < toolsList.length && plannedNames.has(toolsList[currentIndex].name)) {
        currentIndex++;
      }

      if (currentIndex < toolsList.length) {
        const currentTool = toolsList[currentIndex];
        console.log(`[PlanAgent] Setting current tool to: ${currentTool.name} (index: ${currentIndex})`);

        return {
          currentTool,
          currentToolIndex: currentIndex, // 持久化最新索引，避免回退到0
          toolsList,
          batchInfo
        };
      } else {
        console.log('[PlanAgent] No more tools in current batch');
        return {
          currentTool: null,
          currentToolIndex: currentIndex,
          toolsList,
          batchInfo
        };
      }
    } catch (error) {
      console.error('[PlanAgent] NextToolNode error:', error);
      return {
        currentTool: null
      };
    }
  }

  // 旧的planNode方法已被新架构替代，保留用于兼容性
  async planNode(
    _state: typeof MessagesAnnotation.State,
    _config: LangGraphRunnableConfig
  ) {
    console.log('[PlanAgent] Legacy planNode called - this should not happen in new architecture');
    return { messages: [new AIMessage({ content: "Legacy planNode called" })] };
  }

  // 旧的路由方法已被新架构替代
  routeModelOutput(
    _state: typeof MessagesAnnotation.State
  ): "plan-node" | typeof END {
    console.log('[PlanAgent] Legacy routeModelOutput called - this should not happen in new architecture');
    return END;
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

  // 旧的路由方法已被新架构替代
  async takeActionOrGeneratePlan(
    _state: typeof MessagesAnnotation.State,
    _config: LangGraphRunnableConfig
  ): Promise<"plan-node" | typeof END> {
    console.log('[PlanAgent] Legacy takeActionOrGeneratePlan called - this should not happen in new architecture');
    return END;
  }

  // 获取所有工具的辅助方法
  private async getAllTools(): Promise<any[]> {
    try {
      return await getTestServerTools();
    } catch (error) {
      console.error('[PlanAgent] Failed to get tools:', error);
      return [];
    }
  }

  public buildGraph() {
    const builder = new StateGraph(PlanAgentAnnotation)
      .addNode("data-query-node", this.dataQueryNode.bind(this))
      .addNode("plan-generation-node", this.planGenerationNode.bind(this))
      .addNode("next-tool-node", this.nextToolNode.bind(this))
      .addEdge(START, "data-query-node")
      .addConditionalEdges(
        "data-query-node",
        this.routeDecision.bind(this),
        ["data-query-node", "plan-generation-node", "next-tool-node", END]
      )
      .addConditionalEdges(
        "plan-generation-node",
        this.routeDecision.bind(this),
        ["data-query-node", "plan-generation-node", "next-tool-node", END]
      )
      .addConditionalEdges(
        "next-tool-node",
        this.routeDecision.bind(this),
        ["data-query-node", "plan-generation-node", "next-tool-node", END]
      );

    return builder.compile({
      checkpointer: this.memoryManager.getCheckpointer(),
      // store 配置通过 LangGraph 运行时传递
      interruptBefore: [],
      interruptAfter: [],
    }).withConfig({ recursionLimit: 1000 });
  }
}
