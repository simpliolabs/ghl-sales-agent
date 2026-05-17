import { createConnection } from 'mysql2/promise';
import 'dotenv/config';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

// Parse DATABASE_URL
const url = new URL(DATABASE_URL);
const conn = await createConnection({
  host: url.hostname,
  port: parseInt(url.port) || 3306,
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: false }
});

console.log('=== OUTBOX STATUS COUNTS ===');
const [statusCounts] = await conn.query('SELECT outbox_status, COUNT(*) as cnt FROM outbox GROUP BY outbox_status');
console.table(statusCounts);

console.log('\n=== OUTBOX BY SOURCE + STATUS ===');
const [sourceCounts] = await conn.query('SELECT outbox_status, source, COUNT(*) as cnt FROM outbox GROUP BY outbox_status, source ORDER BY outbox_status, cnt DESC');
console.table(sourceCounts);

console.log('\n=== LAST 10 OUTBOX ENTRIES ===');
const [recentOutbox] = await conn.query('SELECT id, leadId, source, outbox_status, error, retryCount, DATE_FORMAT(createdAt, "%Y-%m-%d %H:%i:%s") as created, DATE_FORMAT(sentAt, "%Y-%m-%d %H:%i:%s") as sent FROM outbox ORDER BY createdAt DESC LIMIT 10');
console.table(recentOutbox);

console.log('\n=== DECISION LOG — LAST 10 ENTRIES ===');
const [recentDecisions] = await conn.query('SELECT id, leadId, `trigger`, promptVersion, channel, inputGuardResult, outputGuardResult, durationMs, DATE_FORMAT(createdAt, "%Y-%m-%d %H:%i:%s") as created FROM decision_log ORDER BY createdAt DESC LIMIT 10');
console.table(recentDecisions);

console.log('\n=== PROMPT_VERSIONS TABLE ===');
const [promptVersions] = await conn.query('SELECT * FROM prompt_versions');
console.table(promptVersions);

console.log('\n=== RECENT BRAIN COUNCIL AUDIT (last 5) ===');
const [recentAudit] = await conn.query('SELECT id, leadId, messageSent, blocked, violationTypes, DATE_FORMAT(createdAt, "%Y-%m-%d %H:%i:%s") as created FROM brain_council_audit ORDER BY createdAt DESC LIMIT 5');
console.table(recentAudit);

console.log('\n=== OUTBOX SENT ENTRIES (last 5) — what actually went out ===');
const [sentEntries] = await conn.query("SELECT id, leadId, source, JSON_EXTRACT(payload, '$.channel') as channel, DATE_FORMAT(sentAt, '%Y-%m-%d %H:%i:%s') as sent FROM outbox WHERE outbox_status='sent' ORDER BY sentAt DESC LIMIT 5");
console.table(sentEntries);

console.log('\n=== OUTBOX FAILED ENTRIES (last 5) ===');
const [failedEntries] = await conn.query("SELECT id, leadId, source, error, retryCount, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') as created FROM outbox WHERE outbox_status='failed' ORDER BY createdAt DESC LIMIT 5");
console.table(failedEntries);

await conn.end();
console.log('\nDone.');
