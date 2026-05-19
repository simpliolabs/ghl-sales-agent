/**
 * Phantom diagnosis: queries B and C
 * B: payload from send_attempts id=30004
 * C: 7-day historical null-ID baseline from conversations
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Query B: full payload from the first phantom row
console.log("=== QUERY B: Payload from send_attempts id=30004 ===");
const [rowB] = await conn.execute(`
  SELECT id, leadId, channel, outcomeKind, reason, payload,
    DATE_FORMAT(attemptedAt, '%Y-%m-%d %H:%i:%s') as attemptedAt
  FROM send_attempts
  WHERE id = 30004
  LIMIT 1
`);
if (rowB.length > 0) {
  const r = rowB[0];
  console.log(`id=${r.id} | leadId=${r.leadId} | channel=${r.channel} | outcome=${r.outcomeKind}`);
  console.log(`reason: ${r.reason}`);
  console.log(`payload (raw):`);
  try {
    const parsed = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(r.payload);
  }
} else {
  console.log("Row not found.");
}

// Also pull a few more payloads to see if they're consistent
console.log("\n=== QUERY B2: Payloads from rows 30006 and 30021 ===");
const [rowsB2] = await conn.execute(`
  SELECT id, leadId, reason, payload
  FROM send_attempts
  WHERE id IN (30006, 30021)
`);
for (const r of rowsB2) {
  console.log(`\nid=${r.id} | leadId=${r.leadId}`);
  console.log(`reason: ${r.reason}`);
  try {
    const parsed = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(r.payload);
  }
}

// Query C: 7-day historical null-ID baseline
console.log("\n=== QUERY C: 7-day historical null-ID baseline (pre-Foundation-A) ===");
const [rowsC] = await conn.execute(`
  SELECT 
    DATE(timestamp) as day,
    COUNT(*) as total_outbound_ai,
    SUM(CASE WHEN ghlMessageId IS NULL OR ghlMessageId = '' THEN 1 ELSE 0 END) as null_id_count,
    ROUND(100.0 * SUM(CASE WHEN ghlMessageId IS NULL OR ghlMessageId = '' THEN 1 ELSE 0 END) / COUNT(*), 1) as null_pct
  FROM conversations
  WHERE direction = 'outbound' 
    AND senderType = 'ai'
    AND timestamp BETWEEN DATE_SUB('2026-05-19 16:36:00', INTERVAL 7 DAY) AND '2026-05-19 16:36:00'
  GROUP BY DATE(timestamp)
  ORDER BY day DESC
`);
if (rowsC.length > 0) {
  console.log("day          | total_ai | null_id | null_pct");
  for (const r of rowsC) {
    console.log(`${r.day} | ${r.total_outbound_ai}        | ${r.null_id_count}       | ${r.null_pct}%`);
  }
} else {
  console.log("No historical data found.");
}

// Also get today's post-Foundation-A rate for comparison
console.log("\n=== Post-Foundation-A (since 16:36 UTC today) ===");
const [rowsD] = await conn.execute(`
  SELECT 
    COUNT(*) as total_outbound_ai,
    SUM(CASE WHEN ghlMessageId IS NULL OR ghlMessageId = '' THEN 1 ELSE 0 END) as null_id_count
  FROM conversations
  WHERE direction = 'outbound' 
    AND senderType = 'ai'
    AND timestamp >= '2026-05-19 16:36:00'
`);
if (rowsD.length > 0) {
  const r = rowsD[0];
  console.log(`total_ai=${r.total_outbound_ai} | null_id=${r.null_id_count}`);
}

await conn.end();
