import { getPostgresqlHubResources, getPostgresqlHubPrompts } from '../../mcp-servers/mcp-client.js';

/**
 * 解析TEST_DATABASE_URL环境变量，提取数据库类型和名称
 */
function parseDatabaseConfig() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL || '';
  
  // 默认值
  let dbType = 'postgresql';
  let dbName = 'products';
  
  if (testDatabaseUrl) {
    try {
      // 解析URL格式: postgresql://user:password@host:port/database
      const url = new URL(testDatabaseUrl);
      dbType = url.protocol.replace(':', ''); // 移除冒号
      dbName = url.pathname.replace('/', ''); // 移除前导斜杠
    } catch (error) {
      console.warn('Failed to parse TEST_DATABASE_URL, using defaults:', error);
    }
  }
  
  return {
    type: dbType,
    name: dbName,
    displayType: dbType === 'postgresql' ? 'PostgreSQL' : dbType.toUpperCase()
  };
}

// 获取数据库配置
const dbConfig = parseDatabaseConfig();

export const TOOL_MESSAGE_EXTRACT_PROMPT = `You are a helpful AI assistant.
You are a preprocessing agent responsible for API testing using tools.
Your task is to identify and catalog all available tools, organize them into a structured list of API testing tasks, 
and pass this list to downstream testing agents for execution.
System time: {system_time}`;


