import { sql } from 'drizzle-orm';
import { getDb } from './server/_core/db.ts';

async function check() {
  const db = await getDb();
  
  // Check if table exists
  const tables = await db.execute(sql`SHOW TABLES LIKE 'system_settings'`);
  console.log('Tables matching:', JSON.stringify(tables[0]));
  
  // Check data
  try {
    const rows = await db.execute(sql`SELECT * FROM system_settings`);
    console.log('All rows:', JSON.stringify(rows[0]));
  } catch(e) {
    console.log('Error reading system_settings:', e.message);
  }

  // Try to insert a test value
  try {
    await db.execute(sql`INSERT INTO system_settings (settingKey, settingValue, updatedBy) VALUES ('test_key', 'test_val', 'diag') ON DUPLICATE KEY UPDATE settingValue = 'test_val', updatedBy = 'diag'`);
    console.log('Insert succeeded');
    const rows2 = await db.execute(sql`SELECT * FROM system_settings WHERE settingKey = 'test_key'`);
    console.log('After insert:', JSON.stringify(rows2[0]));
    // Clean up
    await db.execute(sql`DELETE FROM system_settings WHERE settingKey = 'test_key'`);
  } catch(e) {
    console.log('Insert error:', e.message);
  }

  process.exit(0);
}
check();
