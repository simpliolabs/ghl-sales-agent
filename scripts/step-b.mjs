/**
 * Step B: +1h Foundation A real-traffic verification
 * Query send_attempts for real traffic rows since 6adb20a3 publish at 16:36 UTC
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Real traffic rows since publish (not sentinel, not -1 leadId)
const [rows] = await conn.execute(`
  SELECT id, leadId, channel, outcomeKind, reason,
    DATE_FORMAT(attemptedAt, '%Y-%m-%d %H:%i:%s') as attemptedAt,
    \`trigger\`
  FROM send_attempts
  WHERE attemptedAt >= '2026-05-19 16:36:00'
    AND leadId != -1
    AND (\`trigger\` IS NULL OR \`trigger\` != 'post_deploy_verification')
  ORDER BY attemptedAt ASC
  LIMIT 50
`);

console.log(`=== STEP B: Real traffic rows since 16:36 UTC ===`);
console.log(`Count: ${rows.length}`);
if (rows.length > 0) {
  for (const r of rows) {
    console.log(`id=${r.id} | leadId=${r.leadId} | channel=${r.channel} | outcome=${r.outcomeKind} | at=${r.attemptedAt}`);
  }
} else {
  console.log("No real traffic rows yet.");
}

// Also show outcome distribution
const [dist] = await conn.execute(`
  SELECT outcomeKind, COUNT(*) as cnt
  FROM send_attempts
  WHERE attemptedAt >= '2026-05-19 16:36:00'
    AND leadId != -1
    AND (\`trigger\` IS NULL OR \`trigger\` != 'post_deploy_verification')
  GROUP BY outcomeKind
  ORDER BY cnt DESC
`);
console.log("\n=== Outcome distribution ===");
for (const d of dist) {
  console.log(`  ${d.outcomeKind}: ${d.cnt}`);
}

// Total send_attempts count since publish
const [total] = await conn.execute(`
  SELECT COUNT(*) as total
  FROM send_attempts
  WHERE attemptedAt >= '2026-05-19 16:36:00'
    AND (\`trigger\` IS NULL OR \`trigger\` != 'post_deploy_verification')
`);
console.log(`\nTotal rows (including sentinels): ${total[0].total}`);

await conn.end();
