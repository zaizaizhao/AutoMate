import { getPostgresqlHubResources, getPostgresqlHubPrompts } from '../../mcp-servers/mcp-client.js';

export const TOOL_MESSAGE_EXTRACT_PROMPT = `You are a helpful AI assistant.
You are a preprocessing agent responsible for API testing using tools.
Your task is to identify and catalog all available tools, organize them into a structured list of API testing tasks, 
and pass this list to downstream testing agents for execution.
System time: {system_time}`;


// 静态的SQL工具提示词内容
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

### Specific Operation Guidelines

1. **Query Table Structure**:
   - Use postgresql-hub tool to query table structure:
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
      mcpInfo += '   - Call: `postgresql-hub` tool with query: `SELECT id FROM products LIMIT 1;`\n';
      mcpInfo += '   - Use the returned actual ID value in your parameters\n\n';
      mcpInfo += '2. To get table schema:\n';
      mcpInfo += '   - Call: `postgresql-hub` tool with query: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = \'users\';`\n';
      mcpInfo += '   - Use the returned schema information to generate valid test data\n\n';
      mcpInfo += '**Parameter Generation Rules:**\n\n';
      mcpInfo += '- First call MCP tools to query database for real data\n';
      mcpInfo += '- Use the actual returned values in your test parameters\n';
      mcpInfo += '- Never use placeholder syntax like `{{variable}}` or template strings\n';
      mcpInfo += '- Generate concrete, valid values based on real database content\n\n';
      mcpInfo += '**Available MCP Tools:**\n';
      mcpInfo += '- `postgresql-hub`: Execute SQL queries against the database\n';
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

  // 工具上下文
  const toolsContext = `You have the following available interface message for THIS BATCH (5 per call). Use the exact value in the "name" field as task.toolName when planning. Do NOT invent new tool names. Keep parameters aligned with inputSchema.\nINTERFACE_JSON=\n${JSON.stringify(selectedToolMeta, null, 2)}`;

  // 规划上下文消息
  const planningContextMsg = planningContext;

  // 统一的输出规则（合并所有约束条件）
  const outputRules = [
    "OUTPUT_RULES:",
    "- WORKFLOW REQUIREMENTS:",
    "  * PHASE 1: Tool Calling Phase - You MUST first call available MCP tools to gather real data from the database",
    "  * PHASE 2: JSON Generation Phase - After gathering real data, generate the final JSON response",
    "  * You are REQUIRED to call MCP tools (like postgresql-hub) to get actual database data before generating parameters",
    "  * NEVER use template strings, placeholders, or mock data in parameters",
    "- FINAL OUTPUT FORMAT:",
    "  * After tool calling phase, you MUST return only a JSON object with the following structure:",
    "  * Root object must have: batchIndex (number), tasks (array)",
    "  * Each task object must have:",
    "    - batchIndex: number (must equal root batchIndex)",
    "    - taskId: string (1-64 chars, only letters/numbers/underscore/dot/colon/dash)",
    "    - toolName: string (exact tool name from tools list)",
    "    - description: string (task description)",
    "    - parameters: object or string (tool parameters with REAL DATA only)",
    "    - complexity: 'low' | 'medium' | 'high'",
    "    - isRequiredValidateByDatabase: boolean (true for operations that modify DB or need validation)",
    "- BATCH CONSTRAINTS:",
    "  * All taskIds within same batch must be unique",
    "  * Each task's batchIndex must equal the root batchIndex",
    "  * Tasks must ONLY use tools in this batch; use exact tool name from tools list",
    "- PARAMETER CONSTRAINTS:",
    "  * Parameters must conform to the tool inputSchema",
    "  * Parameters must contain ONLY real data obtained from MCP tool calls",
    "  * FORBIDDEN: Template strings like {{execute_sql(...)}}, placeholder values, or mock data",
    "  * REQUIRED: Use actual values returned from database queries",
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