// 动态的SQL工具提示词内容
const staticSqlToolPrompts = `## Important: Using Real Data for Test Parameter Generation

### Database Query Guidelines
When generating test parameters, intelligently determine whether to use sqlTools to query real data based on specific circumstances:

**Situations requiring real data queries:**
- Query operations involving ID parameters (e.g., retrieving information by user ID)
- Operations requiring relationship validation (e.g., associations between orders and users)
- Scenarios where business logic depends on existing data (e.g., update, delete operations)
- Scenarios requiring data consistency and integrity testing

**Situations where mock data can be generated:**
- Operations creating new records (user registration, order creation, etc.)
- Simple string and numeric range validation tests
- Format validation tests (email format, phone number format, etc.)
- Boundary value tests (maximum length, minimum values, etc.)

**Handling strategy when database is empty:**
1. First check if relevant tables have data: SELECT COUNT(*) FROM table_name LIMIT 1
2. If no data exists and real data is needed for testing, consider inserting basic test data first
3. Data insertion example: INSERT INTO users (name, email) VALUES ('Test User', 'test@example.com')

**Decision examples:**
- Example 1: GET /users/{id} - requires querying real user ID
- Example 2: POST /users - can generate new usernames and emails
- Example 3: Email format validation - directly generate various test email formats

Avoid generating obvious placeholder data like "valid-payment-id", "test-user-id", etc.

### Test Database Information

**TEST_DATABASE_URL Configuration:**
- **Database Name**: ${dbConfig.name}
- **Database Type**: ${dbConfig.displayType}
- **Connection**: Configured via TEST_DATABASE_URL environment variable
- **Purpose**: Dedicated test database for testing scenarios

**Test Database Usage Guidelines:**

1. **Database Connection**:
   - The test database "${dbConfig.name}" is specifically configured for testing scenarios
   - Use this database name when generating test parameters that require database operations
   - Connection details are managed through the TEST_DATABASE_URL environment variable

2. **Query Patterns for ${dbConfig.name}**:
   - Connect to database: \`\\c ${dbConfig.name};\` (PostgreSQL syntax)
   - Query table structure: \`SELECT * FROM information_schema.tables WHERE table_catalog = '${dbConfig.name}' AND table_schema = 'public';\`
   - Get table columns: \`SELECT column_name, data_type FROM information_schema.columns WHERE table_catalog = '${dbConfig.name}' AND table_schema = 'public' AND table_name = 'your_table';\`

3. **Test Data Generation Strategy**:
   - **Database Testing**: Generate realistic test scenarios using actual table structures from ${dbConfig.name}
   - **Business Logic Testing**: Create test data that reflects real business logic requirements
   - **Data Consistency**: Ensure test data maintains referential integrity within the ${dbConfig.name} database

4. **Common Test Scenarios**:
   - CRUD operations testing
   - Data validation and constraints
   - Relationship integrity testing
   - Query performance testing
   - Transaction rollback testing

5. **Important Notes**:
   - Always reference "${dbConfig.name}" as the target database name in test parameters
   - Use ${dbConfig.displayType}-specific syntax when generating SQL queries for this database
   - Consider business logic requirements when creating test scenarios
   - Ensure test data doesn't interfere with production processes

### Specific Operation Guidelines

1. **Query Table Structure**:
   - Use sql-hub tool to query table structure:
   SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'table_name' ORDER BY ordinal_position;
   - Understand field types, constraint conditions, and other information

2. **Get Sample Data**:
   - Query sample data: SELECT * FROM table_name LIMIT 5;
   - Understand data formats and patterns of actual values

3. **Get Real IDs**:
   - Get existing IDs: SELECT id FROM table_name WHERE conditions LIMIT 1;
   - For relational queries, ensure foreign key IDs actually exist

4. **Verify Data Existence**:
   - For query operations, first confirm there is queryable data: SELECT COUNT(*) FROM table_name;
   - Ensure test scenarios are based on real data state

### Test Data Generation Principles

1. **Prioritize Real Data**:
   - Query real existing IDs, names, and other values from the database
   - Generate similar but non-conflicting test data based on actual data patterns

2. **Ensure Parameter Validity**:
   - Generated parameters must comply with database constraints
   - Foreign key relationships must maintain integrity

3. **Adjust Strategy Based on Operation Type**:
   - **Query Operations**: Use real existing data to ensure results can be found
   - **Create Operations**: Generate non-conflicting new data, following uniqueness constraints
   - **Update Operations**: Use existing IDs, generate valid update values
   - **Delete Operations**: Use existing and deletable data IDs

4. **Handle Edge Cases**:
   - Generate invalid IDs to test error handling
   - Generate out-of-range values to test validation logic
   - Generate null values to test required field validation

### Example Workflow

For user management API testing:
1. First query user table structure: SELECT * FROM information_schema.columns WHERE table_name = 'users';
2. Get real user IDs: SELECT id FROM users LIMIT 3;
3. View user data examples: SELECT id, username, email FROM users LIMIT 5;
4. Generate test parameters based on real data, such as using real existing user IDs for query testing

### Important Notes

- Always query database state first before generating test parameters
- Avoid hardcoding any IDs or data values
- Ensure generated test data complies with business logic
- Prepare diverse real data for different test scenarios

### CRITICAL: Parameter Format Requirements

**ABSOLUTELY FORBIDDEN:**
- Template strings like {"id": "{{execute_sql(sql='SELECT id FROM products LIMIT 1;')}}"}
- Any parameter values containing {{}}, dollar{variable}, or template syntax
- Placeholder strings like "{{variable}}", "dollar{placeholder}", or similar patterns
- Mock IDs like "test-id", "sample-uuid", "placeholder-value"

**REQUIRED FORMAT:**
- All parameters must be actual, concrete values
- Use real data obtained from direct tool calls
- Generate valid test data based on actual database content
- Parameters should be immediately usable without further processing

**Example of CORRECT parameter generation:**
// WRONG: {"userId": "{{execute_sql(sql='SELECT id FROM users LIMIT 1;')}}"}
// RIGHT: {"userId": "123e4567-e89b-12d3-a456-426614174000"}
`;

/**
 * 动态获取SQL工具提示词，包含MCP服务器的resources和prompts信息
 */
