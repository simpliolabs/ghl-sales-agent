import { getDb } from './server/db.ts';
import { sql } from 'drizzle-orm';
const db = await getDb();
const now = Date.now();

// Recent AI sends grouped by hour
const hourly = await db.execute(sql.raw(`
  SELECT 
    FROM_UNIXTIME(lastAiSendAttemptAt/1000, '%Y-%m-%d %H:00') as hour_bucket,
    COUNT(*) as cnt
  FROM leads 
  WHERE lastAiSendAttemptAt > ${now - 48*60*60*1000}
  GROUP BY hour_bucket
  ORDER BY hour_bucket DESC
`));
console.log('AI sends by hour (last 48h):');
for (const h of hourly[0]) {
  console.log('  ' + h.hour_bucket + ' UTC: ' + h.cnt + ' messages');
}

// Check next follow-up times
const nextFollowups = await db.execute(sql.raw(`
  SELECT 
    FROM_UNIXTIME(nextFollowUpAt/1000, '%Y-%m-%d %H:00') as hour_bucket,
    COUNT(*) as cnt
  FROM leads 
  WHERE nextFollowUpAt IS NOT NULL AND humanTakeover = 0
  GROUP BY hour_bucket
  ORDER BY hour_bucket ASC
  LIMIT 20
`));
console.log('\nNext scheduled follow-ups (soonest first):');
for (const h of nextFollowups[0]) {
  console.log('  ' + h.hour_bucket + ' UTC: ' + h.cnt + ' leads');
}

// How many have nextFollowUpAt in the future?
const futureCount = await db.execute(sql.raw(`
  SELECT COUNT(*) as cnt FROM leads WHERE nextFollowUpAt > ${now} AND humanTakeover = 0
`));
console.log('\nLeads with future follow-ups:', futureCount[0][0].cnt);

// How many have nextFollowUpAt in the past?
const pastCount = await db.execute(sql.raw(`
  SELECT COUNT(*) as cnt FROM leads WHERE nextFollowUpAt <= ${now} AND nextFollowUpAt IS NOT NULL AND humanTakeover = 0
`));
console.log('Leads with PAST follow-ups (should be 0 if timer is working):', pastCount[0][0].cnt);

process.exit(0);
