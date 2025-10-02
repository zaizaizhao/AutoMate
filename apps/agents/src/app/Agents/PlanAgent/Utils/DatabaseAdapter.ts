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
 * 支持MySQL 5.7+ 和 MySQL 8.0+ 的语法特性
 */
class MySQLAdapter implements IDatabaseAdapter {
  getTableListQuery(): string {
    // 使用DATABASE()函数获取当前数据库名，兼容性更好
    return "SELECT TABLE_NAME as table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE';";
  }

  getColumnInfoQuery(): string {
    // 增加更多列信息，提高兼容性
    return `SELECT 
      TABLE_NAME as table_name, 
      COLUMN_NAME as column_name, 
      DATA_TYPE as data_type, 
      IS_NULLABLE as is_nullable,
      COLUMN_DEFAULT as column_default,
      CHARACTER_MAXIMUM_LENGTH as character_maximum_length,
      NUMERIC_PRECISION as numeric_precision,
      NUMERIC_SCALE as numeric_scale,
      COLUMN_KEY as column_key,
      EXTRA as extra
    FROM information_schema.columns 
    WHERE table_schema = DATABASE() 
    ORDER BY table_name, ordinal_position;`;
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
    // 增强的外键查询，包含更多信息
    return `SELECT 
      kcu.COLUMN_NAME as column_name, 
      kcu.REFERENCED_TABLE_NAME as referenced_table_name, 
      kcu.REFERENCED_COLUMN_NAME as referenced_column_name,
      kcu.TABLE_NAME as table_name,
      kcu.CONSTRAINT_NAME as constraint_name,
      rc.UPDATE_RULE as update_rule,
      rc.DELETE_RULE as delete_rule
    FROM information_schema.key_column_usage kcu
    LEFT JOIN information_schema.referential_constraints rc 
      ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME 
      AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
    WHERE kcu.table_schema = DATABASE() 
      AND kcu.referenced_table_name IS NOT NULL
    ORDER BY kcu.table_name, kcu.column_name;`;
  }

  getConstraintsQuery(): string {
    // 增强的约束查询，支持更多约束类型
    return `SELECT 
      tc.CONSTRAINT_NAME as constraint_name, 
      tc.TABLE_NAME as table_name, 
      tc.CONSTRAINT_TYPE as constraint_type, 
      kcu.COLUMN_NAME as column_name,
      cc.CHECK_CLAUSE as check_clause
    FROM information_schema.table_constraints tc 
    LEFT JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name 
      AND tc.table_schema = kcu.table_schema
    LEFT JOIN information_schema.check_constraints cc
      ON tc.constraint_name = cc.constraint_name
      AND tc.table_schema = cc.constraint_schema
    WHERE tc.table_schema = DATABASE()
    ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name;`;
  }

  getDatabaseOverviewQuery(): string {
    // 增强的数据库概览查询
    return `SELECT 
      COUNT(*) as table_count,
      SUM(CASE WHEN table_type = 'BASE TABLE' THEN 1 ELSE 0 END) as base_table_count,
      SUM(CASE WHEN table_type = 'VIEW' THEN 1 ELSE 0 END) as view_count
    FROM information_schema.tables 
    WHERE table_schema = DATABASE();`;
  }

  escapeIdentifier(identifier: string): string {
    // MySQL使用反引号转义标识符
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  getOrderByClause(_tableName: string, columnName?: string): string {
    if (columnName) {
      return `ORDER BY ${this.escapeIdentifier(columnName)} DESC`;
    }
    // MySQL常用的自增主键名
    return "ORDER BY id DESC";
  }

  getSimpleTableListQuery(): string {
    // 使用SHOW TABLES，这是MySQL特有的简单查询
    return "SHOW TABLES;";
  }
}

/**
 * PostgreSQL数据库适配器
 * 支持PostgreSQL 9.6+ 的语法特性
 */
class PostgreSQLAdapter implements IDatabaseAdapter {
  getTableListQuery(): string {
    // 使用current_schema()函数获取当前schema，兼容性更好
    return "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE';";
  }

  getColumnInfoQuery(): string {
    // 增加更多列信息，提高兼容性
    return `SELECT 
      table_name, 
      column_name, 
      data_type, 
      is_nullable,
      column_default,
      character_maximum_length,
      numeric_precision,
      numeric_scale,
      udt_name,
      ordinal_position
    FROM information_schema.columns 
    WHERE table_schema = current_schema() 
    ORDER BY table_name, ordinal_position;`;
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
    // 增强的外键查询，包含更多信息
    return `SELECT 
      kcu.column_name, 
      kcu.table_name,
      ccu.table_name AS referenced_table_name, 
      ccu.column_name AS referenced_column_name,
      tc.constraint_name,
      rc.update_rule,
      rc.delete_rule
    FROM information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu 
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu 
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    LEFT JOIN information_schema.referential_constraints AS rc
      ON tc.constraint_name = rc.constraint_name
      AND tc.table_schema = rc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' 
      AND tc.table_schema = current_schema()
    ORDER BY kcu.table_name, kcu.column_name;`;
  }

