#!/usr/bin/env node

import { DatabaseInitializer } from '../apps/agents/src/app/utils/DatabaseInitializer.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 数据库初始化脚本
 * 用于在项目clone后初始化数据库
 */
async function initializeDatabase() {
  console.log('🚀 开始数据库初始化...');
  
  try {
    // 加载环境变量
    const envPath = path.resolve(__dirname, '../.env');
    console.log(`📁 加载环境变量文件: ${envPath}`);
    dotenv.config({ path: envPath });
    
    // 检查DATABASE_URL是否存在
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.error('❌ 错误: 未找到DATABASE_URL环境变量');
      console.log('💡 请确保在根目录创建.env文件并设置DATABASE_URL');
      console.log('💡 示例: DATABASE_URL=postgresql://username:password@localhost:5432/database_name');
      process.exit(1);
    }
    
    // 隐藏密码信息用于日志显示
    const sanitizedUrl = databaseUrl.replace(/:([^:@]+)@/, ':***@');
    console.log(`🔗 使用数据库连接: ${sanitizedUrl}`);
    
    // 步骤1: 确保数据库存在
    console.log('\n📋 步骤1: 检查并创建数据库...');
    await DatabaseInitializer.ensureDatabaseExists(databaseUrl);
    console.log('✅ 数据库检查完成');
    
    // 步骤2: 执行数据库迁移
    console.log('\n📋 步骤2: 执行数据库迁移...');
    await DatabaseInitializer.migrateDatabase(databaseUrl);
    console.log('✅ 数据库迁移完成');
    
    console.log('\n🎉 数据库初始化成功完成!');
    console.log('💡 现在可以运行 npm run dev 启动应用');
    
  } catch (error) {
    console.error('\n❌ 数据库初始化失败:');
    
    if (error instanceof Error) {
      console.error(`错误信息: ${error.message}`);
      
      // 提供常见错误的解决建议
      if (error.message.includes('ECONNREFUSED')) {
        console.log('\n💡 解决建议:');
        console.log('  1. 确保PostgreSQL服务正在运行');
        console.log('  2. 检查数据库连接信息是否正确');
        console.log('  3. 确认防火墙没有阻止数据库连接');
      } else if (error.message.includes('authentication failed')) {
        console.log('\n💡 解决建议:');
        console.log('  1. 检查数据库用户名和密码是否正确');
        console.log('  2. 确认用户具有创建数据库的权限');
      } else if (error.message.includes('database') && error.message.includes('does not exist')) {
        console.log('\n💡 解决建议:');
        console.log('  1. 确保PostgreSQL服务正在运行');
        console.log('  2. 检查连接字符串中的主机和端口是否正确');
      }
    } else {
      console.error('未知错误:', error);
    }
    
    console.log('\n📚 更多帮助信息请查看README.md文件');
    process.exit(1);
  }
}

// 运行初始化
initializeDatabase();