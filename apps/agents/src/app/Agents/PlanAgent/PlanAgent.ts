import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { BaseAgent, AgentConfig } from "../../BaseAgent/BaseAgent.js";
import { getDatabaseAdapter } from "./Utils/DatabaseAdapter.js";
import { AIMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { loadChatModel } from "../../ModelUtils/ChatModel.js";
import { getPostgresqlHubTools, getTestServerTools } from "../../mcp-servers/mcp-client.js";
import type { TaskPlanedForTest } from "../../Memory/SharedMemoryManager.js";
import { BatchInfo, PlanAgentAnnotation } from "./State/State.js";
import { buildDataAssessmentPrompt } from "./Prompts/Prompts.js";
import { parseJsonFromLLMResponse, parseSqlResult } from "./Utils/Utils.js";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";


export class PlanAgent extends BaseAgent {
  private llm: BaseChatModel ;
  // 记录最近一次运行的 thread_id，供路由函数读取批次进度
  private lastThreadId: string | null = null;

  constructor(config: AgentConfig) {
    super(config);
  }

  protected async initializellm() {
    this.llm = await loadChatModel("openai/moonshotai/Kimi-K2-Instruct");
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
      const parsed1 = parseSqlResult(raw1);
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
      const parsed2 = parseSqlResult(raw2);
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
      if (dbTools && dbTools.length > 0) {
        console.log('[PlanAgent] Available database tools:', dbTools.map(tool => ({ name: tool.name, description: tool.description })));
      }

      if (!dbTools || dbTools.length === 0) {
        console.error('[PlanAgent] No database tools available - this may indicate MCP server connection issues Please check:');
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
        const specificQueries = this.buildSpecificQueries(dataQueryRequest.missingData, state.currentTool, state.dataAssessment?.targetTables);
        
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
          const { raw, parsed, usedParam } = await this.callSqlWithFallback(sqlTool, query);
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
   * 计划生成节点支持LLM驱动的数据充分性评估
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
      }

      const { currentTool, queryResults, batchInfo, currentToolIndex, queryRound, dataQueryRequest } = state;
      if (!currentTool) {
        console.warn('[PlanAgent] No current tool specified');
        return { generatedPlans: [] };
      }

      console.log(`[PlanAgent] Generating plan for tool: ${currentTool.name}, Query Round: ${queryRound || 0}`);
      // 根据工具schema动态查询相关的真实数据
      const enhancedQueryResults = queryResults || {};
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
        // 使用工具函数解析LLM响应中的JSON
        parsedPlan = parseJsonFromLLMResponse(response);
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
    targetTables: string[];
  }> {
    try {
      // 构建数据评估提示词
      const assessmentPrompt = buildDataAssessmentPrompt(tool, queryResults, currentRound);
      const response = await this.llm.invoke([
        { role: "system", content: assessmentPrompt },
        { role: "user", content: "Evaluate the data sufficiency for this tool. Return only the JSON assessment." }
      ]);

      // 解析LLM响应
      let assessment = null;
      try {
        // 使用工具函数解析LLM响应中的JSON
        assessment = parseJsonFromLLMResponse(response);
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
          confidence: 0.6,
          targetTables: []
        };
      }

      // 验证和标准化评估结果
      return {
        isDataSufficient: Boolean(assessment?.isDataSufficient),
        missingData: Array.isArray(assessment?.missingData) ? assessment.missingData : [],
        assessmentReason: assessment?.assessmentReason || 'Assessment failed',
        confidence: typeof assessment?.confidence === 'number' ? 
          Math.max(0, Math.min(1, assessment.confidence)) : 0.5,
        targetTables: Array.isArray(assessment?.targetTables) ? assessment.targetTables : []
      };
    } catch (error) {
      console.error('[PlanAgent] Data assessment error:', error);
      return {
        isDataSufficient: currentRound >= 2, // 默认2轮后认为充分
        missingData: ['assessment_failed'],
        assessmentReason: 'Assessment process failed, using fallback logic',
        confidence: 0.3,
        targetTables: []
      };
    }
  }

  /**
   * 根据LLM评估的缺失数据构建智能的数据库发现查询
   * 
   * 增强功能：
   * 1. LLM表名推荐优先：优先使用LLM推荐的具体表名进行查询
   * 2. 智能表匹配：根据当前工具提取相关表名，作为备选方案
   * 3. 关键词匹配机制：与 buildDataAssessmentPrompt 中的关键词约束严格对应
   * 4. 目标查询：针对特定表生成样本数据查询，而不是查询所有表
   * 5. Fallback机制：如果没有匹配到相关表，使用通用查询
   * 
   * 支持的关键词分类：
   * 1. 数据库结构类：'schema', 'structure', 'table' -> 获取表结构和元数据
   * 2. 样本数据类：'sample', 'data', 'record' -> 获取实际数据记录（智能匹配相关表）
   * 3. 表关系类：'relationship', 'foreign', 'reference' -> 获取表间关系信息
   * 4. 约束键类：'constraint', 'key' -> 获取约束和键信息
   * 
   * 每个查询包含：
   * - type: 数据类型标识
   * - query: 具体的SQL查询语句
   * - key: 结果存储的键名
   * 
   * @param missingData LLM识别的缺失数据类型列表（使用标准化关键词）
   * @param currentTool 当前正在处理的工具（用于智能表匹配）
   * @param llmRecommendedTables LLM推荐的具体表名列表（优先级最高）
   * @returns 结构化的查询定义数组
   */
  private buildSpecificQueries(missingData: string[], currentTool?: any, llmRecommendedTables?: string[]): Array<{type: string, query: string, key: string}> {
    const queries: Array<{type: string, query: string, key: string}> = [];
    const dbAdapter = getDatabaseAdapter();
    
    // 标准化和验证关键词
    const standardizedKeywords = this.standardizeKeywords(missingData);
    console.log(`[PlanAgent] Standardized keywords:`, standardizedKeywords);
    
    // 确定目标表名的优先级策略：
    // 1. 优先使用LLM推荐的具体表名（最高优先级）
    // 2. 备选使用从工具中提取的表名关键词
    let targetTableKeywords: string[] = [];
    
    if (llmRecommendedTables && llmRecommendedTables.length > 0) {
      targetTableKeywords = llmRecommendedTables;
      console.log(`[PlanAgent] Using LLM recommended tables (highest priority):`, targetTableKeywords);
    } else if (currentTool) {
      targetTableKeywords = this.extractTableNamesFromTool(currentTool);
      console.log(`[PlanAgent] Using extracted table keywords for tool "${currentTool.name}" (fallback):`, targetTableKeywords);
    }
    
    for (const missing of standardizedKeywords) {
      const missingLower = missing.toLowerCase().trim();
      
      // 精确关键词匹配 - 与 Prompts.ts 中的约束严格对应
      if (missingLower === 'schema' || missingLower === 'structure' || missingLower === 'table') {
         // 数据库结构信息类 - 获取表结构和元数据
         console.log(`[PlanAgent] Matched DATABASE STRUCTURE keyword: "${missing}"`);
         
         if (targetTableKeywords.length > 0) {
           // 优先查询相关表的结构信息
           queries.push({
             type: 'targeted_table_info', 
             query: dbAdapter.getTargetedTableInfoQuery(targetTableKeywords), 
             key: 'targeted_tables'
           });
         } else {
           // Fallback到通用表查询
           queries.push({
             type: 'schema_info', 
             query: dbAdapter.getTableListQuery(), 
             key: 'schema_tables'
           });
         }
         
         queries.push({
           type: 'column_info', 
           query: dbAdapter.getColumnInfoQuery(), 
           key: 'schema_columns'
         });
       } else if (missingLower === 'sample' || missingLower === 'data' || missingLower === 'record') {
         // 样本数据类 - 智能获取相关表的实际数据记录
         console.log(`[PlanAgent] Matched SAMPLE DATA keyword: "${missing}"`);
         
         if (targetTableKeywords.length > 0) {
           // 优先查询相关表的样本数据
           console.log(`[PlanAgent] Using targeted sample data query for tables matching:`, targetTableKeywords);
           queries.push({
             type: 'targeted_sample_data', 
             query: dbAdapter.getTargetedSampleDataQuery(targetTableKeywords, 3), 
             key: 'targeted_sample_data'
           });
         } else {
           // Fallback到通用表发现查询
           console.log(`[PlanAgent] No target tables found, using generic table discovery`);
           queries.push({
             type: 'table_discovery', 
             query: dbAdapter.getTableListQuery(), 
             key: 'available_tables'
           });
         }
       } else if (missingLower === 'relationship' || missingLower === 'foreign' || missingLower === 'reference') {
         // 表关系类 - 获取表间关系信息
         console.log(`[PlanAgent] Matched TABLE RELATIONSHIP keyword: "${missing}"`);
         queries.push({
           type: 'relationships', 
           query: dbAdapter.getForeignKeyQuery(), 
           key: 'table_relationships'
         });
       } else if (missingLower === 'constraint' || missingLower === 'key') {
         // 约束键类 - 获取约束和键信息
         console.log(`[PlanAgent] Matched CONSTRAINT/KEY keyword: "${missing}"`);
         queries.push({
           type: 'constraints', 
           query: dbAdapter.getConstraintsQuery(), 
           key: 'table_constraints'
         });
       } else {
         // 未识别的关键词 - 使用通用数据库概览查询作为fallback
         console.warn(`[PlanAgent] Unrecognized keyword: "${missing}", using generic database overview`);
         queries.push({
           type: 'database_overview', 
           query: dbAdapter.getDatabaseOverviewQuery(), 
           key: 'db_overview'
         });
       }
    }
    
    // 如果没有生成任何特定查询，添加基础的数据库发现查询
     if (queries.length === 0) {
       console.log(`[PlanAgent] No specific queries generated, adding basic discovery queries`);
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

  /**
   * 标准化和验证LLM返回的关键词
   * 
   * 确保关键词符合预期格式，移除多余的空格和特殊字符，
   * 并验证是否为支持的关键词类型。
   * 
   * @param missingData 原始的缺失数据类型数组
   * @returns 标准化后的关键词数组
   */
  private standardizeKeywords(missingData: string[]): string[] {
    const validKeywords = [
      // 数据库结构类
      'schema', 'structure', 'table',
      // 样本数据类  
      'sample', 'data', 'record',
      // 表关系类
      'relationship', 'foreign', 'reference',
      // 约束键类
      'constraint', 'key'
    ];
    
    const standardized: string[] = [];
    
    for (const item of missingData) {
      if (!item || typeof item !== 'string') {
        console.warn(`[PlanAgent] Invalid missing data item:`, item);
        continue;
      }
      
      const cleaned = item.toLowerCase().trim();
      
      // 检查是否为有效关键词
      if (validKeywords.includes(cleaned)) {
        standardized.push(cleaned);
      } else {
        // 尝试从复合词中提取有效关键词
        const extracted = this.extractValidKeywords(cleaned, validKeywords);
        if (extracted.length > 0) {
          standardized.push(...extracted);
          console.log(`[PlanAgent] Extracted keywords from "${item}":`, extracted);
        } else {
          console.warn(`[PlanAgent] No valid keywords found in: "${item}"`);
          // 保留原始值，让后续处理决定如何处理
          standardized.push(cleaned);
        }
      }
    }
    
    // 去重
    return [...new Set(standardized)];
  }

  /**
   * 从复合词或描述性文本中提取有效关键词
   * 
   * @param text 输入文本
   * @param validKeywords 有效关键词列表
   * @returns 提取到的有效关键词数组
   */
  private extractValidKeywords(text: string, validKeywords: string[]): string[] {
    const extracted: string[] = [];
    
    for (const keyword of validKeywords) {
      if (text.includes(keyword)) {
        extracted.push(keyword);
      }
    }
    
    return extracted;
  }

  /**
   * 从tool的名称、描述和schema中提取可能的表名关键词
   * 
   * 支持的提取策略：
   * 1. 从tool名称中提取（如 createOrder -> order, orders）
   * 2. 从tool描述中提取表名相关词汇
   * 3. 从schema参数名中提取（如 orderId -> order）
   * 4. 支持单复数转换和常见命名模式
   * 
   * @param tool 工具对象，包含name、description和schema
   * @returns 提取到的表名关键词数组
   */
  private extractTableNamesFromTool(tool: any): string[] {
    const tableKeywords: Set<string> = new Set();
    
    // 1. 从tool名称中提取
    if (tool.name) {
      const nameKeywords = this.extractKeywordsFromText(tool.name);
      nameKeywords.forEach(keyword => {
        tableKeywords.add(keyword);
        // 添加单复数变体
        const variants = this.generateTableNameVariants(keyword);
        variants.forEach(variant => tableKeywords.add(variant));
      });
    }
    
    // 2. 从tool描述中提取
    if (tool.description) {
      const descKeywords = this.extractKeywordsFromText(tool.description);
      descKeywords.forEach(keyword => {
        const variants = this.generateTableNameVariants(keyword);
        variants.forEach(variant => tableKeywords.add(variant));
      });
    }
    
    // 3. 从schema参数名中提取
    const schema = tool?.schema ?? tool?.input_schema ?? tool?.parametersSchema ?? {};
    if (schema.properties) {
      Object.keys(schema.properties).forEach(paramName => {
        const paramKeywords = this.extractKeywordsFromText(paramName);
        paramKeywords.forEach(keyword => {
          const variants = this.generateTableNameVariants(keyword);
          variants.forEach(variant => tableKeywords.add(variant));
        });
      });
    }
    
    const result = Array.from(tableKeywords).filter(keyword => keyword.length > 2);
    console.log(`[PlanAgent] Extracted table keywords from tool "${tool.name}":`, result);
    return result;
  }

  /**
   * 从文本中提取可能的表名关键词
   * 
   * @param text 输入文本
   * @returns 提取到的关键词数组
   */
  private extractKeywordsFromText(text: string): string[] {
    if (!text) return [];
    
    // 移除常见的动词前缀和后缀
    const cleanText = text
      .replace(/^(create|get|update|delete|fetch|find|search|list|add|remove|set)_?/i, '')
      .replace(/_(id|ids|data|info|details|list)$/i, '')
      .replace(/([A-Z])/g, ' $1') // 驼峰转空格
      .toLowerCase()
      .trim();
    
    // 分割并过滤关键词
    return cleanText
      .split(/[\s_-]+/)
      .filter(word => word.length > 2)
      .filter(word => !['the', 'and', 'for', 'with', 'from', 'api', 'tool'].includes(word));
  }

  /**
   * 生成表名的各种变体（单复数、常见命名模式）
   * 
   * @param keyword 基础关键词
   * @returns 表名变体数组
   */
  private generateTableNameVariants(keyword: string): string[] {
    const variants: Set<string> = new Set();
    const lower = keyword.toLowerCase();
    
    // 添加原始关键词
    variants.add(lower);
    
    // 单数转复数规则
    if (!lower.endsWith('s')) {
      if (lower.endsWith('y')) {
        variants.add(lower.slice(0, -1) + 'ies'); // category -> categories
      } else if (lower.endsWith('ch') || lower.endsWith('sh') || lower.endsWith('x') || lower.endsWith('z')) {
        variants.add(lower + 'es'); // box -> boxes
      } else {
        variants.add(lower + 's'); // order -> orders
      }
    }
    
    // 复数转单数规则
    if (lower.endsWith('s') && lower.length > 3) {
      if (lower.endsWith('ies')) {
        variants.add(lower.slice(0, -3) + 'y'); // categories -> category
      } else if (lower.endsWith('es')) {
        variants.add(lower.slice(0, -2)); // boxes -> box
      } else {
        variants.add(lower.slice(0, -1)); // orders -> order
      }
    }
    
    // 常见表名模式
    variants.add(`${lower}_table`);
    variants.add(`tbl_${lower}`);
    variants.add(`${lower}_info`);
    variants.add(`${lower}_data`);
    
    return Array.from(variants);
  }

  // 根据工具schema动态查询相关的真实数据
  // 构建单个工具的提示词
  private buildSingleToolPrompt(
    tool: any, 
    queryResults: Record<string, any>, 
    batchInfo: BatchInfo | null, 
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
      // checkpointer: this.memoryManager.getCheckpointer(),
      // store 配置通过 LangGraph 运行时传递
      interruptBefore: [],
      interruptAfter: [],
    }).withConfig({ recursionLimit: 1000 });
  }
}

// ...
