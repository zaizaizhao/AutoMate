// memory/SharedMemoryManager.ts
import { Pool } from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
// import { BaseStore } from '@langchain/langgraph'; // 暂时注释掉未使用的导入
import { PostgreSQLStore } from "./PostgreSQLStore.js";

export interface MemoryNamespace {
  project: string;
  environment: string;
  agent_type: string;
  session_id?: string;
}

export interface SharedMemoryItem {
  key: string;
  value: any;
  metadata?: Record<string, any>;
  expiresAt?: Date;
}

export interface TaskPlanedForTest {
  batchIndex: number;
  taskId: string;
  toolName: string;
  description: string;
  parameters: Record<string, any> | string;
  complexity: "low" | "medium" | "high";
  isRequiredValidateByDatabase: boolean;
}

export interface TaskTest {
  testId: string;
  taskId: string;
  threadId: string;
  toolName: string;
  testData: Record<string, any>;
  testResult?: Record<string, any>;
  evaluationResult?: Record<string, any>;
  status: "pending" | "running" | "completed" | "failed";
  errorMessage?: string;
  executionTimeMs?: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface PlanProgress {
  planId: string;
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  currentBatchIndex: number;
  overallSuccessRate: number;
  lastUpdated: Date;
}

export interface TaskStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  byComplexity: Record<string, number>;
}

export interface BatchStats {
  total: number;
  completed: number;
  failed: number;
  successRate: number;
}

export class SharedMemoryManager {
  private pool: Pool;
  private checkpointer: PostgresSaver;
  private store: PostgreSQLStore;

  constructor(pool: Pool) {
    this.pool = pool;
    this.checkpointer = new PostgresSaver(pool);
    this.store = new PostgreSQLStore(pool);
  }

  async initialize(): Promise<void> {
    // 初始化检查点表
    await this.checkpointer.setup();

    // 初始化自定义表
    await this.setupCustomTables();
  }

  private async setupCustomTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // 创建 memory_store 表（如果不存在）
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory_store (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          namespace_path TEXT[] NOT NULL,
          key TEXT NOT NULL,
          value JSONB NOT NULL,
          metadata JSONB DEFAULT '{}',
          expires_at TIMESTAMP WITH TIME ZONE,
          data_type VARCHAR(50),
          tags JSONB,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE(namespace_path, key)
        );
        
        CREATE INDEX IF NOT EXISTS idx_memory_store_namespace_key ON memory_store(namespace_path, key);
        CREATE INDEX IF NOT EXISTS idx_memory_store_expires_at ON memory_store(expires_at);
        CREATE INDEX IF NOT EXISTS idx_memory_store_data_type ON memory_store(data_type);
        CREATE INDEX IF NOT EXISTS idx_memory_store_tags ON memory_store USING GIN(tags);
      `);

      // 创建 task_plans 表
      await client.query(`
        CREATE TABLE IF NOT EXISTS task_plans (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          plan_id VARCHAR(255) NOT NULL,
          batch_index INTEGER NOT NULL,
          task_id VARCHAR(255) NOT NULL UNIQUE,
          tool_name VARCHAR(255) NOT NULL,
          description TEXT,
          parameters JSONB,
          complexity VARCHAR(20) CHECK (complexity IN ('low', 'medium', 'high')),
          is_required_validate_by_database BOOLEAN DEFAULT false,
          status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
          result JSONB,
          error_message TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          started_at TIMESTAMP WITH TIME ZONE,
          completed_at TIMESTAMP WITH TIME ZONE
        );
        