export async function getSqlToolPrompts(): Promise<string> {
  try {
    // 获取MCP服务器的resources和prompts
    const [resources, prompts] = await Promise.all([
      getPostgresqlHubResources(),
      getPostgresqlHubPrompts()
    ]);

    // 构建MCP信息部分
    let mcpInfo = '';
    
    if (resources && resources.length > 0) {
      mcpInfo += '\n\n### Available MCP Resources\n\n';
      resources.forEach(resource => {
        mcpInfo += `- **${resource.name}**: Database resource for ${resource.name}\n`;
        mcpInfo += `  - URI: ${resource.uri}\n`;
        if (resource.mimeType) {
          mcpInfo += `  - Type: ${resource.mimeType}\n`;
        }
      });
    }

    if (prompts && prompts.length > 0) {
      mcpInfo += '\n\n### Available MCP Prompts\n\n';
      prompts.forEach(prompt => {
        mcpInfo += `- **${prompt.name}**: ${prompt.description || 'No description'}\n`;
        if (prompt.arguments && prompt.arguments.length > 0) {
          mcpInfo += `  - Arguments: ${prompt.arguments.map((arg:any) => `${arg.name} (${arg.required ? 'required' : 'optional'})`).join(', ')}\n`;
        }
      });
    }

    // 如果获取到MCP信息，则添加使用指南
    if (mcpInfo) {
      mcpInfo += '\n\n### MCP Tools Usage Guidelines\n\n';
      mcpInfo += '**CRITICAL: Direct Tool Calling Requirements**\n\n';
      mcpInfo += '- **NEVER** generate template strings like `{"id": "{{execute_sql(sql=\'SELECT id FROM products LIMIT 1;\')}}"}`\n';
      mcpInfo += '- **ALWAYS** call actual MCP tools directly to get real data\n';
      mcpInfo += '- **FORBIDDEN**: Any parameter values containing `{{}}`, template syntax, or placeholder strings\n';
      mcpInfo += '- **REQUIRED**: All parameters must be actual values, not templates or placeholders\n\n';
      mcpInfo += '**Correct Tool Usage Examples:**\n\n';
      mcpInfo += '1. To get real product IDs:\n';
      mcpInfo += '   - Call: `sql-hub` tool with query: `SELECT id FROM products LIMIT 1;`\n';
      mcpInfo += '   - Use the returned actual ID value in your parameters\n\n';
      mcpInfo += '2. To get table schema:\n';
      mcpInfo += '   - Call: `sql-hub` tool with query: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = \'users\';`\n';
      mcpInfo += '   - Use the returned schema information to generate valid test data\n\n';
      mcpInfo += '**Parameter Generation Rules:**\n\n';
      mcpInfo += '- First call MCP tools to query database for real data\n';
      mcpInfo += '- Use the actual returned values in your test parameters\n';
      mcpInfo += '- Never use placeholder syntax like `{{variable}}` or template strings\n';
      mcpInfo += '- Generate concrete, valid values based on real database content\n\n';
      mcpInfo += '**Available MCP Tools:**\n';
      mcpInfo += '- `sql-hub`: Execute SQL queries against the database\n';
      mcpInfo += '- Use this tool to get real IDs, check table structures, and retrieve sample data\n';
    }

    return staticSqlToolPrompts + mcpInfo;
  } catch (error) {
    console.error('Error fetching MCP information:', error);
    // 如果MCP服务器不可用，返回静态提示词
    return staticSqlToolPrompts;
  }
}

// 为了向后兼容，保留原有的导出（但现在它是一个函数调用）
export const sqlToolPrompts = staticSqlToolPrompts;

// 统一的提示词构建函数，消除重复约束
export interface PlanPromptConfig {
  threadId: string;
  batchIndex: number;
  totalBatches: number;
  toolsPerBatch: number;
  totalTools: number;
  startIndex: number;
  endIndex: number;
  selectedToolMeta: any[];
  planningContext: string;
}

