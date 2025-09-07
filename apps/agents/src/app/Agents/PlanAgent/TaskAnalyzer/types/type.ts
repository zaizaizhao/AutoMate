// 任务类型定义
// 任务的整体分析（暂时不用）
export interface TaskAnalysisResult {
  totalTasks: number;
  tasksByComplexity: Record<string, ToolTask[]>;
  dependencyGraph: Map<string, string[]>;
  estimatedTotalDuration: number;
  recommendedBatchSize: number;
}

// 某个task的信息
export interface ToolTask {
  taskId: string;
  toolName: string;
  description: string;
  parameters: Record<string, any>;
  complexity: 'low' | 'medium' | 'high';
  isValidateByDatabase: boolean
}

// llm输出的batch信息 TaskPlanedForTest[]
export interface TaskPlanedForTest {
  batchIndex:number;
  taskId: string;
  toolName: string;
  description: string;
  parameters: Record<string, any> | string;
  complexity: 'low' | 'medium' | 'high';
  isRequiredValidateByDatabase: boolean
}

//llm输出的batch信息 BatchTasks[]
export interface BatchTasks {
  batchIndex:number;
  tasks:TaskPlanedForTest[]
}


// 流程类型定义 (planagent需要获取上次的PlanProgress，以及更新当前的PlanProgress)
export interface PlanProgress {
  planId: string;
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  currentBatchIndex: number;
  overallSuccessRate: number;
  lastUpdated: Date;
}
