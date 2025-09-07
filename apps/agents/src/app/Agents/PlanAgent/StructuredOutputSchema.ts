import { z } from "zod";

// 复杂度枚举类型
const ComplexityLevel = z.enum(["low", "medium", "high"]);

// 任务参数类型 - 可以是对象或字符串
const TaskParameters = z.union([
  z.record(z.any()), // 对象类型
  z.string()          // 字符串类型
]);

// 单个任务的schema
const TaskSchema = z.object({
  batchIndex: z.number().describe("批次索引"),
  // 限制 taskId 的格式与长度，便于服务端生成/校验与落库
  taskId: z.string()
    .min(1, "taskId 不能为空")
    .max(64, "taskId 最长 64 个字符")
    .regex(/^[A-Za-z0-9_.:-]+$/, "taskId 只能包含字母、数字、下划线、点、冒号和短横线" )
    .describe("任务唯一标识符"),
  toolName: z.string().describe("工具名称"),
  description: z.string().describe("任务描述"),
  parameters: TaskParameters.describe("任务参数，可以是对象或字符串格式"),
  complexity: ComplexityLevel.describe("任务复杂度级别"),
  isRequiredValidateByDatabase: z.boolean().describe("是否需要数据库验证")
});

// 计划输出的完整schema
export const planOutputSchema = z.object({
  batchIndex: z.number().describe("当前批次索引"),
  tasks: z.array(TaskSchema).describe("任务列表")
}).superRefine((data, ctx) => {
  // 同一批次内 taskId 唯一
  const ids = data.tasks.map(t => t.taskId);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tasks"],
      message: "同一批次内 taskId 必须唯一",
    });
  }
  // 强制每个任务的 batchIndex 等于顶层 batchIndex
  for (let i = 0; i < data.tasks.length; i++) {
    if (data.tasks[i].batchIndex !== data.batchIndex) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tasks", i, "batchIndex"],
        message: "task.batchIndex 必须等于顶层 batchIndex",
      });
    }
  }
});

// 导出类型定义
export type PlanOutput = z.infer<typeof planOutputSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type ComplexityType = z.infer<typeof ComplexityLevel>;