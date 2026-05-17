import 'dotenv/config';
import mysql from 'mysql2/promise';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error('No DATABASE_URL found'); process.exit(1); }

const conn = await mysql.createConnection(dbUrl);

console.log('\n=== LEAD OVERVIEW ===');
const [overview] = await conn.execute(`
  SELECT 
    COUNT(*) as total_leads,
    SUM(CASE WHEN nextFollowUpAt IS NULL THEN 1 ELSE 0 END) as null_followup,
    SUM(CASE WHEN nextFollowUpAt IS NOT NULL AND nextFollowUpAt > NOW() THEN 1 ELSE 0 END) as scheduled_future,
    SUM(CASE WHEN nextFollowUpAt IS NOT NULL AND nextFollowUpAt <= NOW() THEN 1 ELSE 0 END) as overdue,
    SUM(CASE WHEN humanTakeover = 1 THEN 1 ELSE 0 END) as human_takeover_active
  FROM leads
`);
console.table(overview);

console.log('\n=== BY PIPELINE STAGE ===');
const [byStage] = await conn.execute(`
  SELECT pipelineStage, 
    COUNT(*) as cnt, 
    SUM(CASE WHEN nextFollowUpAt IS NULL THEN 1 ELSE 0 END) as null_followup,
    SUM(CASE WHEN humanTakeover=1 THEN 1 ELSE 0 END) as takeover
  FROM leads 
  GROUP BY pipelineStage 
  ORDER BY cnt DESC
`);
console.table(byStage);

console.log('\n=== DORMANT LEADS (NULL nextFollowUpAt, NOT terminal, NOT humanTakeover) ===');
const [dormant] = await conn.execute(`
  SELECT pipelineStage, COUNT(*) as cnt
  FROM leads 
  WHERE nextFollowUpAt IS NULL 
    AND humanTakeover = 0
    AND (pipelineStage NOT IN ('won', 'lost', 'abandoned', 'not_qualified', 'Not Qualified', 'Lost') OR pipelineStage IS NULL)
  GROUP BY pipelineStage
  ORDER BY cnt DESC
`);
console.table(dormant);

const [dormantTotal] = await conn.execute(`
  SELECT COUNT(*) as total_dormant
  FROM leads 
  WHERE nextFollowUpAt IS NULL 
    AND humanTakeover = 0
    AND (pipelineStage NOT IN ('won', 'lost', 'abandoned', 'not_qualified', 'Not Qualified', 'Lost') OR pipelineStage IS NULL)
`);
console.log('Total dormant leads eligible for re-engagement:', dormantTotal[0].total_dormant);

console.log('\n=== LEADS WITH SCHEDULED FOLLOW-UPS (next 24h) ===');
const [upcoming] = await conn.execute(`
  SELECT COUNT(*) as upcoming_24h
  FROM leads 
  WHERE nextFollowUpAt IS NOT NULL 
    AND nextFollowUpAt > NOW() 
    AND nextFollowUpAt <= DATE_ADD(NOW(), INTERVAL 24 HOUR)
`);
console.table(upcoming);

console.log('\n=== REACTIVATION STATUS ===');
const [reactivation] = await conn.execute(`
  SELECT 
    reactivatedFromMigration,
    COUNT(*) as cnt,
    SUM(CASE WHEN nextFollowUpAt IS NULL THEN 1 ELSE 0 END) as null_followup
  FROM leads 
  GROUP BY reactivatedFromMigration
`);
console.table(reactivation);

console.log('\n=== SAMPLE DORMANT LEADS (first 20) ===');
const [samples] = await conn.execute(`
  SELECT id, name, pipelineStage, preferredChannel, source, createdAt, lastInboundAt
  FROM leads 
  WHERE nextFollowUpAt IS NULL 
    AND humanTakeover = 0
    AND (pipelineStage NOT IN ('won', 'lost', 'abandoned', 'not_qualified', 'Not Qualified', 'Lost') OR pipelineStage IS NULL)
  ORDER BY lastInboundAt DESC
  LIMIT 20
`);
console.table(samples);

await conn.end();
