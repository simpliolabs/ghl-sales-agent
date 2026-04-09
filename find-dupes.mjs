import { getDb } from './server/db.ts';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Find contacts with multiple pipeline events within 5 minutes of each other
  const [rows] = await db.execute(sql`
    SELECT contactId, action, COUNT(*) as cnt, 
           MIN(receivedAt) as first_at, MAX(receivedAt) as last_at,
           GROUP_CONCAT(id ORDER BY receivedAt) as log_ids
    FROM webhook_logs
    WHERE action LIKE '%pipeline%'
    GROUP BY contactId, action
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 20
  `);

  console.log("=== Contacts with multiple pipeline events ===");
  for (const row of rows) {
    console.log(`Contact: ${String(row.contactId).substring(0,12)}... | Action: ${row.action} | Count: ${row.cnt} | First: ${row.first_at} | Last: ${row.last_at} | IDs: ${row.log_ids}`);
  }

  // Also check: are there cases where the same contact has both pipeline_handler AND fallback_pipeline?
  const [crossRoutes] = await db.execute(sql`
    SELECT contactId, GROUP_CONCAT(DISTINCT action) as actions, COUNT(*) as total
    FROM webhook_logs
    WHERE action IN ('pipeline_handler', 'fallback_pipeline', 'pipeline_dedup_blocked')
    GROUP BY contactId
    HAVING COUNT(DISTINCT action) > 1
    ORDER BY total DESC
    LIMIT 10
  `);

  console.log("\n=== Contacts hitting multiple pipeline routes ===");
  for (const row of crossRoutes) {
    console.log(`Contact: ${String(row.contactId).substring(0,12)}... | Actions: ${row.actions} | Total: ${row.total}`);
  }

  // Check how many dedup blocks we've had
  const [dedupCount] = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM webhook_logs WHERE action = 'pipeline_dedup_blocked'
  `);
  console.log(`\nTotal pipeline_dedup_blocked events: ${dedupCount[0]?.cnt || 0}`);

  process.exit(0);
}
main().catch(console.error);
