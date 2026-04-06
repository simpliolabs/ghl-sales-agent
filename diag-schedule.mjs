import { getDb } from './server/db.ts';
import { sql } from 'drizzle-orm';

const db = await getDb();
if (!db) { console.log('no db'); process.exit(0); }

// Distribution of nextFollowUpAt dates
const [distRows] = await db.execute(sql`
  SELECT 
    DATE(nextFollowUpAt) as followUpDate,
    COUNT(*) as cnt
  FROM leads 
  WHERE humanTakeover = 0 AND nextFollowUpAt IS NOT NULL
  GROUP BY DATE(nextFollowUpAt)
  ORDER BY followUpDate ASC
  LIMIT 30
`);
console.log('Follow-up schedule distribution:');
for (const row of distRows) {
  console.log(`  ${row.followUpDate}: ${row.cnt} leads`);
}

// Check the 94 never-contacted leads - when are they scheduled?
const [neverRows] = await db.execute(sql`
  SELECT l.id, l.name, l.nextFollowUpAt, l.pipelineStage, l.createdAt
  FROM leads l
  WHERE l.humanTakeover = 0
  AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = l.id AND c.direction = 'outbound')
  ORDER BY l.nextFollowUpAt ASC
  LIMIT 10
`);
console.log('\nNever-contacted leads (sample), when scheduled:');
for (const row of neverRows) {
  console.log(`  ${row.name} | stage: ${row.pipelineStage} | nextFollowUp: ${row.nextFollowUpAt} | created: ${row.createdAt}`);
}

// Check the scheduling engine - what is the minimum interval between follow-ups?
const [intervalRows] = await db.execute(sql`
  SELECT 
    MIN(nextFollowUpAt) as earliest,
    MAX(nextFollowUpAt) as latest,
    AVG(TIMESTAMPDIFF(HOUR, NOW(), nextFollowUpAt)) as avgHoursFromNow
  FROM leads
  WHERE humanTakeover = 0 AND nextFollowUpAt > NOW()
`);
console.log('\nSchedule stats:');
console.log(`  Earliest scheduled: ${intervalRows[0].earliest}`);
console.log(`  Latest scheduled: ${intervalRows[0].latest}`);
console.log(`  Avg hours from now: ${Math.round(intervalRows[0].avgHoursFromNow)}`);

process.exit(0);
