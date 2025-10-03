/**
 * 分析数据库结构信息
 * 从 queryResults 中提取表名、列信息、关系等结构化数据
 * 
 * @param queryResults - 数据库查询结果
 * @returns 结构化的数据库分析结果
 */
function analyzeDatabaseStructure(queryResults: Record<string, any>): {
  summary: string;
  availableTables: string[];
  tableDetails: Record<string, any>;
  relationships: any[];
} {
  const availableTables: string[] = [];
  const tableDetails: Record<string, any> = {};
  const relationships: any[] = [];
  let summary = "No database structure information available.";

  try {
    // 分析不同类型的查询结果
    Object.keys(queryResults).forEach(key => {
      const data = queryResults[key];
      
      // 分析表列表信息 (排除列信息)
      if ((key.includes('table') || key.includes('schema')) && !key.includes('column') && Array.isArray(data)) {
        data.forEach((item: any) => {
          if (item && typeof item === 'object') {
            // 提取表名 (支持多种命名约定)
            const tableName = item.table_name || item.TABLE_NAME || item.name || item.Name;
            if (tableName && typeof tableName === 'string') {
              availableTables.push(tableName);
              tableDetails[tableName] = {
                type: item.table_type || item.TABLE_TYPE || 'table',
                schema: item.table_schema || item.TABLE_SCHEMA || 'public',
                comment: item.table_comment || item.TABLE_COMMENT || '',
                columns: [] // 初始化 columns 数组
              };
            }
          }
        });
      }
      
      // 分析列信息
      if (key.includes('column') && Array.isArray(data)) {
        data.forEach((item: any) => {
          if (item && typeof item === 'object') {
            const tableName = item.table_name || item.TABLE_NAME;
            const columnName = item.column_name || item.COLUMN_NAME;
            const dataType = item.data_type || item.DATA_TYPE;
            
            if (tableName && columnName) {
              // 确保表存在于 tableDetails 中
              if (!tableDetails[tableName]) {
                tableDetails[tableName] = { 
                  type: 'table',
                  schema: 'public',
                  comment: '',
                  columns: [] 
                };
              }
              if (!tableDetails[tableName].columns) {
                tableDetails[tableName].columns = [];
              }
              tableDetails[tableName].columns.push({
                name: columnName,
                type: dataType,
                nullable: item.is_nullable || item.IS_NULLABLE,
                key: item.column_key || item.COLUMN_KEY
              });
            }
          }
        });
      }
      
      // 分析关系信息
      if ((key.includes('relationship') || key.includes('foreign') || key.includes('reference')) && Array.isArray(data)) {
        relationships.push(...data);
      }
    });

    // 生成摘要
    if (availableTables.length > 0) {
      summary = `Found ${availableTables.length} tables in database: ${availableTables.slice(0, 10).join(', ')}${availableTables.length > 10 ? '...' : ''}`;
      if (relationships.length > 0) {
        summary += `. Identified ${relationships.length} table relationships.`;
      }
    } else {
      // 尝试从其他数据中推断表信息
      Object.keys(queryResults).forEach(key => {
        const data = queryResults[key];
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
          // 如果数据看起来像表数据，尝试推断表名
          if (key !== 'error' && !key.includes('error')) {
            availableTables.push(key);
            tableDetails[key] = {
              type: 'inferred',
              columns: Object.keys(data[0] || {}).map(col => ({ name: col, type: 'unknown' }))
            };
          }
        }
      });
      
      if (availableTables.length > 0) {
        summary = `Inferred ${availableTables.length} potential tables from data: ${availableTables.join(', ')}`;
      }
    }
  } catch (error) {
    console.warn('[analyzeDatabaseStructure] Error analyzing database structure:', error);
  }

  return {
    summary,
    availableTables: [...new Set(availableTables)], // 去重
    tableDetails,
    relationships
  };
}

/**
 * 构建数据评估提示词
 * 用于评估数据库数据是否足够生成有意义的测试任务
 * 
 * @param tool - 工具信息对象，包含名称、描述和参数模式
 * @param queryResults - 数据库查询结果
 * @param currentRound - 当前查询轮次
 * @returns 数据评估提示词字符串
 */