export function buildUnifiedPlanPrompts(config: PlanPromptConfig) {
  const {
    threadId,
    batchIndex,
    totalBatches,
    toolsPerBatch,
    totalTools,
    startIndex,
    endIndex,
    selectedToolMeta,
    planningContext
  } = config;

  // 系统提示词（时间戳替换）
  const systemPrompt = TOOL_MESSAGE_EXTRACT_PROMPT.replace(
    "{system_time}",
    new Date().toISOString()
  );

  // 批次信息上下文
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

  // 工具上下文 - 这里是测试接口工具信息，用于生成测试任务
  const toolsContext = `You have the following TEST INTERFACE tools for THIS BATCH (5 per call). These are the API endpoints you need to generate test tasks for. Use the exact value in the "name" field as task.toolName when planning. Do NOT invent new tool names. Keep parameters aligned with inputSchema.\n\nTEST_INTERFACE_JSON=\n${JSON.stringify(selectedToolMeta, null, 2)}\n\nIMPORTANT: You also have access to DATABASE MCP TOOLS (like sql-hub/execute_sql) to query real data for generating realistic test parameters. Use these database tools to get actual IDs, table structures, and sample data before creating test tasks for the above interfaces.`;

  // 规划上下文消息
  const planningContextMsg = planningContext;

  // 统一的输出规则（合并所有约束条件）
  const outputRules = [
    "OUTPUT_RULES:",
    "- TOOL USAGE WORKFLOW:",
    "  * PHASE 1: Database Query Phase - First call DATABASE MCP TOOLS (sql-hub/execute_sql) to get real data",
    "  * PHASE 2: Test Task Generation Phase - Generate test tasks for TEST INTERFACE tools using the real data",
    "  * DATABASE MCP TOOLS: Use sql-hub/execute_sql to query database schema, existing IDs, sample data",
    "  * TEST INTERFACE TOOLS: Generate test tasks for these API endpoints using real data from database queries",
    "  * NEVER use template strings, placeholders, or mock data in test task parameters",
    "- FINAL OUTPUT FORMAT:",
    "  * After database query phase, you MUST return only a JSON object with the following structure:",
    "  * Root object must have: batchIndex (number), tasks (array)",
    "  * Each task object must have:",
    "    - batchIndex: number (must equal root batchIndex)",
    "    - taskId: string (1-64 chars, only letters/numbers/underscore/dot/colon/dash)",
    "    - toolName: string (exact tool name from TEST INTERFACE tools list, NOT database tool names)",
    "    - description: string (task description)",
    "    - parameters: object or string (tool parameters with REAL DATA obtained from database queries)",
    "    - complexity: 'low' | 'medium' | 'high'",
    "    - isRequiredValidateByDatabase: boolean (true for operations that modify DB or need validation)",
    "    - expectedResult: 'success' | 'fail' (expected test result, 'success' means expecting tool execution to succeed, 'fail' means expecting tool execution to fail for testing error handling logic, defaults to 'success')",
    "- BATCH CONSTRAINTS:",
    "  * All taskIds within same batch must be unique",
    "  * Each task's batchIndex must equal the root batchIndex",
    "  * Tasks must ONLY use TEST INTERFACE tools in this batch; use exact tool name from TEST_INTERFACE_JSON",
    "  * Do NOT create tasks for database MCP tools - they are only for data gathering",
    "- PARAMETER CONSTRAINTS:",
    "  * Parameters must conform to the TEST INTERFACE tool inputSchema",
    "  * Parameters must contain ONLY real data obtained from database MCP tool calls",
    "  * FORBIDDEN: Template strings like {{execute_sql(...)}}, placeholder values, or mock data",
    "  * REQUIRED: Use actual values returned from database queries via sql-hub/execute_sql",
    "- FORMAT CONSTRAINTS:",
    "  * Final output must be valid, parseable JSON only",
    "  * No code fences, no markdown, no natural language in final JSON output",
  ].join("\n");

  return {
    systemPrompt,
    batchInfoContext,
    toolsContext,
    planningContextMsg,
    outputRules,
  };
}
