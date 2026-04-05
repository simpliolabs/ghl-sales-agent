import mysql from 'mysql2/promise';
import fs from 'fs';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

async function run() {
  const conn = await mysql.createConnection(dbUrl);
  
  const sql = fs.readFileSync('drizzle/0005_famous_molten_man.sql', 'utf8');
  
  // Split by statement breakpoint and execute each
  const statements = sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);
  
  for (const stmt of statements) {
    try {
      console.log('Executing:', stmt.substring(0, 80) + '...');
      await conn.execute(stmt);
      console.log('✓ Success');
    } catch (err) {
      if (err.code === 'ER_TABLE_EXISTS_ERROR') {
        console.log('⚠ Table already exists, skipping');
      } else {
        console.error('✗ Error:', err.message);
      }
    }
  }
  
  await conn.end();
  console.log('Done!');
}

run().catch(console.error);
