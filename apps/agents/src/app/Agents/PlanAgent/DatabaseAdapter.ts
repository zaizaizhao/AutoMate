import * as fs from 'fs';
import * as path from 'path';

/**
 * 数据库类型枚举
 */
export enum DatabaseType {
  MYSQL = 'mysql',
  POSTGRESQL = 'postgresql',
  SQLITE = 'sqlite'
}

/**
 * 数据库适配器接口
 */
export interface IDatabaseAdapter {
  getTableListQuery(): string;
  getColumnInfoQuery(): string;
  getSampleDataQuery(tableName: string, limit?: number): string;
  getSampleDataQueryWithOrder(tableName: string, limit?: number, orderByColumn?: string, orderDirection?: 'ASC' | 'DESC'): string;
  getForeignKeyQuery(): string;
  getConstraintsQuery(): string;
  getDatabaseOverviewQuery(): string;
  escapeIdentifier(identifier: string): string;
  getOrderByClause(tableName: string, columnName?: string): string;
  getSimpleTableListQuery(): string;
}

/**
 * MySQL数据库适配器
 */
class MySQLAdapter implements IDatabaseAdapter {
  getTableListQuery(): string {
    return "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE();";
  }

  getColumnInfoQuery(): string {
    return "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position;";
  }

  // 获取示例数据查询
  getSampleDataQuery(tableName: string, limit: number = 5): string {
    return `SELECT * FROM ${this.escapeIdentifier(tableName)} LIMIT ${limit};`;
  }

  // 获取带排序的示例数据查询
  getSampleDataQueryWithOrder(tableName: string, limit: number = 5, orderByColumn?: string, orderDirection: 'ASC' | 'DESC' = 'DESC'): string {
    const baseQuery = `SELECT * FROM ${this.escapeIdentifier(tableName)}`;
    if (orderByColumn) {
      return `${baseQuery} ORDER BY ${this.escapeIdentifier(orderByColumn)} ${orderDirection} LIMIT ${limit};`;
    }
    return `${baseQuery} LIMIT ${limit};`;
  }

  getForeignKeyQuery(): string {
    return `SELECT 
      column_name, 
      referenced_table_name, 
      referenced_column_name 
    FROM information_schema.key_column_usage 
    WHERE table_schema = DATABASE() 
      AND referenced_table_name IS NOT NULL;`;
  }

  getConstraintsQuery(): string {
    return `SELECT 
      tc.constraint_name, 
      tc.table_name, 
      tc.constraint_type, 
      kcu.column_name 
    FROM information_schema.table_constraints tc 
    JOIN information_schema.key_column_usage kcu 
    ON tc.constraint_name = kcu.constraint_name 
    WHERE tc.table_schema = DATABASE();`;
  }

  getDatabaseOverviewQuery(): string {
    return "SELECT COUNT(*) as table_count FROM information_schema.tables WHERE table_schema = DATABASE();";
  }

  escapeIdentifier(identifier: string): string {
    return `\`${identifier}\``;
  }

  getOrderByClause(_tableName: string, columnName?: string): string {
    if (columnName) {
      return `ORDER BY ${this.escapeIdentifier(columnName)} DESC`;
    }
    return "ORDER BY id DESC";
  }

  getSimpleTableListQuery(): string {
    return "SHOW TABLES;";
  }
}

/**
 * PostgreSQL数据库适配器
 */
class PostgreSQLAdapter implements IDatabaseAdapter {
  getTableListQuery(): string {
    return "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';";
  }

  getColumnInfoQuery(): string {
    return "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position;";
  }

  getSampleDataQuery(tableName: string, limit: number = 5): string {
    return `SELECT * FROM ${this.escapeIdentifier(tableName)} LIMIT ${limit};`;
  }

  getSampleDataQueryWithOrder(tableName: string, limit: number = 5, orderByColumn?: string, orderDirection: 'ASC' | 'DESC' = 'DESC'): string {
    const baseQuery = `SELECT * FROM ${this.escapeIdentifier(tableName)}`;
    if (orderByColumn) {
      return `${baseQuery} ORDER BY ${this.escapeIdentifier(orderByColumn)} ${orderDirection} LIMIT ${limit};`;
    }
    return `${baseQuery} LIMIT ${limit};`;
  }

  getForeignKeyQuery(): string {
    return `SELECT 
      column_name, 
      referenced_table_name, 
      referenced_column_name 
    FROM information_schema.key_column_usage 
    WHERE table_schema = 'public' 
      AND referenced_table_name IS NOT NULL;`;
  }

  getConstraintsQuery(): string {
    return `SELECT 
      tc.constraint_name, 
      tc.table_name, 
      tc.constraint_type, 
      kcu.column_name 
    FROM information_schema.table_constraints tc 
    JOIN information_schema.key_column_usage kcu 
    ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_schema = 'public';`;
  }

  getDatabaseOverviewQuery(): string {
    return "SELECT COUNT(*) as table_count FROM information_schema.tables WHERE table_schema = 'public';";
  }

  escapeIdentifier(identifier: string): string {
    return `"${identifier}"`;
  }

  getOrderByClause(_tableName: string, columnName?: string): string {
    if (columnName) {
      return `ORDER BY ${this.escapeIdentifier(columnName)} DESC`;
    }
    return "ORDER BY id DESC";
  }

  getSimpleTableListQuery(): string {
    return "SELECT tablename FROM pg_tables WHERE schemaname = 'public';";
  }
}

/**
 * SQLite数据库适配器
 */
