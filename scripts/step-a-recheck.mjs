/**
 * Step A re-verify: confirm c5333bfb is live by checking the latest sentinel row
 * is timestamped AFTER the c5333bfb publish time (~20:09 UTC)
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [rows] = await conn.execute(`
  SELECT id, leadId, channel, outcomeKind, reason,
    DATE_FORMAT(attemptedAt, '%Y-%m-%d %H:%i:%s') as attemptedAt,
    \`trigger\`
  FROM send_attempts
  WHERE \`trigger\` = 'post_deploy_verification'
  ORDER BY id
`);

console.log("=== All post_deploy_verification sentinel rows ===");
for (const r of rows) {
  console.log(`id=${r.id} | ${r.attemptedAt} UTC | ${r.trigger}`);
}

const latest = rows[rows.length - 1];
if (latest && latest.attemptedAt > '2026-05-19 20:09:00') {
  console.log(`\n✅ c5333bfb CONFIRMED LIVE — latest sentinel at ${latest.attemptedAt} UTC (after 20:09 publish)`);
} else {
  console.log(`\n⚠️  Latest sentinel at ${latest?.attemptedAt} — may predate c5333bfb publish`);
}

await conn.end();
