const { Pool } = require('pg');
require('dotenv').config();

async function checkDatabase() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:111111@localhost:5432/agents'
  });

  try {
    console.log('连接到数据库...');
    
    // 检查task_plans表
    console.log('\n=== 检查task_plans表 ===');
    const taskPlansCount = await pool.query('SELECT COUNT(*) FROM task_plans');
    console.log(`task_plans表记录数: ${taskPlansCount.rows[0].count}`);
    
    if (parseInt(taskPlansCount.rows[0].count) > 0) {
      const taskPlansData = await pool.query('SELECT * FROM task_plans LIMIT 5');
      console.log('task_plans表前5条记录:');
      console.log(taskPlansData.rows);
    } else {
      console.log('task_plans表为空');
    }
    
    // 检查task_test表
    console.log('\n=== 检查task_test表 ===');
    const taskTestCount = await pool.query('SELECT COUNT(*) FROM task_test');
    console.log(`task_test表记录数: ${taskTestCount.rows[0].count}`);
    
    if (parseInt(taskTestCount.rows[0].count) > 0) {
      const taskTestData = await pool.query('SELECT * FROM task_test LIMIT 5');
      console.log('task_test表前5条记录:');
      console.log(taskTestData.rows);
    } else {
      console.log('task_test表为空');
    }
    
    // 检查表结构
    console.log('\n=== 检查表结构 ===');
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('task_plans', 'task_test', 'plan_progress', 'memory_store')
    `);
    console.log('存在的表:', tables.rows.map(row => row.table_name));
    
  } catch (error) {
    console.error('数据库连接或查询错误:', error.message);
  } finally {
    await pool.end();
  }
}

checkDatabase();