class SQLiteAdapter implements IDatabaseAdapter {
  getTableListQuery(): string {
    return "SELECT name as table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';";
  }

  getColumnInfoQuery(): string {
    return "SELECT m.name as table_name, p.name as column_name, p.type as data_type, CASE WHEN p.\"notnull\" = 0 THEN 'YES' ELSE 'NO' END as is_nullable FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid;";
  }

  getSampleDataQuery(tableName: string, limit: number = 5): string {
    return `SELECT * FROM ${this.escapeIdentifier(tableName)} LIMIT ${limit};`;
  }

  getSampleDataQueryWithOrder(tableName: string, limit: number = 5, orderByColumn?: string, orderDirection: 'ASC' | 'DESC' = 'DESC'): string {
    const baseQuery = `SELECT * FROM ${this.escapeIdentifier(tableName)}`;
    if (orderByColumn) {
      return `${baseQuery} ORDER BY ${this.escapeIdentifier(orderByColumn)} ${orderDirection} LIMIT ${limit};`;
    }
    return `${baseQuery} LIMIT ${limit};`;
  }

  getForeignKeyQuery(): string {
    return "SELECT m.name as table_name, f.\"from\" as column_name, f.\"table\" as referenced_table_name, f.\"to\" as referenced_column_name FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table';";
  }

  getConstraintsQuery(): string {
    return "SELECT name as constraint_name, tbl_name as table_name, 'CHECK' as constraint_type, '' as column_name FROM sqlite_master WHERE type = 'index';";
  }

  getDatabaseOverviewQuery(): string {
    return "SELECT COUNT(*) as table_count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';";
  }

  escapeIdentifier(identifier: string): string {
    return `"${identifier}"`;
  }

  getOrderByClause(_tableName: string, columnName?: string): string {
    if (columnName) {
      return `ORDER BY ${this.escapeIdentifier(columnName)} DESC`;
    }
    return "ORDER BY rowid DESC";
  }

  getSimpleTableListQuery(): string {
    return "SELECT name FROM sqlite_master WHERE type='table';";
  }
}

/**
 * 数据库适配器工厂类
 */
export class DatabaseAdapterFactory {
  private static instance: DatabaseAdapterFactory;
  private adapter: IDatabaseAdapter | null = null;
  private databaseType: DatabaseType | null = null;

  private constructor() {}

  static getInstance(): DatabaseAdapterFactory {
    if (!DatabaseAdapterFactory.instance) {
      DatabaseAdapterFactory.instance = new DatabaseAdapterFactory();
    }
    return DatabaseAdapterFactory.instance;
  }

  /**
   * 从TEST_DATABASE_URL解析数据库类型
   */
  private parseDatabaseTypeFromUrl(url: string): DatabaseType {
    if (url.startsWith('mysql://') || url.startsWith('mysql2://')) {
      return DatabaseType.MYSQL;
    } else if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
      return DatabaseType.POSTGRESQL;
    } else if (url.startsWith('sqlite://') || url.includes('.db') || url.includes('.sqlite')) {
      return DatabaseType.SQLITE;
    } else {
      // 默认使用PostgreSQL
      console.warn(`[DatabaseAdapter] Unknown database URL format: ${url}, defaulting to PostgreSQL`);
      return DatabaseType.POSTGRESQL;
    }
  }

  /**
   * 从.env文件读取TEST_DATABASE_URL并初始化适配器
   */
  private initializeFromEnv(): void {
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const lines = envContent.split('\n');
        
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('TEST_DATABASE_URL=')) {
            const url = trimmedLine.split('=')[1].replace(/"/g, '').trim();
            this.databaseType = this.parseDatabaseTypeFromUrl(url);
            console.log(`[DatabaseAdapter] Detected database type: ${this.databaseType} from URL: ${url}`);
            break;
          }
        }
      }
    } catch (error) {
      console.error('[DatabaseAdapter] Error reading .env file:', error);
    }

    // 如果无法从.env读取，默认使用PostgreSQL
    if (!this.databaseType) {
      console.warn('[DatabaseAdapter] Could not determine database type from .env, defaulting to PostgreSQL');
      this.databaseType = DatabaseType.POSTGRESQL;
    }

    // 创建对应的适配器
    switch (this.databaseType) {
      case DatabaseType.MYSQL:
        this.adapter = new MySQLAdapter();
        break;
      case DatabaseType.POSTGRESQL:
        this.adapter = new PostgreSQLAdapter();
        break;
      case DatabaseType.SQLITE:
        this.adapter = new SQLiteAdapter();
        break;
      default:
        this.adapter = new PostgreSQLAdapter();
    }
  }

  /**
   * 获取数据库适配器实例
   */
  getAdapter(): IDatabaseAdapter {
    if (!this.adapter) {
      this.initializeFromEnv();
    }
    return this.adapter!;
  }

  /**
   * 获取当前数据库类型
   */
  getDatabaseType(): DatabaseType {
    if (!this.databaseType) {
      this.initializeFromEnv();
    }
    return this.databaseType!;
  }

  /**
   * 重置适配器（用于测试或重新配置）
   */
  reset(): void {
    this.adapter = null;
    this.databaseType = null;
  }
}

/**
 * 导出便捷函数
 */
export function getDatabaseAdapter(): IDatabaseAdapter {
  return DatabaseAdapterFactory.getInstance().getAdapter();
}

export function getDatabaseType(): DatabaseType {
  return DatabaseAdapterFactory.getInstance().getDatabaseType();
}