  getConstraintsQuery(): string {
    // 增强的约束查询，支持更多约束类型
    return `SELECT 
      tc.constraint_name, 
      tc.table_name, 
      tc.constraint_type, 
      kcu.column_name,
      cc.check_clause
    FROM information_schema.table_constraints tc 
    LEFT JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name 
      AND tc.table_schema = kcu.table_schema
    LEFT JOIN information_schema.check_constraints cc
      ON tc.constraint_name = cc.constraint_name
      AND tc.constraint_schema = cc.constraint_schema
    WHERE tc.table_schema = current_schema()
    ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name;`;
  }

  getDatabaseOverviewQuery(): string {
    // 增强的数据库概览查询
    return `SELECT 
      COUNT(*) as table_count,
      SUM(CASE WHEN table_type = 'BASE TABLE' THEN 1 ELSE 0 END) as base_table_count,
      SUM(CASE WHEN table_type = 'VIEW' THEN 1 ELSE 0 END) as view_count
    FROM information_schema.tables 
    WHERE table_schema = current_schema();`;
  }

  escapeIdentifier(identifier: string): string {
    // PostgreSQL使用双引号转义标识符
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  getOrderByClause(_tableName: string, columnName?: string): string {
    if (columnName) {
      return `ORDER BY ${this.escapeIdentifier(columnName)} DESC`;
    }
    // PostgreSQL常用的自增主键名
    return "ORDER BY id DESC";
  }

  getSimpleTableListQuery(): string {
    // PostgreSQL特有的简单查询
    return "SELECT tablename as table_name FROM pg_tables WHERE schemaname = current_schema();";
  }
}

/**
 * SQLite数据库适配器
 * 支持SQLite 3.8+ 的语法特性
 */
class SQLiteAdapter implements IDatabaseAdapter {
  getTableListQuery(): string {
    // SQLite使用sqlite_master表查询表信息
    return "SELECT name as table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';";
  }

  getColumnInfoQuery(): string {
    // SQLite需要使用PRAGMA命令获取列信息，这里提供一个通用查询
    return `SELECT 
      m.name as table_name,
      p.name as column_name,
      p.type as data_type,
      CASE WHEN p."notnull" = 0 THEN 'YES' ELSE 'NO' END as is_nullable,
      p.dflt_value as column_default,
      p.pk as is_primary_key,
      p.cid as ordinal_position
    FROM sqlite_master m
    JOIN pragma_table_info(m.name) p
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
    ORDER BY m.name, p.cid;`;
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
    // SQLite的外键查询需要使用PRAGMA命令
    return `SELECT 
      m.name as table_name,
      f."from" as column_name,
      f."table" as referenced_table_name,
      f."to" as referenced_column_name,
      f.on_update as update_rule,
      f.on_delete as delete_rule
    FROM sqlite_master m
    JOIN pragma_foreign_key_list(m.name) f
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
    ORDER BY m.name, f.id;`;
  }

  getConstraintsQuery(): string {
    // SQLite的约束查询，主要通过CREATE语句解析
    return `SELECT 
      name as table_name,
      'TABLE' as constraint_type,
      sql as constraint_definition
    FROM sqlite_master 
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    UNION ALL
    SELECT 
      tbl_name as table_name,
      'INDEX' as constraint_type,
      sql as constraint_definition
    FROM sqlite_master 
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY table_name;`;
  }

  getDatabaseOverviewQuery(): string {
    // SQLite的数据库概览查询
    return `SELECT 
      COUNT(*) as table_count,
      SUM(CASE WHEN type = 'table' THEN 1 ELSE 0 END) as base_table_count,
      SUM(CASE WHEN type = 'view' THEN 1 ELSE 0 END) as view_count,
      SUM(CASE WHEN type = 'index' THEN 1 ELSE 0 END) as index_count
    FROM sqlite_master 
    WHERE name NOT LIKE 'sqlite_%';`;
  }

