import mysql from "mysql2/promise";
import * as dotenv from "dotenv";
dotenv.config();

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Query 3: Scope — AI responding to its own prior outbound (no intervening lead inbound) in last 48h
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

console.log(`=== Query 3: AI-responds-to-itself scope (last 48h) ===`);
console.log(`Total instances: ${scope.length}`);
if (scope.length === 0) {
  console.log("No instances found — Adebola is isolated");
} else {
  // Group by leadId
  const byLead = {};
  for (const r of scope) {
    if (!byLead[r.leadId]) byLead[r.leadId] = { name: r.name, pairs: [] };
    byLead[r.leadId].pairs.push(r);
  }
  const leadCount = Object.keys(byLead).length;
  console.log(`Unique leads affected: ${leadCount}`);
  console.log('');
  for (const [leadId, data] of Object.entries(byLead)) {
    console.log(`lead=${leadId} (${data.name}) — ${data.pairs.length} pair(s)`);
    for (const p of data.pairs.slice(0, 3)) {
      console.log(`  [${p.first_ai_ts}] "${p.first_ai}"`);
      console.log(`  [${p.second_ai_ts}] "${p.second_ai}"`);
    }
  }
}

await conn.end();
