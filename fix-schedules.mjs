/**
 * Fix scheduling issues:
 * 1. Reset all leads scheduled beyond 90 days from now back to 90 days
 * 2. Reset the 43 truly never-contacted leads to fire immediately (nextFollowUpAt = NOW)
 */
import { getDb } from './server/db.ts';
import { sql } from 'drizzle-orm';

const db = await getDb();
if (!db) { console.log('no db'); process.exit(0); }

// Step 1: Check how many leads are scheduled beyond 90 days
const [farRows] = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM leads 
  WHERE nextFollowUpAt > DATE_ADD(NOW(), INTERVAL 90 DAY)
  AND humanTakeover = 0
`);
console.log(`Leads scheduled beyond 90 days: ${farRows[0].cnt}`);

// Step 2: Reset them to exactly 90 days from now
const [resetFarResult] = await db.execute(sql`
  UPDATE leads 
  SET nextFollowUpAt = DATE_ADD(NOW(), INTERVAL 90 DAY),
      updatedAt = NOW()
  WHERE nextFollowUpAt > DATE_ADD(NOW(), INTERVAL 90 DAY)
  AND humanTakeover = 0
`);
console.log(`Reset far-future leads to 90 days:`, resetFarResult.affectedRows);

// Step 3: Find truly never-contacted leads (no outbound conversations)
const [neverRows] = await db.execute(sql`
  SELECT l.id, l.name, l.pipelineStage, l.nextFollowUpAt
  FROM leads l
  WHERE l.humanTakeover = 0
  AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = l.id AND c.direction = 'outbound')
  ORDER BY l.createdAt ASC
`);
console.log(`\nTruly never-contacted leads: ${neverRows.length}`);

// Step 4: Reset never-contacted leads to fire in 5 minutes
const [resetNeverResult] = await db.execute(sql`
  UPDATE leads l
  SET l.nextFollowUpAt = DATE_ADD(NOW(), INTERVAL 5 MINUTE),
      l.updatedAt = NOW()
  WHERE l.humanTakeover = 0
  AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = l.id AND c.direction = 'outbound')
`);
console.log(`Reset never-contacted leads to fire in 5 min:`, resetNeverResult.affectedRows);

// Step 5: Verify the fix
const [dueRows] = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM leads 
  WHERE humanTakeover = 0 
  AND nextFollowUpAt <= DATE_ADD(NOW(), INTERVAL 10 MINUTE)
`);
console.log(`\nLeads due in next 10 minutes (will fire on next trigger run): ${dueRows[0].cnt}`);

const [farCheckRows] = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM leads 
  WHERE nextFollowUpAt > DATE_ADD(NOW(), INTERVAL 90 DAY)
  AND humanTakeover = 0
`);
console.log(`Leads still beyond 90 days (should be 0): ${farCheckRows[0].cnt}`);

// Show sample of leads that will fire soon
const [sampleRows] = await db.execute(sql`
  SELECT id, name, pipelineStage, nextFollowUpAt FROM leads
  WHERE humanTakeover = 0 AND nextFollowUpAt <= DATE_ADD(NOW(), INTERVAL 15 MINUTE)
  ORDER BY nextFollowUpAt ASC
  LIMIT 10
`);
console.log('\nSample leads firing soon:');
for (const r of sampleRows) {
  console.log(`  [${r.id}] ${r.name} | ${r.pipelineStage} | ${r.nextFollowUpAt}`);
}

process.exit(0);