  escapeIdentifier(identifier: string): string {
    // SQLite使用方括号或双引号转义标识符，这里使用双引号
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  getOrderByClause(_tableName: string, columnName?: string): string {
    if (columnName) {
      return `ORDER BY ${this.escapeIdentifier(columnName)} DESC`;
    }
    // SQLite常用的自增主键名
    return "ORDER BY rowid DESC";
  }

  getSimpleTableListQuery(): string {
    // SQLite特有的简单查询
    return "SELECT name as table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';";
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
   * 支持多种数据库连接字符串格式
   */
  private parseDatabaseTypeFromUrl(url: string): DatabaseType {
    const urlLower = url.toLowerCase();
    
    // MySQL 检测
    if (urlLower.startsWith('mysql://') || 
        urlLower.startsWith('mysql2://') ||
        urlLower.includes('mysql') ||
        urlLower.includes(':3306')) {
      return DatabaseType.MYSQL;
    }
    
    // PostgreSQL 检测
    if (urlLower.startsWith('postgresql://') || 
        urlLower.startsWith('postgres://') ||
        urlLower.startsWith('psql://') ||
        urlLower.includes('postgresql') ||
        urlLower.includes('postgres') ||
        urlLower.includes(':5432')) {
      return DatabaseType.POSTGRESQL;
    }
    
    // SQLite 检测
    if (urlLower.startsWith('sqlite://') || 
        urlLower.startsWith('sqlite3://') ||
        urlLower.includes('.db') || 
        urlLower.includes('.sqlite') ||
        urlLower.includes('.sqlite3') ||
        urlLower.includes('sqlite')) {
      return DatabaseType.SQLITE;
    }
    
    // 默认使用PostgreSQL
    console.warn(`[DatabaseAdapter] Unknown database URL format: ${url}, defaulting to PostgreSQL`);
    return DatabaseType.POSTGRESQL;
  }

  /**
   * 从环境变量初始化数据库适配器
   * 优先从process.env读取，其次从.env文件读取
   */
  static initializeFromEnv(): void {
    const instance = DatabaseAdapterFactory.getInstance();
    try {
      // 优先从process.env读取
      let databaseUrl = process.env.TEST_DATABASE_URL;
      
      // 如果process.env中没有，尝试从.env文件读取
      if (!databaseUrl) {
        try {
          const fs = require('fs');
          const path = require('path');
          const envPath = path.join(process.cwd(), '.env');
          
          if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf8');
            const envMatch = envContent.match(/TEST_DATABASE_URL\s*=\s*(.+)/);
            if (envMatch) {
              databaseUrl = envMatch[1].trim().replace(/^["']|["']$/g, '');
            }
          }
        } catch (error) {
          console.warn('Failed to read .env file:', error);
        }
      }

      if (databaseUrl) {
        const dbType = instance.parseDatabaseTypeFromUrl(databaseUrl);
        instance.adapter = DatabaseAdapterFactory.createAdapterInstance(dbType);
        instance.databaseType = dbType;
        console.log(`Database adapter initialized: ${dbType}`);
      } else {
        // 默认使用PostgreSQL适配器
        instance.adapter = DatabaseAdapterFactory.createAdapterInstance(DatabaseType.POSTGRESQL);
        instance.databaseType = DatabaseType.POSTGRESQL;
        console.warn('No TEST_DATABASE_URL found, using PostgreSQL adapter as default');
      }
    } catch (error) {
      console.error('Failed to initialize database adapter:', error);
      // 降级处理：使用PostgreSQL适配器
      instance.adapter = DatabaseAdapterFactory.createAdapterInstance(DatabaseType.POSTGRESQL);
      instance.databaseType = DatabaseType.POSTGRESQL;
      console.warn('Fallback to PostgreSQL adapter due to initialization error');
    }
  }

  /**
   * 创建适配器实例
   */
  private static createAdapterInstance(dbType: DatabaseType): IDatabaseAdapter {
    switch (dbType) {
      case DatabaseType.MYSQL:
        return new MySQLAdapter();
      case DatabaseType.POSTGRESQL:
        return new PostgreSQLAdapter();
      case DatabaseType.SQLITE:
        return new SQLiteAdapter();
      default:
        console.warn(`Unknown database type: ${dbType}, falling back to PostgreSQL`);
        return new PostgreSQLAdapter();
    }
  }

  /**
   * 获取数据库适配器实例
   */
  getAdapter(): IDatabaseAdapter {
    if (!this.adapter) {
      DatabaseAdapterFactory.initializeFromEnv();
    }
    return this.adapter!;
  }

  /**
   * 获取当前数据库类型
   */
  getDatabaseType(): DatabaseType {
    if (!this.databaseType) {
      DatabaseAdapterFactory.initializeFromEnv();
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