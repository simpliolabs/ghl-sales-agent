import mysql from "mysql2/promise";
import * as dotenv from "dotenv";
dotenv.config();

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Step 0: Find Adebola's lead ID
const [leads] = await conn.execute(
  `SELECT id, name, phone, humanTakeover, pipelineStage, cadencePosition, reactivationCount
   FROM leads WHERE name LIKE '%Adebola%' OR name LIKE '%adebola%' LIMIT 5`
);
console.log("=== Adebola lead(s) ===");
console.log(JSON.stringify(leads, null, 2));

const adebolaId = leads.length > 0 ? leads[0].id : null;
if (!adebolaId) { console.log("No Adebola found"); await conn.end(); process.exit(1); }

// Query 1: Full conversation history with sender attribution
const [convs] = await conn.execute(
  `SELECT id, direction, senderType, channel,
     DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') as ts,
     ghlMessageId,
     SUBSTRING(messageBody, 1, 250) as body
   FROM conversations
   WHERE leadId = ?
   ORDER BY id ASC`,
  [adebolaId]
);
console.log(`\n=== Query 1: Full conversation history for lead ${adebolaId} (${convs.length} rows) ===`);
for (const r of convs) {
  const dir = r.direction === 'inbound' ? '<<< LEAD' : '>>> AI  ';
  const msgId = r.ghlMessageId ? `msgId=${r.ghlMessageId.slice(0,12)}` : 'msgId=NULL';
  console.log(`[${r.ts}] ${dir} | ${r.channel} | ${r.senderType} | ${msgId}`);
  console.log(`  "${r.body}"`);
}

// Query 2: Decision log for the 9:15 AM message
const [decisions] = await conn.execute(
  `SELECT id, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') as ts,
     `trigger`, channel,
     SUBSTRING(brainReasoning, 1, 1000) as reasoning,
     outputGuardResult, inputGuardResult, flaggedForReview, flagReason
   FROM decision_log
   WHERE leadId = ?
     AND createdAt BETWEEN '2026-05-20 09:00:00' AND '2026-05-20 09:30:00'
   ORDER BY createdAt DESC`,
  [adebolaId]
);
console.log(`\n=== Query 2: Decision log for 9:15 AM message (${decisions.length} rows) ===`);
for (const r of decisions) {
  console.log(`[${r.ts}] trigger=${r.trigger} channel=${r.channel} inputGuard=${r.inputGuardResult} outputGuard=${r.outputGuardResult}`);
  console.log(`  REASONING: ${r.reasoning}`);
  if (r.flaggedForReview) console.log(`  FLAGGED: ${r.flagReason}`);
}

// Query 3: Scope — AI responding to its own prior outbound (no intervening lead inbound)
const [scope] = await conn.execute(
  `SELECT 
     c1.leadId, l.name,
     DATE_FORMAT(c1.timestamp, '%Y-%m-%d %H:%i') as first_ai_ts,
     DATE_FORMAT(c2.timestamp, '%Y-%m-%d %H:%i') as second_ai_ts,
     SUBSTRING(c1.messageBody, 1, 80) as first_ai,
     SUBSTRING(c2.messageBody, 1, 80) as second_ai
   FROM conversations c1
   JOIN conversations c2 ON c2.leadId = c1.leadId
     AND c2.id > c1.id
     AND c2.direction = 'outbound' AND c2.senderType = 'ai'
     AND c2.timestamp BETWEEN c1.timestamp AND DATE_ADD(c1.timestamp, INTERVAL 24 HOUR)
   JOIN leads l ON l.id = c1.leadId
   WHERE c1.direction = 'outbound' AND c1.senderType = 'ai'
     AND c1.timestamp > NOW() - INTERVAL 48 HOUR
     AND NOT EXISTS (
       SELECT 1 FROM conversations c3
       WHERE c3.leadId = c1.leadId
         AND c3.direction = 'inbound'
         AND c3.timestamp BETWEEN c1.timestamp AND c2.timestamp
     )
   ORDER BY c2.timestamp DESC
   LIMIT 50`
);
console.log(`\n=== Query 3: AI-responds-to-itself scope (last 48h, ${scope.length} rows) ===`);
if (scope.length === 0) {
  console.log("No instances found — isolated to Adebola");
} else {
  for (const r of scope) {
    console.log(`lead=${r.leadId} (${r.name})`);
    console.log(`  First AI  [${r.first_ai_ts}]: "${r.first_ai}"`);
    console.log(`  Second AI [${r.second_ai_ts}]: "${r.second_ai}"`);
  }
}
console.log(`\nTotal scope count: ${scope.length}`);

await conn.end();
