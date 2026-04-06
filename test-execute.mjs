import { getDb } from './server/db.ts';
import { sql } from 'drizzle-orm';

const db = await getDb();
if (!db) { console.log('no db'); process.exit(0); }
const result = await db.execute(sql`SELECT 1 as test, 'hello' as name`);
console.log('type:', typeof result);
console.log('isArray:', Array.isArray(result));
console.log('keys:', Object.keys(result));
console.log('result[0]:', JSON.stringify(result[0]));
if (result.rows) console.log('result.rows[0]:', JSON.stringify(result.rows[0]));
process.exit(0);
