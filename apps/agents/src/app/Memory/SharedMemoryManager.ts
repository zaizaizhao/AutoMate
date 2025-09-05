// memory/SharedMemoryManager.ts
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { BaseStore } from '@langchain/langgraph';
import { PostgreSQLStore } from './PostgreSQLStore.js';

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
      // 创建所有自定义表
      await client.query(`
        -- Memory Store 表创建语句（如上所示）
        -- Agent Sessions 表创建语句（如上所示）
        -- Memory Access Log 表创建语句（如上所示）
      `);
    } finally {
      client.release();
    }
  }

  // 获取命名空间路径
  private getNamespacePath(namespace: MemoryNamespace): string[] {
    const path = [namespace.project, namespace.environment, namespace.agent_type];
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
          JSON.stringify(options?.metadata || {})
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
      return {
        key: row.key,
        value: JSON.parse(row.value),
        metadata: JSON.parse(row.metadata || '{}'),
        expiresAt: row.expires_at ? new Date(row.expires_at) : undefined
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
      
      return result.rows.map(row => ({
        key: row.key,
        value: JSON.parse(row.value),
        metadata: JSON.parse(row.metadata || '{}'),
        expiresAt: row.expires_at ? new Date(row.expires_at) : undefined
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
}