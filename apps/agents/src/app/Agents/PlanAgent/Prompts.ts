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
