/**
 * Prompts for ExecuteTestAgent
 *
 * These prompts guide the TestAgent to: (1) call exactly one specified tool,
 * (2) generate realistic and boundary-aware arguments that satisfy the tool schema,
 * (3) avoid prose in responses, and (4) be deterministic and safe.
 */

export function buildSystemPrompt(): string {
  return [
    "You are ExecuteTestAgent, a deterministic test execution agent.",
    "Your job is to execute a single, explicit test task by calling exactly one given tool.",
    "Strict rules:",
    "- Call the specified tool exactly once.",
    "- Do not call any other tool.",
    "- Do not output any prose or commentary; respond only with a single tool call.",
    "- Ensure all arguments strictly satisfy the tool's JSON Schema (types, required fields, formats).",
    "- Generate realistic and boundary-aware values (min/max, empty/whitespace, special chars, length limits).",
    "- Keep inputs safe, idempotent, and non-destructive. Never include secrets or PII.",
    "- Prefer deterministic values (e.g., fixed dates in ISO 8601, stable identifiers).",
    "- If a field has constraints (enums, min/max, regex), adhere to them precisely.",
  ].join("\n");
}

export type BuildToolInvocationUserPromptOptions = {
  taskId?: string;
  toolName: string;
  description?: string;
  suggestedParams?: any;
  schema?: any;
};

export function buildToolInvocationUserPrompt(opts: BuildToolInvocationUserPromptOptions): string {
  const { taskId, toolName, description, suggestedParams, schema } = opts;

  const prettyParams = safePretty(suggestedParams);
  const schemaText = schema ? `Tool input schema (JSON Schema): ${safePretty(schema)}` :
    "Schema unknown: infer conservatively from provided parameters and description; obey common-sense types.";

  return [
    `Execute a single test task using the specified tool.`,
    taskId ? `Task ID: ${taskId}` : undefined,
    `Tool to call: ${toolName}`,
    description ? `Task description: ${description}` : undefined,
    `Planned parameters (may be partial; complete them as needed to satisfy the schema): ${prettyParams}`,
    schemaText,
    "Guidelines for constructing arguments:",
    "1) Satisfy the JSON Schema exactly: correct types, required fields present, valid formats, nested structures correct.",
    "2) Prefer realistic and boundary-aware values: test near min/max; include edge cases for lengths (0, 1, max-1, max).",
    "3) Handle text carefully: include safe special characters (e.g., '-', '_', ' '), avoid harmful payloads.",
    "4) Dates/times must be ISO 8601 strings; choose stable values (e.g., '2023-01-15T10:30:00Z').",
    "5) Numbers within allowed ranges; if schema has multiples or step constraints, respect them.",
    "6) Arrays/objects must match item and property schemas; include minimal valid shape when optional.",
    "7) Use deterministic placeholders for IDs (e.g., 'test-user-001', 'order-1001').",
    "8) Keep inputs safe and idempotent; do not request destructive actions.",
    "Output requirement: Respond ONLY with a single tool call for the tool above, with finalized arguments. No prose.",
  ].filter(Boolean).join("\n");
}

function safePretty(value: any): string {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}