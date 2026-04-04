import mysql from 'mysql2/promise';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }

const url = new URL(DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: parseInt(url.port || '3306'),
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: true },
});

const statements = [
  "ALTER TABLE `ai_state` ADD `lastQcScore` int",
  "ALTER TABLE `ai_state` ADD `lastStrategyApproach` varchar(32)",
  "ALTER TABLE `ai_state` ADD `lastResearchSummary` text",
  "ALTER TABLE `ai_state` ADD `consecutiveRejects` int DEFAULT 0",
  "ALTER TABLE `leads` ADD `cadencePosition` int DEFAULT 0",
  "ALTER TABLE `leads` ADD `reactivationCount` int DEFAULT 0",
  "ALTER TABLE `leads` ADD `lastReactivationAt` timestamp NULL",
  "ALTER TABLE `leads` ADD `lastSeasonalPushAt` timestamp NULL",
  "ALTER TABLE `leads` ADD `seasonalSegment` varchar(64)",
  "ALTER TABLE `leads` ADD `lastScoreDecayAt` timestamp NULL",
  "ALTER TABLE `leads` ADD `baseScore` int DEFAULT 50",
  "ALTER TABLE `leads` ADD `overrideBy` varchar(128)",
  "ALTER TABLE `leads` ADD `overrideAt` timestamp NULL",
  "ALTER TABLE `leads` ADD `overrideReason` text",
  "ALTER TABLE `leads` ADD `lastQcScore` int",
  "ALTER TABLE `leads` ADD `lastStrategyReasoning` text",
  "ALTER TABLE `leads` ADD `lastResearchSummary` text",
  "ALTER TABLE `leads` ADD `preferredChannel` varchar(32)",
  "ALTER TABLE `leads` ADD `lastOutboundChannel` varchar(32)",
];

let success = 0;
let skipped = 0;
for (const sql of statements) {
  try {
    await conn.execute(sql);
    success++;
    console.log(`✅ ${sql.substring(0, 60)}...`);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      skipped++;
      console.log(`⏭️  Column already exists: ${sql.substring(0, 60)}...`);
    } else {
      console.error(`❌ ${sql.substring(0, 60)}... — ${err.message}`);
    }
  }
}

console.log(`\nDone: ${success} applied, ${skipped} skipped (already exist)`);
await conn.end();
