import { getDb } from './server/db.ts';
import { sql } from 'drizzle-orm';

const db = await getDb();
if (!db) { console.log('no db'); process.exit(0); }

// Check Mika Exult Jones full record
const [mikaRows] = await db.execute(sql`SELECT * FROM leads WHERE id = 881`);
console.log('Mika Exult Jones full record:');
console.log(JSON.stringify(mikaRows[0], null, 2));

// Check conversations for Mika
const [convRows] = await db.execute(sql`SELECT * FROM conversations WHERE leadId = 881 ORDER BY timestamp DESC LIMIT 10`);
console.log('\nMika conversations:', convRows.length);
for (const c of convRows) {
  console.log(`  [${c.direction}] ${c.timestamp} - ${String(c.messageBody).substring(0, 80)}`);
}

// Check brain council audit for Mika
const [auditRows] = await db.execute(sql`SELECT * FROM brain_council_audit WHERE leadId = 881 ORDER BY createdAt DESC LIMIT 5`);
console.log('\nMika brain council audit:', auditRows.length);
for (const a of auditRows) {
  console.log(`  ${a.createdAt} - approach: ${a.strategyApproach}, blocked: ${a.blocked}`);
}

// Check how many leads have source = 'stop_bot'
const [stopBotRows] = await db.execute(sql`
  SELECT COUNT(*) as cnt, AVG(TIMESTAMPDIFF(DAY, NOW(), nextFollowUpAt)) as avgDaysOut
  FROM leads WHERE source = 'stop_bot'
`);
console.log('\nStop bot leads:', stopBotRows[0].cnt, '| Avg days until follow-up:', Math.round(stopBotRows[0].avgDaysOut));

// Check leads with nextFollowUpAt > 1 year from now (scheduling bug)
const [farFutureRows] = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM leads 
  WHERE nextFollowUpAt > DATE_ADD(NOW(), INTERVAL 90 DAY)
`);
console.log('Leads scheduled MORE than 90 days out:', farFutureRows[0].cnt);

// Check leads with nextFollowUpAt > 1 year
const [yearRows] = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM leads 
  WHERE nextFollowUpAt > DATE_ADD(NOW(), INTERVAL 365 DAY)
`);
console.log('Leads scheduled MORE than 1 YEAR out:', yearRows[0].cnt);

// Check distribution of sources
const [sourceRows] = await db.execute(sql`
  SELECT source, COUNT(*) as cnt FROM leads GROUP BY source ORDER BY cnt DESC
`);
console.log('\nLead source distribution:');
for (const row of sourceRows) {
  console.log(`  ${row.source || 'NULL'}: ${row.cnt}`);
}

// Check the 558 new_lead stage leads - how many have outbound conversations?
const [newLeadContactedRows] = await db.execute(sql`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = l.id AND c.direction = 'outbound') THEN 1 ELSE 0 END) as hasOutbound,
    SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = l.id AND c.direction = 'outbound') THEN 1 ELSE 0 END) as neverContacted
  FROM leads l
  WHERE l.pipelineStage = 'new_lead'
`);
console.log('\n558 new_lead stage leads breakdown:');
console.log(`  Total: ${newLeadContactedRows[0].total}`);
console.log(`  Has outbound messages (contacted but stage not updated): ${newLeadContactedRows[0].hasOutbound}`);
console.log(`  Truly never contacted: ${newLeadContactedRows[0].neverContacted}`);

process.exit(0);
