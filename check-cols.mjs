import { sql } from 'drizzle-orm';
import { getDb } from './server/_core/db.ts';

async function main() {
  const db = await getDb();
  const cols = await db.execute(sql`DESCRIBE system_settings`);
  console.log(JSON.stringify(cols[0], null, 2));
  process.exit(0);
}
main();
