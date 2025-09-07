// memory/PostgreSQLStore.ts
import { Pool } from 'pg';
import { BaseStore } from '@langchain/langgraph';
import type { Operation, OperationResults, SearchItem } from '@langchain/langgraph-checkpoint';

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
      return typeof v === 'string' ? JSON.parse(v) : v;
    } finally {
      client.release();
    }
  }

  async put(namespace: string[], key: string, value: any): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO memory_store (namespace_path, key, value, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (namespace_path, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [namespace, key, JSON.stringify(value)]
      );
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
        yield [row.key, (typeof v === 'string' ? JSON.parse(v) : v)];
      }
    } finally {
      client.release();
    }
  }

  // 实现 batch 方法
  async batch<Op extends Operation[]>(_operations: Op): Promise<OperationResults<Op>> {
    // 暂时抛出未实现错误，等待后续完善
    throw new Error('Batch operations not yet implemented for PostgreSQLStore');
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
      orderBy?: 'updated_at' | 'key';
      orderDirection?: 'ASC' | 'DESC';
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
    
    const orderBy = options?.orderBy || 'updated_at';
    const orderDirection = options?.orderDirection || 'DESC';
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
      
      return result.rows.map(row => ({
        namespace,
        key: row.key,
        value: typeof row.value === 'string' ? JSON.parse(row.value) : row.value,
        createdAt: row.created_at ? new Date(row.created_at) : new Date(),
        updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
        score: 1.0 // 默认评分
      }));
    } finally {
      client.release();
    }
  }

  // 批量操作方法
  async putMany(
    namespace: string[],
    items: Array<{ key: string; value: any; dataType?: string; tags?: Record<string, any> }>
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
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
            JSON.stringify(item.tags || {})
          ]
        );
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}