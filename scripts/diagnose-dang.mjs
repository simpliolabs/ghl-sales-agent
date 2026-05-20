import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Query A: Full conversation history for Dang
console.log("=== QUERY A: Full conversation history for Dang ===");
const [convRows] = await conn.execute(`
  SELECT id, leadId, channel, direction, senderType, senderName, 
    DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') as ts,
    ghlMessageId,
    SUBSTRING(messageBody, 1, 100) as body
  FROM conversations 
  WHERE leadId = (SELECT id FROM leads WHERE name LIKE '%Dang%HM%' OR name LIKE '%Dang HM%' LIMIT 1)
  ORDER BY timestamp DESC
`);
for (const r of convRows) {
  console.log(`id=${r.id} | ${r.ts} | ${r.direction} | ${r.senderType} | ${r.senderName || '-'} | ghlMsgId=${r.ghlMessageId ? 'YES' : 'NULL'} | ${r.body}`);
}
console.log(`Total: ${convRows.length} rows\n`);

// Query B: Dang's lead state
console.log("=== QUERY B: Dang's lead state ===");
const [leadRows] = await conn.execute(`
  SELECT id, name, phone, humanTakeover, 
    DATE_FORMAT(lastAgentActivityAt, '%Y-%m-%d %H:%i:%s') as lastAgentActivityAt,
    DATE_FORMAT(lastMessageAt, '%Y-%m-%d %H:%i:%s') as lastMessageAt,
    DATE_FORMAT(nextFollowUpAt, '%Y-%m-%d %H:%i:%s') as nextFollowUpAt,
    preferredChannel, pipelineStage, cadencePosition, reactivationCount
  FROM leads WHERE name LIKE '%Dang%'
`);
for (const r of leadRows) {
  console.log(JSON.stringify(r, null, 2));
}
console.log();

// Query C: Did the AI see the 7:20 PM inbound?
console.log("=== QUERY C: Conversations after 19:00 UTC (7:20 PM EDT = 23:20 UTC) ===");
const [recentConv] = await conn.execute(`
  SELECT id, leadId, direction, channel, senderType, 
    DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') as ts,
    SUBSTRING(messageBody, 1, 200) as body
  FROM conversations 
  WHERE leadId = (SELECT id FROM leads WHERE name LIKE '%Dang%HM%' OR name LIKE '%Dang HM%' LIMIT 1)
    AND timestamp > '2026-05-19 19:00:00'
  ORDER BY id DESC
`);
if (recentConv.length === 0) {
  console.log("NO rows after 19:00 UTC — 7:20 PM inbound NOT recorded");
} else {
  for (const r of recentConv) {
    console.log(`id=${r.id} | ${r.ts} | ${r.direction} | ${r.senderType} | ${r.body}`);
  }
}
console.log(`Total: ${recentConv.length} rows\n`);

// Query D: Decision log for Dang in last 12 hours
console.log("=== QUERY D: Decision log for Dang (last 12h) ===");
const [decRows] = await conn.execute(`
  SELECT id, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') as ts,
    decisionType, channel, blocked, blockReason,
    SUBSTRING(reasoning, 1, 200) as reasoning
  FROM decision_log
  WHERE leadId = (SELECT id FROM leads WHERE name LIKE '%Dang%HM%' OR name LIKE '%Dang HM%' LIMIT 1)
    AND createdAt > '2026-05-19 12:00:00'
  ORDER BY createdAt DESC
`);
if (decRows.length === 0) {
  console.log("NO decision_log rows for Dang in last 12h");
} else {
  for (const r of decRows) {
    console.log(`id=${r.id} | ${r.ts} | type=${r.decisionType} | ch=${r.channel} | blocked=${r.blocked} | reason=${r.blockReason || '-'}`);
    if (r.reasoning) console.log(`  reasoning: ${r.reasoning}`);
  }
}
console.log(`Total: ${decRows.length} rows`);

await conn.end();