        CREATE INDEX IF NOT EXISTS idx_task_plans_plan_id ON task_plans(plan_id);
        CREATE INDEX IF NOT EXISTS idx_task_plans_batch_index ON task_plans(plan_id, batch_index);
        CREATE INDEX IF NOT EXISTS idx_task_plans_task_id ON task_plans(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_plans_tool_name ON task_plans(tool_name);
        CREATE INDEX IF NOT EXISTS idx_task_plans_status ON task_plans(status);
        CREATE INDEX IF NOT EXISTS idx_task_plans_complexity ON task_plans(complexity);
      `);

      // 创建 plan_progress 表
      await client.query(`
        CREATE TABLE IF NOT EXISTS plan_progress (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          plan_id VARCHAR(255) NOT NULL UNIQUE,
          total_batches INTEGER NOT NULL DEFAULT 0,
          completed_batches INTEGER NOT NULL DEFAULT 0,
          failed_batches INTEGER NOT NULL DEFAULT 0,
          current_batch_index INTEGER NOT NULL DEFAULT 0,
          overall_success_rate DECIMAL(5,2) DEFAULT 0.00,
          status VARCHAR(20) DEFAULT 'planning' CHECK (status IN ('planning', 'running', 'completed', 'failed', 'paused')),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          started_at TIMESTAMP WITH TIME ZONE,
          completed_at TIMESTAMP WITH TIME ZONE
        );
        
        CREATE INDEX IF NOT EXISTS idx_plan_progress_plan_id ON plan_progress(plan_id);
        CREATE INDEX IF NOT EXISTS idx_plan_progress_status ON plan_progress(status);
        CREATE INDEX IF NOT EXISTS idx_plan_progress_last_updated ON plan_progress(last_updated DESC);
      `);

      // 创建 task_test 表
      await client.query(`
        CREATE TABLE IF NOT EXISTS task_test (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          test_id VARCHAR(255) NOT NULL UNIQUE,
          task_id VARCHAR(255) NOT NULL,
          thread_id VARCHAR(255) NOT NULL,
          tool_name VARCHAR(255) NOT NULL,
          test_data JSONB NOT NULL,
          test_result JSONB,
          evaluation_result JSONB,
          status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
          error_message TEXT,
          execution_time_ms INTEGER,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          started_at TIMESTAMP WITH TIME ZONE,
          completed_at TIMESTAMP WITH TIME ZONE
        );
        
        CREATE INDEX IF NOT EXISTS idx_task_test_test_id ON task_test(test_id);
        CREATE INDEX IF NOT EXISTS idx_task_test_task_id ON task_test(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_test_thread_id ON task_test(thread_id);
        CREATE INDEX IF NOT EXISTS idx_task_test_tool_name ON task_test(tool_name);
        CREATE INDEX IF NOT EXISTS idx_task_test_status ON task_test(status);
        CREATE INDEX IF NOT EXISTS idx_task_test_created_at ON task_test(created_at DESC);
      `);
    } finally {
      client.release();
    }
  }

  // 获取命名空间路径
  private getNamespacePath(namespace: MemoryNamespace): string[] {
    const path = [
      namespace.project,
      namespace.environment,
      namespace.agent_type,
    ];
    if (namespace.session_id) {
      path.push(namespace.session_id);
    }
    return path;
  }

  // 存储共享记忆
  async setSharedMemory(
    namespace: MemoryNamespace,
    key: string,
    value: any,
    options?: {
      expiresIn?: number; // 秒
      metadata?: Record<string, any>;
    }
  ): Promise<void> {
    const namespacePath = this.getNamespacePath(namespace);
    const expiresAt = options?.expiresIn
      ? new Date(Date.now() + options.expiresIn * 1000)
      : null;

    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO memory_store (namespace_path, key, value, expires_at, metadata, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (namespace_path, key)
         DO UPDATE SET 
           value = EXCLUDED.value,
           expires_at = EXCLUDED.expires_at,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()`,
        [
          namespacePath,
          key,
          JSON.stringify(value),
          expiresAt,
          JSON.stringify(options?.metadata || {}),
        ]
      );
    } finally {
      client.release();
    }
  }

  // 获取共享记忆
  async getSharedMemory(
    namespace: MemoryNamespace,
    key: string
  ): Promise<SharedMemoryItem | null> {
    const namespacePath = this.getNamespacePath(namespace);

    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT key, value, metadata, expires_at, updated_at
         FROM memory_store
         WHERE namespace_path = $1 AND key = $2
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [namespacePath, key]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      // 兼容 value/metadata 可能是：
      // 1) JSON 字符串（需要 JSON.parse）
      // 2) 普通明文字符串（不能 parse，需要直接返回）
      // 3) 已经是对象
      let parsedValue: any = row.value;
      if (typeof parsedValue === "string") {
        try {
          parsedValue = JSON.parse(parsedValue);
        } catch {
          // 保持原字符串
        }
      }

      let parsedMetadata: any = row.metadata ?? {};
      if (typeof parsedMetadata === "string") {
        try {
          parsedMetadata = JSON.parse(parsedMetadata);
        } catch {
          // 保持原字符串或置为 {}
        }
      }

      return {
        key: row.key,
        value: parsedValue,
        metadata: parsedMetadata || {},
        expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      };
    } finally {
      client.release();
    }
  }

  // 列出命名空间下的所有记忆
  async listSharedMemories(
    namespace: MemoryNamespace,
    options?: {
      prefix?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<SharedMemoryItem[]> {
    const namespacePath = this.getNamespacePath(namespace);

    let query = `
      SELECT key, value, metadata, expires_at, updated_at
      FROM memory_store
      WHERE namespace_path = $1
        AND (expires_at IS NULL OR expires_at > NOW())
    `;

    const params: any[] = [namespacePath];

    if (options?.prefix) {
      query += ` AND key LIKE $${params.length + 1}`;
      params.push(`${options.prefix}%`);
    }

    query += ` ORDER BY updated_at DESC`;

    if (options?.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(options.offset);
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query(query, params);

      return result.rows.map((row) => ({
        key: row.key,
        value:
          typeof row.value === "string" ? JSON.parse(row.value) : row.value,
        metadata: row.metadata
          ? typeof row.metadata === "string"
            ? JSON.parse(row.metadata)
            : row.metadata
          : {},
        expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      }));
    } finally {
      client.release();
    }
  }

  // 删除共享记忆
  async deleteSharedMemory(
    namespace: MemoryNamespace,
    key: string
  ): Promise<boolean> {
    const namespacePath = this.getNamespacePath(namespace);

    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM memory_store WHERE namespace_path = $1 AND key = $2`,
        [namespacePath, key]
      );

      return result.rowCount! > 0;
    } finally {
      client.release();
    }
  }

  // 清理过期记忆
  async cleanupExpiredMemories(): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM memory_store WHERE expires_at IS NOT NULL AND expires_at < NOW()`
      );

      return result.rowCount as number;
    } finally {
      client.release();
    }
  }

  // 获取检查点保存器（用于LangGraph）
  getCheckpointer(): PostgresSaver {
    return this.checkpointer;
  }

  // 获取存储器（用于LangGraph BaseStore）
  getStore(): PostgreSQLStore {
    return this.store;
  }

  // ==================== TaskPlan 相关方法 ====================

  // 保存单个任务计划
  async saveTaskPlan(planId: string, task: TaskPlanedForTest): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO task_plans (
          plan_id, batch_index, task_id, tool_name, description, 
          parameters, complexity, is_required_validate_by_database
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (task_id) 
        DO UPDATE SET 
          batch_index = EXCLUDED.batch_index,
          tool_name = EXCLUDED.tool_name,
          description = EXCLUDED.description,
          parameters = EXCLUDED.parameters,
          complexity = EXCLUDED.complexity,
          is_required_validate_by_database = EXCLUDED.is_required_validate_by_database,
          updated_at = NOW()`,
        [
          planId,
          task.batchIndex,
          task.taskId,
          task.toolName,
          task.description,
          JSON.stringify(task.parameters),
          task.complexity,
          task.isRequiredValidateByDatabase,
        ]
      );
    } finally {
      client.release();
    }
  }

  // 批量保存任务计划
  async saveTaskPlans(
    planId: string,
    tasks: TaskPlanedForTest[]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const task of tasks) {
        await client.query(
          `INSERT INTO task_plans (
            plan_id, batch_index, task_id, tool_name, description, 
            parameters, complexity, is_required_validate_by_database
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (task_id) 
          DO UPDATE SET 
            batch_index = EXCLUDED.batch_index,
            tool_name = EXCLUDED.tool_name,
            description = EXCLUDED.description,
            parameters = EXCLUDED.parameters,
            complexity = EXCLUDED.complexity,
            is_required_validate_by_database = EXCLUDED.is_required_validate_by_database,
            updated_at = NOW()`,
          [
            planId,
            task.batchIndex,
            task.taskId,
            task.toolName,
            task.description,
            JSON.stringify(task.parameters),
            task.complexity,
            task.isRequiredValidateByDatabase,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // 获取单个任务计划
  async getTaskPlan(taskId: string): Promise<TaskPlanedForTest | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT batch_index, task_id, tool_name, description, parameters, complexity, is_required_validate_by_database
         FROM task_plans
         WHERE task_id = $1`,
        [taskId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        batchIndex: row.batch_index,
        taskId: row.task_id,
        toolName: row.tool_name,
        description: row.description,
        parameters:
          typeof row.parameters === "string"
            ? JSON.parse(row.parameters)
            : row.parameters,
        complexity: row.complexity,
        isRequiredValidateByDatabase: row.is_required_validate_by_database,
      };
    } finally {
      client.release();
    }
  }

  // 按批次获取任务计划
  async getTaskPlansByBatch(
    planId: string,
    batchIndex: number
  ): Promise<TaskPlanedForTest[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT batch_index, task_id, tool_name, description, parameters, complexity, is_required_validate_by_database
         FROM task_plans
         WHERE plan_id = $1 AND batch_index = $2
         ORDER BY created_at ASC`,
        [planId, batchIndex]
      );

      return result.rows.map((row) => ({
        batchIndex: row.batch_index,
        taskId: row.task_id,
        toolName: row.tool_name,
        description: row.description,
        parameters:
          typeof row.parameters === "string"
            ? JSON.parse(row.parameters)
            : row.parameters,
        complexity: row.complexity,
        isRequiredValidateByDatabase: row.is_required_validate_by_database,
      }));
    } finally {
      client.release();
    }
  }

  // 按计划ID获取所有任务
  async getTaskPlansByPlan(planId: string): Promise<TaskPlanedForTest[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT batch_index, task_id, tool_name, description, parameters, complexity, is_required_validate_by_database
         FROM task_plans
         WHERE plan_id = $1
         ORDER BY batch_index ASC, created_at ASC`,
        [planId]
      );

      return result.rows.map((row) => ({
        batchIndex: row.batch_index,
        taskId: row.task_id,
        toolName: row.tool_name,
        description: row.description,
        parameters:
          typeof row.parameters === "string"
            ? JSON.parse(row.parameters)
            : row.parameters,
        complexity: row.complexity,
        isRequiredValidateByDatabase: row.is_required_validate_by_database,
      }));
    } finally {
      client.release();
    }
  }

  // 更新任务状态
  async updateTaskPlanStatus(
    taskId: string,
    status: string,
    result?: any,
    errorMessage?: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const now = new Date();
      let query = `UPDATE task_plans SET status = $1, updated_at = $2`;
      const params: any[] = [status, now];
      let paramIndex = 3;

      if (result !== undefined) {
        query += `, result = $${paramIndex}`;
        params.push(JSON.stringify(result));
        paramIndex++;
      }

      if (errorMessage !== undefined) {
        query += `, error_message = $${paramIndex}`;
        params.push(errorMessage);
        paramIndex++;
      }

      if (status === "running") {
        query += `, started_at = $${paramIndex}`;
        params.push(now);
        paramIndex++;
      } else if (status === "completed" || status === "failed") {
        query += `, completed_at = $${paramIndex}`;
        params.push(now);
        paramIndex++;
      }

      query += ` WHERE task_id = $${paramIndex}`;
      params.push(taskId);

      await client.query(query, params);
    } finally {
      client.release();
    }
  }

  // 删除任务计划
  async deleteTaskPlan(taskId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM task_plans WHERE task_id = $1`,
        [taskId]
      );

      return result.rowCount! > 0;
    } finally {
      client.release();
    }
  }

  // 删除计划的所有任务
  async deleteTaskPlansByPlan(planId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM task_plans WHERE plan_id = $1`,
        [planId]
      );

      return result.rowCount as number;
    } finally {
      client.release();
    }
  }

  // ==================== PlanProgress 相关方法 ====================

  // 保存计划进度
  async savePlanProgress(progress: PlanProgress): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO plan_progress (
          plan_id, total_batches, completed_batches, failed_batches,
          current_batch_index, overall_success_rate, last_updated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (plan_id)
        DO UPDATE SET
          total_batches = EXCLUDED.total_batches,
          completed_batches = EXCLUDED.completed_batches,
          failed_batches = EXCLUDED.failed_batches,
          current_batch_index = EXCLUDED.current_batch_index,
          overall_success_rate = EXCLUDED.overall_success_rate,
          last_updated = EXCLUDED.last_updated`,
        [
          progress.planId,
          progress.totalBatches,
          progress.completedBatches,
          progress.failedBatches,
          progress.currentBatchIndex,
          progress.overallSuccessRate,
          progress.lastUpdated,
        ]
      );
    } finally {
      client.release();
    }
  }

  // 获取计划进度
  async getPlanProgress(planId: string): Promise<PlanProgress | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT plan_id, total_batches, completed_batches, failed_batches,
                current_batch_index, overall_success_rate, last_updated
         FROM plan_progress
         WHERE plan_id = $1`,
        [planId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        planId: row.plan_id,
        totalBatches: row.total_batches,
        completedBatches: row.completed_batches,
        failedBatches: row.failed_batches,
        currentBatchIndex: row.current_batch_index,
        overallSuccessRate: parseFloat(row.overall_success_rate),
        lastUpdated: new Date(row.last_updated),
      };
    } finally {
      client.release();
    }
  }

  // 更新计划进度
  async updatePlanProgress(
    planId: string,
    updates: Partial<PlanProgress>
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const setParts: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (updates.totalBatches !== undefined) {
        setParts.push(`total_batches = $${paramIndex}`);
        params.push(updates.totalBatches);
        paramIndex++;
      }

      if (updates.completedBatches !== undefined) {
        setParts.push(`completed_batches = $${paramIndex}`);
        params.push(updates.completedBatches);
        paramIndex++;
      }

      if (updates.failedBatches !== undefined) {
        setParts.push(`failed_batches = $${paramIndex}`);
        params.push(updates.failedBatches);
        paramIndex++;
      }

      if (updates.currentBatchIndex !== undefined) {
        setParts.push(`current_batch_index = $${paramIndex}`);
        params.push(updates.currentBatchIndex);
        paramIndex++;
      }

      if (updates.overallSuccessRate !== undefined) {
        setParts.push(`overall_success_rate = $${paramIndex}`);
        params.push(updates.overallSuccessRate);
        paramIndex++;
      }

      setParts.push(`last_updated = $${paramIndex}`);
      params.push(updates.lastUpdated || new Date());
      paramIndex++;

      params.push(planId);

      const query = `UPDATE plan_progress SET ${setParts.join(", ")} WHERE plan_id = $${paramIndex}`;
      await client.query(query, params);
    } finally {
      client.release();
    }
  }

  // 增加完成批次数
  async incrementCompletedBatches(planId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE plan_progress 
         SET completed_batches = completed_batches + 1, 
             last_updated = NOW()
         WHERE plan_id = $1`,
        [planId]
      );
    } finally {
      client.release();
    }
  }

  // 增加失败批次数
  async incrementFailedBatches(planId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE plan_progress 
         SET failed_batches = failed_batches + 1, 
             last_updated = NOW()
         WHERE plan_id = $1`,
        [planId]
      );
    } finally {
      client.release();
    }
  }

  // 更新当前批次索引
  async updateCurrentBatchIndex(
    planId: string,
    batchIndex: number
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE plan_progress 
         SET current_batch_index = $1, 
             last_updated = NOW()
         WHERE plan_id = $2`,
        [batchIndex, planId]
      );
    } finally {
      client.release();
    }
  }

  // 计算成功率
  async calculateSuccessRate(planId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT 
           CASE 
             WHEN (completed_batches + failed_batches) = 0 THEN 0
             ELSE ROUND((completed_batches::decimal / (completed_batches + failed_batches)) * 100, 2)
           END as success_rate
         FROM plan_progress
         WHERE plan_id = $1`,
        [planId]
      );

      if (result.rows.length === 0) {
        return 0;
      }

      const successRate = parseFloat(result.rows[0].success_rate);

      // 更新数据库中的成功率
      await client.query(
        `UPDATE plan_progress 
         SET overall_success_rate = $1, 
             last_updated = NOW()
         WHERE plan_id = $2`,
        [successRate, planId]
      );

      return successRate;
    } finally {
      client.release();
    }
  }

  // 获取所有计划进度
  async getAllPlanProgress(status?: string): Promise<PlanProgress[]> {
    const client = await this.pool.connect();
    try {
      let query = `
        SELECT plan_id, total_batches, completed_batches, failed_batches,
               current_batch_index, overall_success_rate, last_updated
        FROM plan_progress
      `;
      const params: any[] = [];

      if (status) {
        query += ` WHERE status = $1`;
        params.push(status);
      }

      query += ` ORDER BY last_updated DESC`;

      const result = await client.query(query, params);

      return result.rows.map((row) => ({
        planId: row.plan_id,
        totalBatches: row.total_batches,
        completedBatches: row.completed_batches,
        failedBatches: row.failed_batches,
        currentBatchIndex: row.current_batch_index,
        overallSuccessRate: parseFloat(row.overall_success_rate),
        lastUpdated: new Date(row.last_updated),
      }));
    } finally {
      client.release();
    }
  }

  // 删除计划进度
  async deletePlanProgress(planId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM plan_progress WHERE plan_id = $1`,
        [planId]
      );

      return result.rowCount! > 0;
    } finally {
      client.release();
    }
  }

  // ==================== Task Test Methods ====================

  // 保存测试记录
  async saveTaskTest(
    taskTest: Omit<TaskTest, "createdAt" | "updatedAt">
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO task_test (
          test_id, task_id, thread_id, tool_name, test_data, test_result, evaluation_result,
          status, error_message, execution_time_ms, started_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (test_id) 
        DO UPDATE SET 
          test_result = EXCLUDED.test_result,
          evaluation_result = EXCLUDED.evaluation_result,
          status = EXCLUDED.status,
          error_message = EXCLUDED.error_message,
          execution_time_ms = EXCLUDED.execution_time_ms,
          updated_at = NOW(),
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at`,
        [
          taskTest.testId,
          taskTest.taskId,
          taskTest.threadId,
          taskTest.toolName,
          JSON.stringify(taskTest.testData),
          taskTest.testResult ? JSON.stringify(taskTest.testResult) : null,
          taskTest.evaluationResult ? JSON.stringify(taskTest.evaluationResult) : null,
          taskTest.status,
          taskTest.errorMessage,
          taskTest.executionTimeMs,
          taskTest.startedAt,
          taskTest.completedAt,
        ]
      );
    } finally {
      client.release();
    }
  }

  async saveTaskTestBatch(
    taskTests: Omit<TaskTest, "createdAt" | "updatedAt">[]
  ): Promise<void> {
    if (taskTests.length === 0) return;

    const client = await this.pool.connect();
    try {
      const query = `
        INSERT INTO task_test (test_id, task_id, thread_id, tool_name, test_data, test_result, evaluation_result, status, error_message, started_at)
        VALUES ${taskTests.map((_, index) => `($${index * 10 + 1}, $${index * 10 + 2}, $${index * 10 + 3}, $${index * 10 + 4}, $${index * 10 + 5}, $${index * 10 + 6}, $${index * 10 + 7}, $${index * 10 + 8}, $${index * 10 + 9}, $${index * 10 + 10})`).join(", ")}
      `;

      const values: any[] = [];
      taskTests.forEach((taskTest) => {
        values.push(
          taskTest.testId,
          taskTest.taskId,
          taskTest.threadId,
          taskTest.toolName,
          JSON.stringify(taskTest.testData),
          JSON.stringify(taskTest.testResult),
          taskTest.evaluationResult ? JSON.stringify(taskTest.evaluationResult) : null,
          taskTest.status,
          taskTest.errorMessage,
          taskTest.startedAt || new Date()
        );
      });

      await client.query(query, values);
    } finally {
      client.release();
    }
  }

  // 批量保存测试记录
  async saveTaskTests(
    taskTests: Omit<TaskTest, "createdAt" | "updatedAt">[]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const taskTest of taskTests) {
        await client.query(
          `INSERT INTO task_test (
            test_id, task_id, thread_id, tool_name, test_data, test_result, evaluation_result,
            status, error_message, execution_time_ms, started_at, completed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (test_id) 
          DO UPDATE SET 
            test_result = EXCLUDED.test_result,
            evaluation_result = EXCLUDED.evaluation_result,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            execution_time_ms = EXCLUDED.execution_time_ms,
            updated_at = NOW(),
            started_at = EXCLUDED.started_at,
            completed_at = EXCLUDED.completed_at`,
          [
            taskTest.testId,
            taskTest.taskId,
            taskTest.threadId,
            taskTest.toolName,
            JSON.stringify(taskTest.testData),
            taskTest.testResult ? JSON.stringify(taskTest.testResult) : null,
            taskTest.evaluationResult ? JSON.stringify(taskTest.evaluationResult) : null,
            taskTest.status,
            taskTest.errorMessage,
            taskTest.executionTimeMs,
            taskTest.startedAt,
            taskTest.completedAt,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // 获取测试记录
  async getTaskTest(testId: string): Promise<TaskTest | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT test_id, task_id, thread_id, tool_name, test_data, test_result, evaluation_result,
                status, error_message, execution_time_ms, created_at, updated_at,
                started_at, completed_at
         FROM task_test
         WHERE test_id = $1`,
        [testId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        testId: row.test_id,
        taskId: row.task_id,
        threadId: row.thread_id,
        toolName: row.tool_name,
        testData:
          typeof row.test_data === "string"
            ? JSON.parse(row.test_data)
            : row.test_data,
        testResult: row.test_result
          ? typeof row.test_result === "string"
            ? JSON.parse(row.test_result)
            : row.test_result
          : undefined,
        evaluationResult: row.evaluation_result
          ? typeof row.evaluation_result === "string"
            ? JSON.parse(row.evaluation_result)
            : row.evaluation_result
          : undefined,
        status: row.status,
        errorMessage: row.error_message,
        executionTimeMs: row.execution_time_ms,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        startedAt: row.started_at ? new Date(row.started_at) : undefined,
        completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      };
    } finally {
      client.release();
    }
  }

  // 根据任务ID获取测试记录
  async getTaskTestsByTaskId(taskId: string): Promise<TaskTest[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT test_id, task_id, thread_id, tool_name, test_data, test_result, evaluation_result,
                status, error_message, execution_time_ms, created_at, updated_at,
                started_at, completed_at
         FROM task_test
         WHERE task_id = $1
         ORDER BY created_at ASC`,
        [taskId]
      );

      return result.rows.map((row) => ({
        testId: row.test_id,
        taskId: row.task_id,
        threadId: row.thread_id,
        toolName: row.tool_name,
        testData:
          typeof row.test_data === "string"
            ? JSON.parse(row.test_data)
            : row.test_data,
        testResult: row.test_result
          ? typeof row.test_result === "string"
            ? JSON.parse(row.test_result)
            : row.test_result
          : undefined,
        evaluationResult: row.evaluation_result
          ? typeof row.evaluation_result === "string"
            ? JSON.parse(row.evaluation_result)
            : row.evaluation_result
          : undefined,
        status: row.status,
        errorMessage: row.error_message,
        executionTimeMs: row.execution_time_ms,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        startedAt: row.started_at ? new Date(row.started_at) : undefined,
        completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      }));
    } finally {
      client.release();
    }
  }

  // 根据线程ID获取测试记录
  async getTaskTestsByThreadId(threadId: string): Promise<TaskTest[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT test_id, task_id, thread_id, tool_name, test_data, test_result, evaluation_result,
                status, error_message, execution_time_ms, created_at, updated_at,
                started_at, completed_at
         FROM task_test
         WHERE thread_id = $1
         ORDER BY created_at DESC`,
        [threadId]
      );

      return result.rows.map((row) => ({
        testId: row.test_id,
        taskId: row.task_id,
        threadId: row.thread_id,
        toolName: row.tool_name,
        testData:
          typeof row.test_data === "string"
            ? JSON.parse(row.test_data)
            : row.test_data,
        testResult: row.test_result
          ? typeof row.test_result === "string"
            ? JSON.parse(row.test_result)
            : row.test_result
          : undefined,
        evaluationResult: row.evaluation_result
          ? typeof row.evaluation_result === "string"
            ? JSON.parse(row.evaluation_result)
            : row.evaluation_result
          : undefined,
        status: row.status,
        errorMessage: row.error_message,
        executionTimeMs: row.execution_time_ms,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        startedAt: row.started_at ? new Date(row.started_at) : undefined,
        completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      }));
    } finally {
      client.release();
    }
  }

  // 更新测试状态
  async updateTaskTestStatus(
    testId: string,
    status: string,
    result?: any,
    errorMessage?: string,
    executionTimeMs?: number,
    evaluationResult?: any
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const now = new Date();
      let query = `UPDATE task_test SET status = $1, updated_at = $2`;
      const params: any[] = [status, now];
      let paramIndex = 3;

      if (result !== undefined) {
        query += `, test_result = $${paramIndex}`;
        params.push(JSON.stringify(result));
        paramIndex++;
      }

      if (errorMessage !== undefined) {
        query += `, error_message = $${paramIndex}`;
        params.push(errorMessage);
        paramIndex++;
      }

      if (executionTimeMs !== undefined) {
        query += `, execution_time_ms = $${paramIndex}`;
        params.push(executionTimeMs);
        paramIndex++;
      }

      if (evaluationResult !== undefined) {
        query += `, evaluation_result = $${paramIndex}`;
        params.push(JSON.stringify(evaluationResult));
        paramIndex++;
      }

      if (status === "running") {
        query += `, started_at = $${paramIndex}`;
        params.push(now);
        paramIndex++;
      } else if (status === "completed" || status === "failed") {
        query += `, completed_at = $${paramIndex}`;
        params.push(now);
        paramIndex++;
      }

      query += ` WHERE test_id = $${paramIndex}`;
      params.push(testId);

      await client.query(query, params);
    } finally {
      client.release();
    }
  }

  // 删除测试记录
  async deleteTaskTest(testId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM task_test WHERE test_id = $1`,
        [testId]
      );

      return result.rowCount! > 0;
    } finally {
      client.release();
    }
  }

  // 删除任务的所有测试记录
  async deleteTaskTestsByTaskId(taskId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM task_test WHERE task_id = $1`,
        [taskId]
      );

      return result.rowCount as number;
    } finally {
      client.release();
    }
  }

  // 删除线程的所有测试记录
  async deleteTaskTestsByThreadId(threadId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM task_test WHERE thread_id = $1`,
        [threadId]
      );

      return result.rowCount as number;
    } finally {
      client.release();
    }
  }
}
