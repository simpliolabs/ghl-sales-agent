import { getDb } from './server/db.ts';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Get the detailed payloads for the top duplicate contacts
  const contacts = ['yWJ4qA8tQlpO2NZHF3kW', '4okKonkjftcSHlJlFOXH', 'gvOOneZh529O'];
  
  for (const cid of contacts) {
    const [rows] = await db.execute(sql`
      SELECT id, action, payloadSummary, receivedAt
      FROM webhook_logs
      WHERE contactId LIKE ${cid + '%'}
        AND action LIKE '%pipeline%'
      ORDER BY receivedAt ASC
    `);
    
    console.log(`\n=== Contact ${cid.substring(0, 12)} (${rows.length} events) ===`);
    for (const row of rows) {
      const p = JSON.parse(row.payloadSummary || '{}');
      const toStage = p.toStage || p.currentStage || p.stageName || p.pipleline_stage || 'UNKNOWN';
      console.log(`  [${row.receivedAt}] ${row.action} → Stage: "${toStage}" (log #${row.id})`);
    }
  }

  // Also check pipeline_events table for duplicate notes
  const [noteRows] = await db.execute(sql`
    SELECT contactId, stageName, COUNT(*) as cnt, 
           GROUP_CONCAT(receivedAt ORDER BY receivedAt) as times
    FROM pipeline_events
    GROUP BY contactId, stageName
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 10
  `);
  
  console.log("\n=== Duplicate pipeline_events (same contact + same stage) ===");
  for (const row of noteRows) {
    console.log(`Contact: ${String(row.contactId).substring(0,12)}... | Stage: ${row.stageName} | Count: ${row.cnt} | Times: ${row.times}`);
  }

  process.exit(0);
}
main().catch(console.error);
