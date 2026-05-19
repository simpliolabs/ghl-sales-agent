/**
 * Dead-phone-leads enumeration
 * Leads with phantom send_attempts in the last 7 days
 * (phantoms = real carrier failures, not bookkeeping artifacts)
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Total count
const [countRow] = await conn.execute(`
  SELECT COUNT(DISTINCT l.id) as total_affected_leads
  FROM leads l
  JOIN send_attempts s ON s.leadId = l.id
  WHERE s.outcomeKind = 'phantom'
    AND s.attemptedAt > NOW() - INTERVAL 7 DAY
    AND s.leadId != -1
    AND (s.trigger IS NULL OR s.trigger != 'post_deploy_verification')
`);
console.log(`Total leads with phantom sends in last 7 days: ${countRow[0].total_affected_leads}`);

// Top 10 by phantom count
const [rows] = await conn.execute(`
  SELECT 
    l.id, l.name, l.phone, l.email, 
    l.reactivationCount, l.cadencePosition, l.pipelineStage,
    DATE_FORMAT(l.createdAt, '%Y-%m-%d') as createdAt,
    COUNT(s.id) as phantom_send_attempts
  FROM leads l
  JOIN send_attempts s ON s.leadId = l.id
  WHERE s.outcomeKind = 'phantom'
    AND s.attemptedAt > NOW() - INTERVAL 7 DAY
    AND s.leadId != -1
    AND (s.trigger IS NULL OR s.trigger != 'post_deploy_verification')
  GROUP BY l.id
  ORDER BY phantom_send_attempts DESC
  LIMIT 10
`);

console.log("\nTop 10 by phantom count:");
console.log("id       | name                          | phone        | stage           | react | cadence | phantoms | created");
for (const r of rows) {
  const phone = r.phone ? r.phone.substring(0, 12) : "no-phone";
  const name = (r.name || "unknown").substring(0, 28).padEnd(28);
  const stage = (r.pipelineStage || "?").substring(0, 15).padEnd(15);
  console.log(`${String(r.id).padEnd(8)} | ${name} | ${phone.padEnd(12)} | ${stage} | ${r.reactivationCount}     | ${r.cadencePosition}       | ${r.phantom_send_attempts}        | ${r.createdAt}`);
}

// Distribution: how many leads have 1 phantom vs 2+ vs 3+
const [dist] = await conn.execute(`
  SELECT phantom_count, COUNT(*) as lead_count
  FROM (
    SELECT l.id, COUNT(s.id) as phantom_count
    FROM leads l
    JOIN send_attempts s ON s.leadId = l.id
    WHERE s.outcomeKind = 'phantom'
      AND s.attemptedAt > NOW() - INTERVAL 7 DAY
      AND s.leadId != -1
      AND (s.trigger IS NULL OR s.trigger != 'post_deploy_verification')
    GROUP BY l.id
  ) sub
  GROUP BY phantom_count
  ORDER BY phantom_count
`);
console.log("\nPhantom count distribution:");
for (const d of dist) {
  console.log(`  ${d.phantom_count} phantom(s): ${d.lead_count} leads`);
}

await conn.end();
