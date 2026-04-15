import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Find David Rose
const [leads] = await conn.execute(
  `SELECT id, name, email, phone, ghlContactId, businessName, createdAt, 
          omnisendSegment, humanTakeover, processingLockedAt, preferredChannel,
          lastOutboundChannel, convState, reactivationCount, source
   FROM leads 
   WHERE name LIKE '%David%Rose%' OR name LIKE '%david%rose%'
   LIMIT 5`
);
console.log('=== DAVID ROSE LEADS ===');
console.log(JSON.stringify(leads, null, 2));

if (leads.length > 0) {
  const leadId = leads[0].id;
  
  // Get brain council audit entries for this lead
  const [audits] = await conn.execute(
    `SELECT id, leadId, leadName, channel, strategyApproach, strategyFramework, 
            blocked, blockReason, violationCategory, messageSent, createdAt
     FROM brain_council_audit
     WHERE leadId = ?
     ORDER BY createdAt DESC
     LIMIT 10`,
    [leadId]
  );
  console.log('\n=== BRAIN COUNCIL AUDITS ===');
  console.log(JSON.stringify(audits, null, 2));
}

await conn.end();
