/**
 * Reset Laura Damian's circuit breaker so AI can resume
 * Run: node scripts/reset-laura.mjs
 */
import mysql from 'mysql2/promise';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

// Parse the URL to extract connection params
const url = new URL(dbUrl);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: parseInt(url.port || '3306'),
  user: url.username,
  password: url.password,
  database: url.pathname.replace('/', ''),
  ssl: { rejectUnauthorized: false },
});

console.log('Connected to DB');

// Find Laura
const [lauraRows] = await conn.execute(
  'SELECT id, name, humanTakeover, consecutiveRejects, processingLockedAt, nextFollowUpAt FROM leads WHERE name LIKE "%laura%" LIMIT 10'
);
console.log('Laura leads:', JSON.stringify(lauraRows, null, 2));

// Reset circuit breaker for lead 720001
const [result] = await conn.execute(
  'UPDATE leads SET humanTakeover=0, consecutiveRejects=0, processingLockedAt=NULL WHERE id=720001'
);
console.log('Reset result:', result);

// Also reset Tom Retherford (lead 690002) which also got circuit-broken
const [tomRows] = await conn.execute(
  'SELECT id, name, humanTakeover, consecutiveRejects FROM leads WHERE id=690002'
);
console.log('Tom Retherford:', JSON.stringify(tomRows));

// Verify Laura
const [after] = await conn.execute(
  'SELECT id, name, humanTakeover, consecutiveRejects, processingLockedAt FROM leads WHERE id=720001'
);
console.log('After reset:', JSON.stringify(after, null, 2));

// Also check for any other leads with circuit breaker active (humanTakeover=1 AND consecutiveRejects>=4)
const [cbLeads] = await conn.execute(
  'SELECT id, name, humanTakeover, consecutiveRejects FROM leads WHERE humanTakeover=1 AND consecutiveRejects>=4 LIMIT 20'
);
console.log('Other circuit-broken leads:', JSON.stringify(cbLeads, null, 2));

await conn.end();
console.log('Done');
