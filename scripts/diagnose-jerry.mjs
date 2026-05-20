import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Lead state
console.log("=== JERRY: Lead state ===");
const [leads] = await conn.execute(`
  SELECT id, name, phone, humanTakeover,
    DATE_FORMAT(lastAgentActivityAt, '%Y-%m-%d %H:%i:%s') as lastAgentActivityAt,
    DATE_FORMAT(lastMessageAt, '%Y-%m-%d %H:%i:%s') as lastMessageAt,
    DATE_FORMAT(nextFollowUpAt, '%Y-%m-%d %H:%i:%s') as nextFollowUpAt,
    pipelineStage, cadencePosition, reactivationCount
  FROM leads WHERE name LIKE 'Jerry%' OR name = 'Jerry'
`);
for (const r of leads) console.log(JSON.stringify(r, null, 2));

if (leads.length === 0) {
  console.log("No Jerry leads found");
  await conn.end();
  process.exit(0);
}
const jerryId = leads[0].id;

// Conversation history
console.log(`\n=== JERRY (leadId=${jerryId}): Conversation history (last 20) ===`);
const [convs] = await conn.execute(`
  SELECT id, direction, senderType, channel,
    DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') as ts,
    ghlMessageId,
    SUBSTRING(messageBody, 1, 150) as body
  FROM conversations WHERE leadId = ? ORDER BY id DESC LIMIT 20
`, [jerryId]);
for (const r of convs) {
  console.log(`id=${r.id} | ${r.ts} | ${r.direction} | ${r.senderType} | ghlId=${r.ghlMessageId ? "YES" : "NULL"} | ${r.body}`);
}

// Decision log
console.log(`\n=== JERRY (leadId=${jerryId}): Decision log since 18:00 UTC ===`);
const [decs] = await conn.execute(`
  SELECT id, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') as ts,
    \`trigger\`, channel, inputGuardResult, outputGuardResult,
    SUBSTRING(brainReasoning, 1, 300) as reasoning
  FROM decision_log
  WHERE leadId = ? AND createdAt > '2026-05-19 18:00:00'
  ORDER BY createdAt DESC
`, [jerryId]);
if (decs.length === 0) {
  console.log("No decision_log rows since 18:00 UTC");
} else {
  for (const r of decs) {
    console.log(`id=${r.id} | ${r.ts} | trigger=${r.trigger} | ch=${r.channel} | input=${r.inputGuardResult} | output=${r.outputGuardResult}`);
    if (r.reasoning) console.log(`  reasoning: ${r.reasoning}`);
  }
}
console.log(`Total decision rows: ${decs.length}`);

await conn.end();