export function buildDataAssessmentPrompt(
  tool: any,
  queryResults: Record<string, any>,
  currentRound: number
): string {
  const toolSchema = tool?.schema ?? tool?.input_schema ?? tool?.parametersSchema ?? {};
  const properties = toolSchema.properties || {};

  // 分析 queryResults 中的数据库结构信息
  const databaseAnalysis = analyzeDatabaseStructure(queryResults);

  return `You are a data sufficiency analyst. Evaluate whether the provided database data is sufficient to generate a meaningful test task for the given tool.
    
    TOOL INFORMATION:
    Name: ${tool.name}
    Description: ${tool.description || 'No description'}
    Parameters: ${JSON.stringify(properties, null, 2)}

    AVAILABLE DATA:
    ${JSON.stringify(queryResults, null, 2)}

    DATABASE STRUCTURE ANALYSIS:
    ${databaseAnalysis.summary}
    
    AVAILABLE TABLES: ${databaseAnalysis.availableTables.join(', ') || 'None identified'}
    TABLE DETAILS: ${JSON.stringify(databaseAnalysis.tableDetails, null, 2)}
    RELATIONSHIPS: ${JSON.stringify(databaseAnalysis.relationships, null, 2)}

    CURRENT QUERY ROUND: ${currentRound}

    EVALUATION CRITERIA:
    1. Are there sufficient real data records to populate tool parameters?
    2. Do the available data types match the tool's parameter requirements?
    3. Is there enough variety in the data for meaningful testing?
    4. Are there any critical missing data types that would prevent effective testing?

    CRITICAL: When specifying missing data types in the "missingData" array, you MUST use ONLY these exact keywords:
    
    FOR DATABASE STRUCTURE INFORMATION:
    - Use "schema" for table structure information
    - Use "structure" for database schema details
    - Use "table" for table definitions and metadata
    
    FOR SAMPLE DATA:
    - Use "sample" for sample records from tables
    - Use "data" for actual data records
    - Use "record" for specific data entries
    
    FOR TABLE RELATIONSHIPS:
    - Use "relationship" for table relationships
    - Use "foreign" for foreign key information
    - Use "reference" for referential constraints
    
    FOR CONSTRAINTS AND KEYS:
    - Use "constraint" for database constraints
    - Use "key" for primary/foreign key information
    
    EXAMPLES OF CORRECT missingData VALUES:
    - ["schema", "sample"] - Need table structure and sample data
    - ["data", "relationship"] - Need actual records and table relationships
    - ["constraint", "foreign"] - Need constraint info and foreign keys
    - ["structure", "record"] - Need database structure and data records
    
    DO NOT use generic terms like "user_data", "product_info", "table_names" etc.
    ONLY use the specific keywords listed above for precise query matching.

    TABLE RECOMMENDATION ANALYSIS:
    PRIORITY 1 - ACTUAL DATABASE MATCHING (if database structure is available):
    First, analyze the AVAILABLE TABLES and TABLE DETAILS above to identify tables that match the tool's functionality.
    Use semantic matching to connect tool requirements with actual table names:
    - Match tool name patterns with existing table names (e.g., "createOrder" tool → look for "orders", "order_items", "order_status" in available tables)
    - Match parameter names with table names and column names (e.g., "userId" parameter → look for "users", "user_profiles" tables)
    - Consider table relationships and foreign keys to identify related tables
    - Use fuzzy matching for variations (e.g., "order" matches "orders", "order_items", "order_history")
    
    PRIORITY 2 - TOOL-BASED INFERENCE (if no database structure available):
    If no actual database structure is available, fall back to tool-based inference:
    1. Tool name patterns (e.g., "createOrder" suggests "orders" table)
    2. Parameter names (e.g., "userId" suggests "users" table, "productId" suggests "products" table)
    3. Tool description context (e.g., "customer management" suggests "customers", "customer_profiles" tables)
    4. Common database naming conventions (singular/plural forms, underscore patterns)
    
    MATCHING STRATEGY:
    - If AVAILABLE TABLES contains actual table names, PRIORITIZE matching against these real tables
    - Look for exact matches first, then partial matches, then semantic matches
    - Consider table relationships to recommend related tables (e.g., if "orders" exists, also consider "order_items", "customers")
    - Validate recommendations against actual column information if available
    
    EXAMPLES OF INTELLIGENT MATCHING:
    - Tool "createOrder" + Available tables ["orders", "order_items", "customers", "products"] → Recommend ["orders", "order_items", "customers", "products"]
    - Tool "getUserProfile" + Available tables ["users", "user_profiles", "user_settings"] → Recommend ["users", "user_profiles"]
    - Tool "addProduct" + Available tables ["products", "categories", "inventory", "suppliers"] → Recommend ["products", "categories", "inventory"]

    RETURN A JSON OBJECT WITH:
    {
    "isDataSufficient": boolean,
    "missingData": ["use ONLY the exact keywords specified above"],
    "targetTables": ["PRIORITIZE actual table names from AVAILABLE TABLES if available", "otherwise use tool-based inference"],
    "assessmentReason": "detailed explanation including: 1) database structure analysis results, 2) table matching strategy used, 3) confidence in recommendations",
    "confidence": number (0-1, higher confidence when actual database structure is available)
    }

    IMPORTANT GUIDELINES FOR targetTables:
    - If AVAILABLE TABLES is not empty, your targetTables MUST primarily come from those actual table names
    - Use exact matches from AVAILABLE TABLES when possible
    - Include related tables based on relationships and semantic connections
    - Only fall back to generic table name inference if no database structure is available
    - Confidence should be higher (0.8-1.0) when based on actual database structure, lower (0.4-0.7) when based on tool inference alone
    
    Be strict in your assessment - only mark as sufficient if you can generate a realistic, meaningful test with actual data.`;
}