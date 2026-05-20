import { SignJWT } from './node_modules/.pnpm/jose@6.1.0/node_modules/jose/dist/webapi/index.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const JWT_SECRET = process.env.JWT_SECRET;
const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID;
const OWNER_NAME = process.env.OWNER_NAME;
const APP_ID = process.env.VITE_APP_ID || '';
const DB_URL = process.env.DATABASE_URL;

// Parse DB URL and connect directly
const mysql = require('./node_modules/.pnpm/mysql2@3.15.1/node_modules/mysql2/promise.js');
const conn = await mysql.createConnection(DB_URL);

// Get Dmitriy's decision_log
const [rows] = await conn.execute(
  'SELECT id, `trigger`, channel, inputGuardResult, outputGuardResult, durationMs, createdAt FROM decision_log WHERE leadId = 1319 ORDER BY id DESC'
);
console.log('\n=== Dmitriy (lead 1319) decision_log ===');
rows.forEach(r => {
  console.log(`  id=${r.id} trigger=${r.trigger} channel=${r.channel} inputGuard=${r.inputGuardResult} outputGuard=${r.outputGuardResult} dur=${r.durationMs}ms createdAt=${r.createdAt}`);
});

// Get Dmitriy's outbox entries around the incident
const [outbox] = await conn.execute(
  'SELECT id, idemKey, source, outbox_status as status, scheduledAt, sentAt, error, createdAt FROM outbox WHERE leadId = 1319 ORDER BY id DESC LIMIT 10'
);
console.log('\n=== Dmitriy (lead 1319) outbox ===');
outbox.forEach(r => {
  console.log(`  id=${r.id} source=${r.source} status=${r.status} scheduledAt=${r.scheduledAt} sentAt=${r.sentAt} error=${r.error || 'none'} createdAt=${r.createdAt}`);
});

// Get Dmitriy's send_attempts
const [attempts] = await conn.execute(
  'SELECT id, channel, outcomeKind, reason, attemptedAt, `trigger` FROM send_attempts WHERE leadId = 1319 ORDER BY id DESC LIMIT 10' // trigger is reserved word — backtick needed
);
console.log('\n=== Dmitriy (lead 1319) send_attempts ===');
attempts.forEach(r => {
  console.log(`  id=${r.id} channel=${r.channel} outcome=${r.outcomeKind} reason=${r.reason} trigger=${r.trigger} at=${r.attemptedAt}`);
});

// Get Dmitriy's conversations around 5:03-5:06 PM today
const [convos] = await conn.execute(
  'SELECT id, direction, channel, messageBody, senderType, ghlMessageId, timestamp FROM conversations WHERE leadId = 1319 ORDER BY timestamp DESC LIMIT 20'
);
console.log('\n=== Dmitriy (lead 1319) conversations (last 20) ===');
convos.forEach(r => {
  const body = (r.messageBody || '').substring(0, 100);
  console.log(`  id=${r.id} dir=${r.direction} channel=${r.channel} ts=${r.timestamp} sender=${r.senderType} body="${body}"`);
});

await conn.end();
