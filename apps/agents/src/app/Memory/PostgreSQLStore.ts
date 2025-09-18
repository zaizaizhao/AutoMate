// memory/PostgreSQLStore.ts
import { Pool } from "pg";
import { BaseStore } from "@langchain/langgraph";
import type {
  Operation,
  OperationResults,
  SearchItem,
} from "@langchain/langgraph-checkpoint";

export class PostgreSQLStore extends BaseStore {
  private pool: Pool;

  constructor(pool: Pool) {
    super();
    this.pool = pool;
  }

  async get(namespace: string[], key: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT value FROM memory_store 
         WHERE namespace_path = $1 AND key = $2
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [namespace, key]
      );

      if (result.rows.length === 0) {
        return undefined;
      }

      const v = result.rows[0].value;
      return typeof v === "string" ? JSON.parse(v) : v;
    } finally {
      client.release();
    }
  }

  async put(namespace: string[], key: string, value: any): Promise<void> {
    console.log("\n=== [PostgreSQLStore] PUT METHOD CALLED ===");
    console.log("[PostgreSQLStore] put method called with:", {
      namespace,
      key,
      value,
    });
    console.log("[PostgreSQLStore] Stack trace:", new Error().stack);
    const client = await this.pool.connect();
    try {
      console.log("[PostgreSQLStore] About to execute INSERT query");
      const result = await client.query(
        `INSERT INTO memory_store (namespace_path, key, value, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (namespace_path, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [namespace, key, JSON.stringify(value)]
      );
      console.log("[PostgreSQLStore] INSERT query result:", result.rowCount);
      console.log("=== [PostgreSQLStore] PUT METHOD COMPLETED ===");
    } catch (error) {
      console.error("[PostgreSQLStore] INSERT query failed:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(namespace: string[], key: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `DELETE FROM memory_store WHERE namespace_path = $1 AND key = $2`,
        [namespace, key]
      );
    } finally {
      client.release();
    }
  }

  async *list(namespace: string[]): AsyncGenerator<[string, any]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT key, value FROM memory_store 
         WHERE namespace_path = $1
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY updated_at DESC`,
        [namespace]
      );

      for (const row of result.rows) {
        const v = row.value;
        yield [row.key, typeof v === "string" ? JSON.parse(v) : v];
      }
    } finally {
      client.release();
    }
  }

  // 实现 batch 方法
  async batch<Op extends Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>> {
    console.log("\n=== [PostgreSQLStore] BATCH METHOD CALLED ===");
    console.log("[PostgreSQLStore] batch method called with operations:", operations.length);
    console.log("[PostgreSQLStore] Stack trace:", new Error().stack);
    const client = await this.pool.connect();
    const results: any[] = [];

    try {
      await client.query("BEGIN");

      for (const operation of operations) {
        if ("key" in operation && "namespace" in operation) {
          // GetOperation
          if ("value" in operation) {
            // PutOperation
            if (operation.value === null) {
              // Delete operation
              await client.query(
                `DELETE FROM memory_store WHERE namespace_path = $1 AND key = $2`,
                [operation.namespace, operation.key]
              );
              results.push(undefined);
            } else {
              // Put operation
              await client.query(
                `INSERT INTO memory_store (namespace_path, key, value, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (namespace_path, key)
                 DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [
                  operation.namespace,
                  operation.key,
                  JSON.stringify(operation.value),
                ]
              );
              results.push(undefined);
            }
          } else {
            // GetOperation
            const getResult = await client.query(
              `SELECT value FROM memory_store 
               WHERE namespace_path = $1 AND key = $2
                 AND (expires_at IS NULL OR expires_at > NOW())`,
              [operation.namespace, operation.key]
            );
            const val =
              getResult.rows.length > 0 ? getResult.rows[0].value : null;
            results.push(
              val ? (typeof val === "string" ? JSON.parse(val) : val) : null
            );
          }
        } else if ("namespacePrefix" in operation) {
          // SearchOperation
          const searchResults = await this.search(operation.namespacePrefix, {
            limit: operation.limit,
            offset: operation.offset,
          });
          results.push(searchResults);
        } else if ("matchConditions" in operation) {
          // ListNamespacesOperation
          const namespaces = await this.listNamespaces({
            limit: operation.limit,
            offset: operation.offset,
            maxDepth: operation.maxDepth,
          });
          results.push(namespaces);
        } else {
          throw new Error(
            `Unsupported operation type: ${JSON.stringify(operation)}`
          );
        }
      }

      await client.query("COMMIT");
      return results as OperationResults<Op>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // 新增复杂查询方法
  async search(
    namespace: string[],
    options?: {
      keyPattern?: string;
      dataType?: string;
      tags?: Record<string, any>;
      limit?: number;
      offset?: number;
      orderBy?: "updated_at" | "key";
      orderDirection?: "ASC" | "DESC";
    }
  ): Promise<SearchItem[]> {
    let query = `
      SELECT key, value, metadata, updated_at, created_at
      FROM memory_store
      WHERE namespace_path = $1
        AND (expires_at IS NULL OR expires_at > NOW())
    `;

    const params: any[] = [namespace];
    let paramIndex = 2;

    if (options?.keyPattern) {
      query += ` AND key LIKE $${paramIndex}`;
      params.push(options.keyPattern);
      paramIndex++;
    }

    if (options?.dataType) {
      query += ` AND data_type = $${paramIndex}`;
      params.push(options.dataType);
      paramIndex++;
    }

    if (options?.tags) {
      query += ` AND tags @> $${paramIndex}`;
      params.push(JSON.stringify(options.tags));
      paramIndex++;
    }

    const orderBy = options?.orderBy || "updated_at";
    const orderDirection = options?.orderDirection || "DESC";
    query += ` ORDER BY ${orderBy} ${orderDirection}`;

    if (options?.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(options.limit);
      paramIndex++;
    }

    if (options?.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(options.offset);
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query(query, params);

      return result.rows.map((row) => ({
        namespace,
        key: row.key,
        value:
          typeof row.value === "string" ? JSON.parse(row.value) : row.value,
        createdAt: row.created_at ? new Date(row.created_at) : new Date(),
        updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
        score: 1.0, // 默认评分
      }));
    } finally {
      client.release();
    }
  }

  // 批量操作方法
  async putMany(
    namespace: string[],
    items: Array<{
      key: string;
      value: any;
      dataType?: string;
      tags?: Record<string, any>;
    }>
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const item of items) {
        await client.query(
          `INSERT INTO memory_store (namespace_path, key, value, data_type, tags, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (namespace_path, key)
           DO UPDATE SET 
             value = EXCLUDED.value,
             data_type = EXCLUDED.data_type,
             tags = EXCLUDED.tags,
             updated_at = NOW()`,
          [
            namespace,
            item.key,
            JSON.stringify(item.value),
            item.dataType,
            JSON.stringify(item.tags || {}),
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

  // 实现BaseStore要求的方法
  async listNamespaces(options?: {
    limit?: number;
    offset?: number;
    maxDepth?: number;
  }): Promise<string[][]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT DISTINCT namespace_path FROM memory_store
         ORDER BY namespace_path
         ${options?.limit ? `LIMIT ${options.limit}` : ''}
         ${options?.offset ? `OFFSET ${options.offset}` : ''}`,
        []
      );
      return result.rows.map(row => row.namespace_path);
    } finally {
      client.release();
    }
  }

  async start(): Promise<void> {
    console.log("[PostgreSQLStore] start() called");
    // PostgreSQL连接池已经在构造函数中初始化，这里不需要额外操作
  }

  async stop(): Promise<void> {
    console.log("[PostgreSQLStore] stop() called");
    // 关闭连接池
    await this.pool.end();
  }
}
