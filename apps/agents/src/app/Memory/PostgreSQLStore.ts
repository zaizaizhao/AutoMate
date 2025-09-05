// memory/PostgreSQLStore.ts
import { Pool } from 'pg';
import { BaseStore, Operation, OperationResults } from '@langchain/langgraph';

export class PostgreSQLStore extends BaseStore {
  batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
      throw new Error('Method not implemented.');
  }
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
      
      return JSON.parse(result.rows[0].value);
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
        yield [row.key, JSON.parse(row.value)];
      }
    } finally {
      client.release();
    }
  }
}