import { getDb } from './server/db.ts';
import { leads } from './drizzle/schema.ts';
import { and, eq, lte, isNull, or, sql } from 'drizzle-orm';

const db = await getDb();
if (!db) { console.log('no db'); process.exit(0); }

const now = new Date();

// Count leads due for follow-up right now
const [dueRows] = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM leads 
  WHERE humanTakeover = 0 
  AND (nextFollowUpAt IS NULL OR nextFollowUpAt <= NOW())
`);
console.log('Leads due for follow-up RIGHT NOW:', dueRows[0].cnt);

// Count leads scheduled for future
const [futureRows] = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM leads 
  WHERE humanTakeover = 0 AND nextFollowUpAt > NOW()
`);
console.log('Leads scheduled for FUTURE follow-up:', futureRows[0].cnt);

// Count leads with humanTakeover=1
const [takenRows] = await db.execute(sql`SELECT COUNT(*) as cnt FROM leads WHERE humanTakeover = 1`);
console.log('Leads with humanTakeover=1 (AI paused):', takenRows[0].cnt);

// Count total leads
const [totalRows] = await db.execute(sql`SELECT COUNT(*) as cnt FROM leads`);
console.log('Total leads in DB:', totalRows[0].cnt);

// Check what the follow-up trigger query actually returns
const [overdueRows] = await db.execute(sql`
  SELECT id, name, nextFollowUpAt, pipelineStage, humanTakeover, lastMessageAt, opportunityStatus
  FROM leads 
  WHERE nextFollowUpAt <= NOW() AND humanTakeover = 0
  LIMIT 10
`);
console.log('\nSample OVERDUE leads (what trigger should process):');
console.log(JSON.stringify(overdueRows, null, 2));

// Check how many leads have NEVER been contacted (no conversations)
const [neverRows] = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM leads l
  WHERE l.humanTakeover = 0
  AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = l.id AND c.direction = 'outbound')
`);
console.log('\nLeads NEVER contacted (no outbound messages):', neverRows[0].cnt);

// Check what pipelineStage distribution looks like
const [stageRows] = await db.execute(sql`
  SELECT pipelineStage, COUNT(*) as cnt FROM leads GROUP BY pipelineStage ORDER BY cnt DESC
`);
console.log('\nPipeline stage distribution:');
for (const row of stageRows) {
  console.log(`  ${row.pipelineStage || 'NULL'}: ${row.cnt}`);
}

process.exit(0);
