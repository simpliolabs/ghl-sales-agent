import { getDb } from './server/db.js';
import { sql } from 'drizzle-orm';

const db = await getDb();
const r = await db.execute(sql`SELECT status, COUNT(*) as cnt FROM ab_experiments GROUP BY status`);
console.log("Experiments by status:", JSON.stringify(r[0]));

const outcomes = await db.execute(sql`SELECT outcome, COUNT(*) as cnt FROM conversation_outcomes GROUP BY outcome`);
console.log("Outcomes by type:", JSON.stringify(outcomes[0]));

const learnings = await db.execute(sql`SELECT status, COUNT(*) as cnt FROM learnings GROUP BY status`);
console.log("Learnings by status:", JSON.stringify(learnings[0]));

process.exit(0);
