import { z } from "zod";

// Evaluation status enum
export const EvaluationStatus = z.enum(["SUCCESS", "FAILURE"]);

// Confidence level enum
export const ConfidenceLevel = z.enum(["LOW", "MEDIUM", "HIGH"]);

// Failure category enum for better classification
export const FailureCategory = z.enum([
  "PARAMETER_ERROR",
  "EXECUTION_ERROR", 
  "TIMEOUT_ERROR",
  "PERMISSION_ERROR",
  "NETWORK_ERROR",
  "VALIDATION_ERROR",
  "RESOURCE_ERROR",
  "LOGIC_ERROR",
  "UNKNOWN_ERROR"
]);

// Remediation action schema
export const RemediationAction = z.object({
  action: z.string().describe("Specific action to take"),
  priority: z.enum(["HIGH", "MEDIUM", "LOW"]).describe("Priority level of this action"),
  description: z.string().describe("Detailed description of the remediation step")
});

// Main evaluation output schema
export const evaluationOutputSchema = z.object({
  status: EvaluationStatus.describe("Overall evaluation result: SUCCESS or FAILURE"),
  
  reason: z.string()
    .min(10)
    .max(500)
    .describe("Clear and concise explanation of the evaluation result"),
  
  confidence: ConfidenceLevel.describe("Confidence level in the evaluation result"),
  
  // Failure-specific fields (optional, only present when status is FAILURE)
  failureAnalysis: z.object({
    category: FailureCategory.describe("Classification of the failure type"),
    rootCause: z.string()
      .min(10)
      .max(300)
      .describe("Root cause analysis of the failure"),
    impactAssessment: z.string()
      .min(5)
      .max(200)
      .describe("Assessment of the failure's impact on the overall test"),
    technicalDetails: z.string()
      .max(400)
      .nullable()
      .optional()
      .describe("Technical details about the failure (error messages, stack traces, etc.)")
  }).nullable().optional().describe("Detailed failure analysis (only present when status is FAILURE)"),
  
  // Remediation suggestions (optional)
  remediationSuggestions: z.array(RemediationAction)
    .max(5)
    .nullable()
    .optional()
    .describe("Suggested actions to fix the issue or improve the implementation"),
  
  // Execution context
  executionContext: z.object({
    toolName: z.string().describe("Name of the tool that was executed"),
    executionTime: z.number().nullable().optional().describe("Execution time in milliseconds if available"),
    resourcesUsed: z.array(z.string()).nullable().optional().describe("Resources or dependencies that were involved")
  }).describe("Context information about the tool execution")
}).refine(
  (data) => {
    // If status is FAILURE, failureAnalysis should be present
    if (data.status === "FAILURE" && !data.failureAnalysis) {
      return false;
    }
    return true;
  },
  {
    message: "failureAnalysis is required when status is FAILURE"
  }
);

// Export the type for TypeScript usage
export type EvaluationOutput = z.infer<typeof evaluationOutputSchema>;
export type EvaluationStatus = z.infer<typeof EvaluationStatus>;
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;
export type FailureCategory = z.infer<typeof FailureCategory>;
export type RemediationAction = z.infer<typeof RemediationAction>;