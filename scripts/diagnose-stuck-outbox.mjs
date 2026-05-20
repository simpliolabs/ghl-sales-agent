import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 1. Check all claimed outbox rows — how long have they been stuck?
console.log("=== Stuck outbox rows (status=claimed) ===");
const [claimed] = await conn.execute(`
  SELECT o.id, o.leadId, l.name, o.outbox_status,
    DATE_FORMAT(o.createdAt, '%Y-%m-%d %H:%i:%s') as createdAt,
    DATE_FORMAT(o.claimedAt, '%Y-%m-%d %H:%i:%s') as claimedAt,
    TIMESTAMPDIFF(MINUTE, o.claimedAt, NOW()) as minutes_stuck,
    o.source, o.error, o.retryCount
  FROM outbox o
  JOIN leads l ON l.id = o.leadId
  WHERE o.outbox_status = 'claimed'
  ORDER BY o.claimedAt ASC
`);
console.log(`Total claimed rows: ${claimed.length}`);
for (const r of claimed) {
  console.log(`outbox=${r.id} | lead=${r.leadId} | ${r.name} | stuck_min=${r.minutes_stuck} | created=${r.createdAt} | claimed=${r.claimedAt} | src=${r.source} | err=${r.error} | retry=${r.retryCount}`);
}

// 2. Check pending outbox rows for the 17 silenced leads
console.log("\n=== Pending outbox rows for silenced leads ===");
const silencedIds = [5160005, 5160001, 5130045, 1059, 1020060, 1021635, 4530026, 1216, 5100001, 4860035, 5010001, 1020069, 5130004, 4980242, 1319, 5100075, 5100080];
const placeholders = silencedIds.map(() => '?').join(',');
const [pending] = await conn.execute(`
  SELECT o.id, o.leadId, l.name, o.outbox_status,
    DATE_FORMAT(o.createdAt, '%Y-%m-%d %H:%i:%s') as createdAt,
    DATE_FORMAT(o.claimedAt, '%Y-%m-%d %H:%i:%s') as claimedAt,
    o.source, o.outbox_status, o.error, o.retryCount
  FROM outbox o
  JOIN leads l ON l.id = o.leadId
  WHERE o.leadId IN (${placeholders})
    AND o.outbox_status IN ('pending', 'claimed')
  ORDER BY o.leadId, o.createdAt DESC
`, silencedIds);
console.log(`Total pending/claimed for silenced leads: ${pending.length}`);
for (const r of pending) {
  console.log(`outbox=${r.id} | lead=${r.leadId} | ${r.name} | status=${r.outbox_status} | created=${r.createdAt} | claimed=${r.claimedAt} | src=${r.source} | err=${r.error} | retry=${r.retryCount}`);
}

// 3. Check outbox worker heartbeat / last activity — look at most recent completed rows
console.log("\n=== Most recent completed outbox rows (last 10) ===");
const [completed] = await conn.execute(`
  SELECT o.id, o.leadId, l.name, o.outbox_status,
    DATE_FORMAT(o.sentAt, '%Y-%m-%d %H:%i:%s') as sentAt,
    DATE_FORMAT(o.createdAt, '%Y-%m-%d %H:%i:%s') as createdAt,
    o.source, o.error
  FROM outbox o
  JOIN leads l ON l.id = o.leadId
  WHERE o.outbox_status IN ('completed', 'failed', 'skipped')
  ORDER BY o.createdAt DESC LIMIT 10
`);
console.log(`Last completed rows:`);
for (const r of completed) {
  console.log(`outbox=${r.id} | lead=${r.leadId} | ${r.name} | status=${r.outbox_status} | sent=${r.sentAt} | created=${r.createdAt} | src=${r.source} | err=${r.error}`);
}

// 4. Check fast_scan / inbound trigger table if it exists
console.log("\n=== Checking for fast_scan or inbound_trigger table ===");
const [tables] = await conn.execute(`
  SELECT TABLE_NAME FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('fast_scan_queue', 'inbound_triggers', 'inbound_queue', 'reply_queue', 'fast_scan')
`);
console.log(`Relevant tables found: ${tables.map(t => t.TABLE_NAME).join(', ') || 'none'}`);

await conn.end();
