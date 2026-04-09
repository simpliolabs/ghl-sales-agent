import { getDb } from './server/db.ts';
import { sql } from 'drizzle-orm';

const db = await getDb();
const now = Date.now();
const cutoff24h = now - 24*60*60*1000;

const results = await db.execute(sql.raw(`
  SELECT 
    (SELECT COUNT(*) FROM leads WHERE nextFollowUpAt IS NOT NULL AND nextFollowUpAt <= ${now} AND humanTakeover = 0) as overdue_followups,
    (SELECT COUNT(*) FROM leads WHERE nextFollowUpAt IS NULL AND humanTakeover = 0) as no_followup_set,
    (SELECT COUNT(*) FROM leads WHERE lastAiSendAttemptAt > ${cutoff24h}) as ai_sent_24h,
    (SELECT COUNT(*) FROM leads) as total_leads,
    (SELECT COUNT(*) FROM leads WHERE LOWER(pipelineStage) LIKE '%not qualified%' OR LOWER(pipelineStage) LIKE '%not_qualified%') as nq_leads
`));
const r = results[0][0];
console.log('Overdue follow-ups:', r.overdue_followups);
console.log('Leads with NO nextFollowUpAt:', r.no_followup_set);
console.log('AI messages sent in last 24h:', r.ai_sent_24h);
console.log('Total leads:', r.total_leads);
console.log('Not Qualified leads:', r.nq_leads);

// Pipeline stage distribution
const stages = await db.execute(sql.raw(`
  SELECT pipelineStage, COUNT(*) as cnt FROM leads GROUP BY pipelineStage ORDER BY cnt DESC
`));
console.log('\nPipeline stage distribution:');
for (const s of stages[0]) {
  console.log('  ' + (s.pipelineStage || '(null)') + ': ' + s.cnt);
}

// Top 10 overdue follow-up candidates
const candidates = await db.execute(sql.raw(`
  SELECT id, name, nextFollowUpAt, pipelineStage, lastAiSendAttemptAt, lastResearchSummary
  FROM leads 
  WHERE nextFollowUpAt IS NOT NULL AND nextFollowUpAt <= ${now} AND humanTakeover = 0
  ORDER BY nextFollowUpAt ASC
  LIMIT 10
`));
console.log('\nTop 10 overdue follow-up candidates:');
for (const l of candidates[0]) {
  const overdueMins = Math.round((now - Number(l.nextFollowUpAt)) / 60000);
  const hasLookback = l.lastResearchSummary && l.lastResearchSummary.includes('[LOOKBACK]');
  console.log('  Lead ' + l.id + ' (' + l.name + '): overdue by ' + overdueMins + ' min, stage=' + l.pipelineStage + ', lastAI=' + (l.lastAiSendAttemptAt ? new Date(Number(l.lastAiSendAttemptAt)).toISOString() : 'never') + ', lookback=' + (hasLookback ? 'YES' : 'NO'));
}

// Check lookback timer state
const lookbackPending = await db.execute(sql.raw(`
  SELECT COUNT(*) as cnt FROM leads 
  WHERE humanTakeover = 0 
  AND (lastResearchSummary IS NULL OR lastResearchSummary NOT LIKE '%[LOOKBACK]%')
`));
console.log('\nLeads pending lookback analysis:', lookbackPending[0][0].cnt);

process.exit(0);
