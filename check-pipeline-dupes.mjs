import { getDb } from './server/db.ts';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const [rows] = await db.execute(sql`
    SELECT *
    FROM webhook_logs
    WHERE action LIKE '%pipeline%'
    ORDER BY receivedAt DESC
    LIMIT 30
  `);

  for (const row of rows) {
    console.log(JSON.stringify({
      id: row.id,
      action: row.action,
      contactId: String(row.contactId || '').substring(0, 12),
      payloadSummary: row.payloadSummary,
      receivedAt: row.receivedAt,
    }));
  }
  process.exit(0);
}
main().catch(console.error);
