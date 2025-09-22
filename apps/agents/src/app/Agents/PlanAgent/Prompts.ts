export const TOOL_MESSAGE_EXTRACT_PROMPT = `You are a helpful AI assistant.
You are a preprocessing agent responsible for API testing using tools.
Your task is to identify and catalog all available tools, organize them into a structured list of API testing tasks, 
and pass this list to downstream testing agents for execution.
System time: {system_time}`;

export const sqlToolPrompts = `
## Important: Using Real Data for Test Parameter Generation

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
   \`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'table_name' ORDER BY ordinal_position;\`
   - Understand field types, constraint conditions, and other information

2. **Get Sample Data**:
   - Query sample data: \`SELECT * FROM table_name LIMIT 5;\`
   - Understand data formats and patterns of actual values

3. **Get Real IDs**:
   - Get existing IDs: \`SELECT id FROM table_name WHERE conditions LIMIT 1;\`
   - For relational queries, ensure foreign key IDs actually exist

4. **Verify Data Existence**:
   - For query operations, first confirm there is queryable data: \`SELECT COUNT(*) FROM table_name;\`
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
1. First query user table structure: \`SELECT * FROM information_schema.columns WHERE table_name = 'users';\`
2. Get real user IDs: \`SELECT id FROM users LIMIT 3;\`
3. View user data examples: \`SELECT id, username, email FROM users LIMIT 5;\`
4. Generate test parameters based on real data, such as using real existing user IDs for query testing

### Important Notes

- Always query database state first before generating test parameters
- Avoid hardcoding any IDs or data values
- Ensure generated test data complies with business logic
- Prepare diverse real data for different test scenarios
`

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
  const toolsContext = `You have the following available tools for THIS BATCH (5 per call). Use the exact value in the "name" field as task.toolName when planning. Do NOT invent new tool names. Keep parameters aligned with inputSchema.\nTOOLS_JSON=\n${JSON.stringify(selectedToolMeta, null, 2)}`;

  // 规划上下文消息
  const planningContextMsg = planningContext;

  // 统一的输出规则（合并所有约束条件）
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
    "- BATCH CONSTRAINTS:",
    "  * All taskIds within same batch must be unique",
    "  * Each task's batchIndex must equal the root batchIndex",
    "  * Tasks must ONLY use tools in this batch; use exact tool name from tools list",
    "- PARAMETER CONSTRAINTS:",
    "  * Parameters must conform to the tool inputSchema",
    "  * Use real data from database queries when appropriate",
    "- FORMAT CONSTRAINTS:",
    "  * No code fences, no markdown, no natural language outside JSON",
    "  * Output must be valid, parseable JSON only",
  ].join("\n");

  return {
    systemPrompt,
    batchInfoContext,
    toolsContext,
    planningContextMsg,
    outputRules,
  };
}
