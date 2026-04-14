import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get violation breakdown for the last 2 hours
const [breakdown] = await conn.query(`
  SELECT 
    blockReason,
    COUNT(*) as count,
    GROUP_CONCAT(DISTINCT leadName ORDER BY leadName SEPARATOR ', ') as leads
  FROM brain_council_audit
  WHERE blocked = 1
    AND createdAt >= NOW() - INTERVAL 2 HOUR
  GROUP BY blockReason
  ORDER BY count DESC
`);

console.log('=== VIOLATION BREAKDOWN (last 2 hours) ===');
breakdown.forEach(r => {
  console.log(`\n[${r.count}x] ${r.blockReason}`);
  console.log(`  Leads: ${r.leads}`);
});

// Get the full blocked messages with their reasons
const [blocked] = await conn.query(`
  SELECT 
    id, leadName, channel, composedMessage, blockReason, createdAt
  FROM brain_council_audit
  WHERE blocked = 1
    AND createdAt >= NOW() - INTERVAL 2 HOUR
  ORDER BY createdAt DESC
  LIMIT 30
`);

console.log('\n\n=== BLOCKED MESSAGES (last 2 hours) ===');
blocked.forEach(r => {
  console.log(`\n[${new Date(r.createdAt).toISOString()}] ${r.leadName} (${r.channel})`);
  console.log(`  REASON: ${r.blockReason}`);
  console.log(`  MSG: ${(r.composedMessage || '').slice(0, 200)}`);
});

// Overall stats
const [stats] = await conn.query(`
  SELECT 
    COUNT(*) as total,
    SUM(blocked) as blocked,
    SUM(messageSent) as sent,
    ROUND(SUM(blocked) / COUNT(*) * 100, 1) as blockRate
  FROM brain_council_audit
  WHERE createdAt >= NOW() - INTERVAL 2 HOUR
`);
console.log('\n\n=== STATS (last 2 hours) ===');
console.log(JSON.stringify(stats[0], null, 2));

await conn.end();
