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
