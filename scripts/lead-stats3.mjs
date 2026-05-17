import 'dotenv/config';
import mysql from 'mysql2/promise';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error('No DATABASE_URL found'); process.exit(1); }

const conn = await mysql.createConnection(dbUrl);

// Gate 2 blocked leads by source
console.log('\n=== GATE 2 BLOCKED: by source ===');
const [g2source] = await conn.execute(`
  SELECT source, COUNT(*) as cnt 
  FROM leads 
  WHERE createdAt < DATE_SUB(NOW(), INTERVAL 90 DAY) 
    AND COALESCE(reactivatedFromMigration, 0) = 0 
    AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = leads.id AND c.direction = 'inbound') 
    AND humanTakeover = 0 
    AND COALESCE(pipelineStage, 'new_lead') NOT IN ('not_qualified', 'lost')
  GROUP BY source 
  ORDER BY cnt DESC
`);
console.table(g2source);

// Of those 2403, how many have ANY outbound conversation (we sent them something)?
console.log('\n=== GATE 2 BLOCKED: with outbound conversations ===');
const [g2outbound] = await conn.execute(`
  SELECT COUNT(*) as has_outbound
  FROM leads 
  WHERE createdAt < DATE_SUB(NOW(), INTERVAL 90 DAY) 
    AND COALESCE(reactivatedFromMigration, 0) = 0 
    AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = leads.id AND c.direction = 'inbound') 
    AND humanTakeover = 0 
    AND COALESCE(pipelineStage, 'new_lead') NOT IN ('not_qualified', 'lost')
    AND EXISTS (SELECT 1 FROM conversations c2 WHERE c2.leadId = leads.id AND c2.direction = 'outbound')
`);
console.table(g2outbound);

// How many have NO conversations at all (never contacted)?
console.log('\n=== GATE 2 BLOCKED: never contacted at all ===');
const [g2never] = await conn.execute(`
  SELECT COUNT(*) as never_contacted
  FROM leads 
  WHERE createdAt < DATE_SUB(NOW(), INTERVAL 90 DAY) 
    AND COALESCE(reactivatedFromMigration, 0) = 0 
    AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = leads.id) 
    AND humanTakeover = 0 
    AND COALESCE(pipelineStage, 'new_lead') NOT IN ('not_qualified', 'lost')
`);
console.table(g2never);

// How many have email available?
console.log('\n=== GATE 2 BLOCKED: have email? ===');
const [g2email] = await conn.execute(`
  SELECT 
    SUM(CASE WHEN email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) as has_email,
    SUM(CASE WHEN email IS NULL OR email = '' THEN 1 ELSE 0 END) as no_email
  FROM leads 
  WHERE createdAt < DATE_SUB(NOW(), INTERVAL 90 DAY) 
    AND COALESCE(reactivatedFromMigration, 0) = 0 
    AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = leads.id AND c.direction = 'inbound') 
    AND humanTakeover = 0 
    AND COALESCE(pipelineStage, 'new_lead') NOT IN ('not_qualified', 'lost')
`);
console.table(g2email);

// How old are these leads?
console.log('\n=== GATE 2 BLOCKED: age distribution ===');
const [g2age] = await conn.execute(`
  SELECT 
    CASE 
      WHEN createdAt > DATE_SUB(NOW(), INTERVAL 6 MONTH) THEN '3-6 months'
      WHEN createdAt > DATE_SUB(NOW(), INTERVAL 12 MONTH) THEN '6-12 months'
      WHEN createdAt > DATE_SUB(NOW(), INTERVAL 24 MONTH) THEN '1-2 years'
      ELSE '2+ years'
    END as age_bucket,
    COUNT(*) as cnt
  FROM leads 
  WHERE createdAt < DATE_SUB(NOW(), INTERVAL 90 DAY) 
    AND COALESCE(reactivatedFromMigration, 0) = 0 
    AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.leadId = leads.id AND c.direction = 'inbound') 
    AND humanTakeover = 0 
    AND COALESCE(pipelineStage, 'new_lead') NOT IN ('not_qualified', 'lost')
  GROUP BY age_bucket
  ORDER BY cnt DESC
`);
console.table(g2age);

await conn.end();
