import { createConnection } from 'mysql2/promise';

const conn = await createConnection(process.env.DATABASE_URL);
const now = Date.now();

// 1. Find lead — GHL URL /leads/690005 could be internal ID or partial GHL ID
const [byId] = await conn.execute('SELECT id, name, email, phone, ghlContactId, pipelineStage, opportunityStatus, nextFollowUpAt, lastMessageAt, humanTakeover, assignedAgent, opportunityScore, convState, convStateUpdatedAt, lastOutboundChannel, lastAgentActivityAt, lastAiSendAttemptAt FROM leads WHERE id = 690005 LIMIT 1');
const [byGhlId] = await conn.execute('SELECT id, name, email, phone, ghlContactId, pipelineStage, opportunityStatus, nextFollowUpAt, lastMessageAt, humanTakeover, assignedAgent, opportunityScore, convState FROM leads WHERE ghlContactId LIKE "%690005%" LIMIT 5');

console.log('\n=== Lead by internal ID 690005 ===');
if (byId.length === 0) console.log('  NOT FOUND');
else for (const l of byId) {
  console.log(`  #${l.id} ${l.name} | email: ${l.email} | phone: ${l.phone}`);
  console.log(`  ghlContactId: ${l.ghlContactId}`);
  console.log(`  stage: ${l.pipelineStage} | status: ${l.opportunityStatus} | score: ${l.opportunityScore}`);
  console.log(`  nextFollowUp: ${l.nextFollowUpAt ? new Date(Number(l.nextFollowUpAt)).toISOString() : 'NULL'}`);
  console.log(`  lastMessage: ${l.lastMessageAt ? new Date(Number(l.lastMessageAt)).toISOString() : 'NULL'}`);
  console.log(`  lastAiSend: ${l.lastAiSendAttemptAt ? new Date(Number(l.lastAiSendAttemptAt)).toISOString() : 'NULL'}`);
  console.log(`  humanTakeover: ${l.humanTakeover} | agent: ${l.assignedAgent} | channel: ${l.lastOutboundChannel}`);
  console.log(`  convState: ${l.convState} | stateUpdated: ${l.convStateUpdatedAt ? new Date(Number(l.convStateUpdatedAt)).toISOString() : 'NULL'}`);
}

console.log('\n=== Lead by GHL ID containing 690005 ===');
if (byGhlId.length === 0) console.log('  NOT FOUND');
else for (const l of byGhlId) {
  console.log(`  #${l.id} ${l.name} | ghlId: ${l.ghlContactId} | stage: ${l.pipelineStage} | followUp: ${l.nextFollowUpAt ? new Date(Number(l.nextFollowUpAt)).toISOString() : 'NULL'}`);
}

// 2. Overall scheduling health
const [overdueCount] = await conn.execute(
  `SELECT COUNT(*) as cnt FROM leads WHERE nextFollowUpAt IS NOT NULL AND nextFollowUpAt < ${now} AND humanTakeover != 1`
);
console.log(`\n=== Overdue follow-ups: ${overdueCount[0].cnt} ===`);

// 3. Distribution of nextFollowUpAt
const [distribution] = await conn.execute(`
  SELECT 
    CASE 
      WHEN nextFollowUpAt IS NULL THEN 'NULL'
      WHEN nextFollowUpAt < ${now} THEN 'OVERDUE'
      WHEN nextFollowUpAt < ${now + 86400000} THEN 'NEXT_24H'
      WHEN nextFollowUpAt < ${now + 604800000} THEN 'NEXT_7D'
      WHEN nextFollowUpAt < ${now + 2592000000} THEN 'NEXT_30D'
      WHEN nextFollowUpAt < ${now + 7776000000} THEN 'NEXT_90D'
      ELSE 'BEYOND_90D'
    END as bucket,
    COUNT(*) as cnt
  FROM leads
  WHERE humanTakeover != 1
  GROUP BY bucket
`);
console.log('\n=== Follow-up schedule distribution (non-takeover leads) ===');
for (const row of distribution) {
  console.log(`  ${row.bucket}: ${row.cnt} leads`);
}

