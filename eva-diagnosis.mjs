import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get Eva's last 10 audit entries
const [audits] = await conn.execute(`
  SELECT id, createdAt, blocked, blockReason, violationCategory, qcScore, composedMessage
  FROM brain_council_audit
  WHERE leadId = 450001
  ORDER BY createdAt DESC
  LIMIT 10
`);
console.log("Eva's last 10 audit entries:");
for (const a of audits) {
  console.log(`  [${a.createdAt}] blocked=${a.blocked} score=${a.qcScore} category=${a.violationCategory}`);
  console.log(`    reason: ${a.blockReason?.substring(0, 120)}`);
  if (a.composedMessage) console.log(`    msg: ${a.composedMessage?.substring(0, 100)}`);
}

// Get Eva's lead record
const [leads] = await conn.execute(`SELECT id, name, humanTakeover, lastAiSendAttemptAt, cadencePosition, preferredChannel FROM leads WHERE id = 450001`);
console.log("\nEva lead record:", leads[0]);

// Get Eva's recent conversations
const [convs] = await conn.execute(`
  SELECT direction, channel, senderType, messageBody, timestamp
  FROM conversations
  WHERE leadId = 450001
  ORDER BY timestamp DESC
  LIMIT 6
`);
console.log("\nEva's last 6 conversations:");
for (const c of convs) {
  console.log(`  [${c.timestamp}] ${c.direction}/${c.senderType}/${c.channel}: ${c.messageBody?.substring(0, 80)}`);
}

await conn.end();
