/**
 * Diagnose phantom option A/B/C:
 * Count outbound AI conversation rows per lead for the 3 sample leads
 * and cross-reference with send_attempts phantom count.
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Sample 3 leads from the phantom batch
console.log("=== Conv count for sample leads (1020023, 1020045, 5070097) ===");
const [rows] = await conn.execute(`
  SELECT 
    c.leadId, 
    l.name,
    COUNT(*) as conv_count,
    GROUP_CONCAT(c.id ORDER BY c.id) as conv_ids,
    GROUP_CONCAT(IFNULL(c.ghlMessageId, 'NULL') ORDER BY c.id) as message_ids,
    MAX(CASE WHEN c.ghlMessageId IS NOT NULL AND c.ghlMessageId != '' THEN 1 ELSE 0 END) as has_valid_id,
    (SELECT COUNT(*) FROM send_attempts s WHERE s.leadId = c.leadId AND s.attemptedAt > '2026-05-19 16:36:00') as phantom_count
  FROM conversations c
  JOIN leads l ON l.id = c.leadId
  WHERE c.direction = 'outbound'
    AND c.senderType = 'ai'
    AND c.timestamp > '2026-05-19 16:36:00'
    AND c.leadId IN (1020023, 1020045, 5070097)
  GROUP BY c.leadId, l.name
`);

if (rows.length === 0) {
  console.log("No outbound AI conversation rows found for these leads since 16:36 UTC.");
  console.log("This would indicate Option A or worse — phantom fired but no conv row written.");
} else {
  for (const r of rows) {
    console.log(`\nleadId=${r.leadId} | name=${r.name}`);
    console.log(`  conv_count=${r.conv_count} | has_valid_id=${r.has_valid_id} | phantom_count=${r.phantom_count}`);
    console.log(`  conv_ids: ${r.conv_ids}`);
    console.log(`  message_ids: ${r.message_ids}`);
    
    if (r.conv_count === 1 && r.has_valid_id === 1 && r.phantom_count === 1) {
      console.log(`  → OPTION B: One real write (good messageId) + one diverted phantom. Customer fine.`);
    } else if (r.conv_count >= 2) {
      console.log(`  → OPTION C: Multiple conversation rows — potential duplicate message to customer.`);
    } else if (r.conv_count === 0) {
      console.log(`  → OPTION A: Phantom fired, no conversation row written. Customer may have gotten silence.`);
    } else {
      console.log(`  → INCONCLUSIVE: Unexpected pattern.`);
    }
  }
}

// Also check leads that have phantom rows but no conv row at all
console.log("\n=== Leads with phantom rows but ZERO conv rows since 16:36 UTC ===");
const [orphans] = await conn.execute(`
  SELECT s.leadId, l.name, COUNT(s.id) as phantom_count,
    (SELECT COUNT(*) FROM conversations c 
     WHERE c.leadId = s.leadId AND c.direction = 'outbound' 
     AND c.senderType = 'ai' AND c.timestamp > '2026-05-19 16:36:00') as conv_count
  FROM send_attempts s
  LEFT JOIN leads l ON l.id = s.leadId
  WHERE s.attemptedAt > '2026-05-19 16:36:00'
    AND s.leadId != -1
    AND (s.trigger IS NULL OR s.trigger != 'post_deploy_verification')
  GROUP BY s.leadId, l.name
  HAVING conv_count = 0
  ORDER BY s.leadId
`);

if (orphans.length === 0) {
  console.log("None — all phantom leads have at least one conversation row. Option A ruled out.");
} else {
  console.log(`${orphans.length} leads with phantoms but no conv row:`);
  for (const r of orphans) {
    console.log(`  leadId=${r.leadId} | name=${r.name} | phantom_count=${r.phantom_count}`);
  }
}

await conn.end();
