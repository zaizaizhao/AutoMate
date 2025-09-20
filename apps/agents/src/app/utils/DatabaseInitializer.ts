import { Pool } from "pg";
import { URL } from "url";

/**
 * 数据库初始化工具类
 * 负责在应用启动前确保目标数据库存在
 */
export class DatabaseInitializer {
  /**
   * 确保数据库存在，如果不存在则创建
   * @param connectionString 完整的数据库连接字符串
   */
  static async ensureDatabaseExists(connectionString: string): Promise<void> {
    try {
      // 解析连接字符串
      const url = new URL(connectionString);
      const targetDatabase = url.pathname.slice(1); // 移除开头的 '/'

      if (!targetDatabase) {
        throw new Error("数据库名称不能为空");
      }

      // 创建连接到默认数据库 'postgres' 的连接字符串
      const adminUrl = new URL(connectionString);
      adminUrl.pathname = "/postgres";
      const adminConnectionString = adminUrl.toString();

      console.log(`[DB Init] 检查数据库 '${targetDatabase}' 是否存在...`);

      // 连接到 postgres 数据库检查目标数据库是否存在
      const adminPool = new Pool({
        connectionString: adminConnectionString,
        max: 1, // 只需要一个连接
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 10000,
      });

      try {
        const client = await adminPool.connect();

        try {
          // 检查数据库是否存在
          const result = await client.query(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            [targetDatabase]
          );

          if (result.rows.length === 0) {
            console.log(
              `[DB Init] 数据库 '${targetDatabase}' 不存在，正在创建...`
            );

            // 创建数据库（注意：数据库名不能使用参数化查询）
            // 为了安全，验证数据库名只包含字母、数字和下划线
            if (!/^[a-zA-Z0-9_]+$/.test(targetDatabase)) {
              throw new Error(`数据库名称 '${targetDatabase}' 包含非法字符`);
            }

            await client.query(`CREATE DATABASE "${targetDatabase}"`);
            console.log(`[DB Init] 数据库 '${targetDatabase}' 创建成功`);
          } else {
            console.log(`[DB Init] 数据库 '${targetDatabase}' 已存在`);
          }
        } finally {
          client.release();
        }
      } finally {
        await adminPool.end();
      }

      // 验证目标数据库连接
      console.log(`[DB Init] 验证数据库 '${targetDatabase}' 连接...`);
      const targetPool = new Pool({
        connectionString: connectionString,
        max: 1,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 10000,
      });

      try {
        const client = await targetPool.connect();
        await client.query("SELECT 1");
        client.release();
        console.log(`[DB Init] 数据库 '${targetDatabase}' 连接验证成功`);
      } finally {
        await targetPool.end();
      }
    } catch (error) {
      console.error("[DB Init] 数据库初始化失败:", error);
      throw error;
    }
  }

  /**
   * 创建基础表结构
   * @param connectionString 完整的数据库连接字符串
   */
  static async createBaseTables(connectionString: string): Promise<void> {
    console.log("[DB Init] 开始创建基础表结构...");
    
    const pool = new Pool({
      connectionString: connectionString,
      max: 1,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    });

    try {
      const client = await pool.connect();
      
      try {
        // 创建 memory_store 表
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

        // 创建 task_test 表（包含evaluation_result字段）
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
        
        console.log("[DB Init] 基础表结构创建完成");
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("[DB Init] 基础表结构创建失败:", error);
      throw error;
    } finally {
      await pool.end();
    }
  }

  /**
   * 执行数据库迁移，确保表结构是最新的
   * @param connectionString 完整的数据库连接字符串
   */
  static async migrateDatabase(connectionString: string): Promise<void> {
    console.log("[DB Migration] 开始执行数据库迁移...");
    
    const pool = new Pool({
      connectionString: connectionString,
      max: 1,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    });

    try {
      const client = await pool.connect();
      
      try {
        // 检查task_test表是否存在
        const tableCheck = await client.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_name = 'task_test' 
            AND table_schema = 'public'
        `);

        if (tableCheck.rows.length === 0) {
          console.log("[DB Migration] task_test表不存在，跳过字段迁移");
          console.log("[DB Migration] 数据库迁移完成");
          return;
        }

        // 检查task_test表是否存在evaluation_result字段
        const columnCheck = await client.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'task_test' 
            AND column_name = 'evaluation_result'
            AND table_schema = 'public'
        `);

        if (columnCheck.rows.length === 0) {
          console.log("[DB Migration] task_test表缺少evaluation_result字段，正在添加...");
          
          // 添加evaluation_result字段
          await client.query(`
            ALTER TABLE task_test 
            ADD COLUMN evaluation_result JSONB
          `);
          
          console.log("[DB Migration] evaluation_result字段添加成功");
        } else {
          console.log("[DB Migration] task_test表的evaluation_result字段已存在，跳过迁移");
        }
        
        console.log("[DB Migration] 数据库迁移完成");
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("[DB Migration] 数据库迁移失败:", error);
      throw error;
    } finally {
      await pool.end();
    }
  }

  /**
   * 从连接字符串中提取数据库名称
   * @param connectionString 数据库连接字符串
   * @returns 数据库名称
   */
  static extractDatabaseName(connectionString: string): string {
    try {
      const url = new URL(connectionString);
      return url.pathname.slice(1); // 移除开头的 '/'
    } catch (error) {
      throw new Error(`无效的数据库连接字符串: ${connectionString}`);
    }
  }
}
