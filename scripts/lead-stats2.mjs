import 'dotenv/config';
import mysql from 'mysql2/promise';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error('No DATABASE_URL found'); process.exit(1); }

const conn = await mysql.createConnection(dbUrl);

console.log('\n=== FOLLOW-UP TIME DISTRIBUTION ===');
const [dist] = await conn.execute(`
  SELECT 
    CASE 
      WHEN nextFollowUpAt <= NOW() THEN 'overdue'
      WHEN nextFollowUpAt <= DATE_ADD(NOW(), INTERVAL 1 HOUR) THEN 'next_1h'
      WHEN nextFollowUpAt <= DATE_ADD(NOW(), INTERVAL 6 HOUR) THEN 'next_6h'
      WHEN nextFollowUpAt <= DATE_ADD(NOW(), INTERVAL 24 HOUR) THEN 'next_24h'
      WHEN nextFollowUpAt <= DATE_ADD(NOW(), INTERVAL 7 DAY) THEN 'next_7d'
      ELSE 'beyond_7d'
    END as time_bucket,
    COUNT(*) as cnt
  FROM leads
  WHERE nextFollowUpAt IS NOT NULL
  GROUP BY time_bucket
`);
console.table(dist);

console.log('\n=== OUTBOX STATUS (last 24h) ===');
const [outboxStats] = await conn.execute(`
  SELECT outbox_status, COUNT(*) as cnt
  FROM outbox
  WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  GROUP BY outbox_status
`);
console.table(outboxStats);

console.log('\n=== DECISION LOG (last 24h) — skip reasons ===');
const [skipReasons] = await conn.execute(`
  SELECT inputGuardResult, outputGuardResult, COUNT(*) as cnt
  FROM decision_log
  WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    AND (inputGuardResult LIKE 'block%' OR outputGuardResult LIKE 'block%')
  GROUP BY inputGuardResult, outputGuardResult
  ORDER BY cnt DESC
  LIMIT 20
`);
console.table(skipReasons);

console.log('\n=== SUCCESSFUL SENDS (last 24h) ===');
const [sends] = await conn.execute(`
  SELECT COUNT(*) as total_sent
  FROM decision_log
  WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    AND outputGuardResult = 'pass'
    AND inputGuardResult = 'pass'
`);
console.table(sends);

console.log('\n=== LEADS IN TERMINAL STAGES (blocked from engagement) ===');
const [terminal] = await conn.execute(`
  SELECT pipelineStage, COUNT(*) as cnt
  FROM leads
  WHERE pipelineStage IN ('won', 'lost', 'abandoned', 'not_qualified', 'Not Qualified', 'Lost')
  GROUP BY pipelineStage
  ORDER BY cnt DESC
`);
console.table(terminal);

console.log('\n=== NON-TERMINAL LEADS WITH FUTURE FOLLOW-UPS > 7 DAYS ===');
const [farFuture] = await conn.execute(`
  SELECT pipelineStage, COUNT(*) as cnt, MIN(nextFollowUpAt) as earliest, MAX(nextFollowUpAt) as latest
  FROM leads
  WHERE nextFollowUpAt > DATE_ADD(NOW(), INTERVAL 7 DAY)
    AND pipelineStage NOT IN ('won', 'lost', 'abandoned', 'not_qualified', 'Not Qualified', 'Lost')
  GROUP BY pipelineStage
  ORDER BY cnt DESC
`);
console.table(farFuture);

console.log('\n=== SUPERVISOR ACTIVITY (recent outbox sources) ===');
const [sources] = await conn.execute(`
  SELECT source, COUNT(*) as cnt
  FROM outbox
  WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  GROUP BY source
  ORDER BY cnt DESC
`);
console.table(sources);

await conn.end();