// 4. Recent conversations for lead (if found)
if (byId.length > 0) {
  const leadId = byId[0].id;
  const [convos] = await conn.execute(
    'SELECT id, direction, channel, body, createdAt FROM conversations WHERE leadId = ? ORDER BY createdAt DESC LIMIT 10',
    [leadId]
  );
  console.log(`\n=== Last 10 conversations for lead #${leadId} ===`);
  for (const c of convos) {
    const ts = new Date(Number(c.createdAt)).toISOString();
    const bodySnip = (c.body || '').substring(0, 80);
    console.log(`  ${ts} | ${c.direction} | ${c.channel} | ${bodySnip}`);
  }
  
  // Check AI state
  const [aiState] = await conn.execute('SELECT * FROM ai_state WHERE leadId = ?', [leadId]);
  if (aiState.length > 0) {
    const s = aiState[0];
    console.log(`\n=== AI State for lead #${leadId} ===`);
    console.log(`  sentimentTrend: ${s.sentimentTrend} | unansweredCount: ${s.unansweredCount} | consecutiveFailures: ${s.consecutiveFailures}`);
    console.log(`  lastInteractionSummary: ${(s.lastInteractionSummary || '').substring(0, 120)}`);
  }
}

// 5. Check how many leads have follow-ups set to today vs past
const todayStart = new Date(); todayStart.setHours(0,0,0,0);
const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
const [todayLeads] = await conn.execute(
  `SELECT COUNT(*) as cnt FROM leads WHERE nextFollowUpAt >= ${todayStart.getTime()} AND nextFollowUpAt <= ${todayEnd.getTime()} AND humanTakeover != 1`
);
console.log(`\n=== Leads scheduled for TODAY: ${todayLeads[0].cnt} ===`);

// 6. Check what the follow-up trigger would pick up right now
const [triggerCandidates] = await conn.execute(`
  SELECT COUNT(*) as cnt FROM leads 
  WHERE nextFollowUpAt IS NOT NULL 
    AND nextFollowUpAt <= ${now}
    AND humanTakeover != 1
    AND (processingLockedAt IS NULL OR processingLockedAt < ${now - 300000})
    AND (lastAiSendAttemptAt IS NULL OR lastAiSendAttemptAt < ${now - 600000})
`);
console.log(`\n=== Follow-up trigger candidates RIGHT NOW: ${triggerCandidates[0].cnt} ===`);

// 7. Sample 10 leads that SHOULD be contacted today but aren't
const [shouldContact] = await conn.execute(`
  SELECT id, name, nextFollowUpAt, lastMessageAt, pipelineStage, humanTakeover, processingLockedAt, lastAiSendAttemptAt
  FROM leads 
  WHERE nextFollowUpAt IS NOT NULL 
    AND nextFollowUpAt <= ${now}
    AND humanTakeover != 1
  ORDER BY nextFollowUpAt ASC
  LIMIT 10
`);
console.log('\n=== Sample leads that should be contacted NOW ===');
for (const l of shouldContact) {
  const followUp = new Date(Number(l.nextFollowUpAt)).toISOString();
  const lastMsg = l.lastMessageAt ? new Date(Number(l.lastMessageAt)).toISOString() : 'never';
  const locked = l.processingLockedAt ? new Date(Number(l.processingLockedAt)).toISOString() : 'none';
  const lastAi = l.lastAiSendAttemptAt ? new Date(Number(l.lastAiSendAttemptAt)).toISOString() : 'none';
  console.log(`  #${l.id} ${l.name} | followUp: ${followUp} | lastMsg: ${lastMsg} | stage: ${l.pipelineStage} | locked: ${locked} | lastAi: ${lastAi}`);
}

await conn.end();
