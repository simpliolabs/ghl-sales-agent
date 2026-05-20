import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 1. Lead state
console.log("=== 1. KENYETTA: Lead state ===");
const [leads] = await conn.execute(`
  SELECT id, name, phone, humanTakeover,
    DATE_FORMAT(lastAgentActivityAt, '%Y-%m-%d %H:%i:%s') as lastAgentActivityAt,
    DATE_FORMAT(lastMessageAt, '%Y-%m-%d %H:%i:%s') as lastMessageAt,
    DATE_FORMAT(nextFollowUpAt, '%Y-%m-%d %H:%i:%s') as nextFollowUpAt,
    pipelineStage, preferredChannel, cadencePosition, reactivationCount
  FROM leads
  WHERE name LIKE 'Kenyetta%' OR name LIKE '%Finley%'
`);
for (const r of leads) console.log(JSON.stringify(r, null, 2));

if (leads.length === 0) {
  console.log("No Kenyetta leads found");
  await conn.end();
  process.exit(0);
}
const kId = leads[0].id;
console.log(`\nUsing leadId=${kId} for remaining queries`);

// 2. Conversation history
console.log(`\n=== 2. Conversations (last 30, desc) ===`);
const [convs] = await conn.execute(`
  SELECT id, direction, senderType, channel,
    DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') as ts,
    ghlMessageId IS NULL as is_null_id,
    SUBSTRING(messageBody, 1, 200) as body
  FROM conversations
  WHERE leadId = ?
  ORDER BY id DESC LIMIT 30
`, [kId]);
for (const r of convs) {
  console.log(`id=${r.id} | ${r.ts} | ${r.direction} | ${r.senderType} | nullId=${r.is_null_id} | ch=${r.channel} | ${r.body}`);
}

// 3. Decision log
console.log(`\n=== 3. Decision log since 2026-05-19 04:00 UTC ===`);
const [decs] = await conn.execute(`
  SELECT id, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') as ts,
    \`trigger\`, channel, inputGuardResult, outputGuardResult,
    SUBSTRING(brainReasoning, 1, 400) as reasoning
  FROM decision_log
  WHERE leadId = ? AND createdAt > '2026-05-19 04:00:00'
  ORDER BY createdAt DESC
`, [kId]);
console.log(`Total decision rows: ${decs.length}`);
for (const r of decs) {
  console.log(`id=${r.id} | ${r.ts} | trigger=${r.trigger} | ch=${r.channel} | input=${r.inputGuardResult} | output=${r.outputGuardResult}`);
  if (r.reasoning) console.log(`  reasoning: ${r.reasoning}`);
}

// 4. Send attempts
console.log(`\n=== 4. Send attempts ===`);
const [sa] = await conn.execute(`
  SELECT id, channel, outcomeKind, reason,
    DATE_FORMAT(attemptedAt, '%Y-%m-%d %H:%i:%s') as attemptedAt
  FROM send_attempts WHERE leadId = ? ORDER BY id DESC
`, [kId]);
console.log(`Total send_attempts: ${sa.length}`);
for (const r of sa) {
  console.log(`id=${r.id} | ${r.attemptedAt} | ${r.channel} | ${r.outcomeKind} | ${r.reason}`);
}

// 5. Outbox / pending_first_contacts
console.log(`\n=== 5. Outbox + pending_first_contacts ===`);
const [pfc] = await conn.execute(`SELECT 'pending_fc' as src, id, leadId FROM pending_first_contacts WHERE leadId = ?`, [kId]);
const [obx] = await conn.execute(`SELECT 'outbox' as src, id, leadId, outbox_status FROM outbox WHERE leadId = ? ORDER BY id DESC LIMIT 10`, [kId]);
console.log(`pending_first_contacts: ${pfc.length} rows`);
for (const r of pfc) console.log(JSON.stringify(r));
console.log(`outbox rows: ${obx.length}`);
for (const r of obx) console.log(JSON.stringify(r));

// 6. SCOPE QUERY — all leads with inbound in last 24h, no AI reply after last inbound
console.log(`\n=== 6. SCOPE: Leads with unanswered inbounds in last 24h ===`);
const [scope] = await conn.execute(`
  SELECT
    c.leadId,
    l.name,
    l.humanTakeover,
    l.pipelineStage,
    COUNT(c.id) as inbound_count,
    MIN(DATE_FORMAT(c.timestamp, '%Y-%m-%d %H:%i:%s')) as first_inbound,
    MAX(DATE_FORMAT(c.timestamp, '%Y-%m-%d %H:%i:%s')) as last_inbound,
    (SELECT COUNT(*) FROM conversations c2
     WHERE c2.leadId = c.leadId
       AND c2.direction = 'outbound'
       AND c2.senderType = 'ai'
       AND c2.timestamp > (SELECT MAX(c3.timestamp) FROM conversations c3 WHERE c3.leadId = c.leadId AND c3.direction = 'inbound' AND c3.timestamp > NOW() - INTERVAL 24 HOUR)
    ) as ai_replies_after_last_inbound
  FROM conversations c
  JOIN leads l ON l.id = c.leadId
  WHERE c.direction = 'inbound'
    AND c.timestamp > NOW() - INTERVAL 24 HOUR
  GROUP BY c.leadId, l.name, l.humanTakeover, l.pipelineStage
  HAVING ai_replies_after_last_inbound = 0
  ORDER BY last_inbound DESC
`);
console.log(`Total silenced leads (no AI reply after inbound, last 24h): ${scope.length}`);
for (const r of scope) {
  console.log(`lead=${r.leadId} | ${r.name} | takeover=${r.humanTakeover} | stage=${r.pipelineStage} | inbounds=${r.inbound_count} | last=${r.last_inbound} | ai_replies=${r.ai_replies_after_last_inbound}`);
}

await conn.end();
