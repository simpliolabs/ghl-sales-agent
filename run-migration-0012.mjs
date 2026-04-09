import mysql from 'mysql2/promise';
import fs from 'fs';

async function run() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const sql = fs.readFileSync('drizzle/0012_learning_engine.sql', 'utf8');
  const statements = sql.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
  
  for (const stmt of statements) {
    console.log('Executing:', stmt.substring(0, 60) + '...');
    await conn.execute(stmt);
    console.log('OK');
  }
  await conn.end();
  console.log('Migration complete');
}

run().catch(e => { console.error(e); process.exit(1); });
