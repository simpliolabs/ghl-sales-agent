import 'dotenv/config';
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

async function main() {
  const conn = await mysql.createConnection({
    uri: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    multipleStatements: false,
  });
  const db = drizzle(conn);

  console.log("\n=== PART 3a: Empty body rows in conversations ===");
  const emptyBody = await db.execute(sql`
    SELECT 
      COUNT(*) as empty_body_count,
      direction,
      channel
    FROM conversations
    WHERE (messageBody IS NULL OR messageBody = '')
    GROUP BY direction, channel
    ORDER BY empty_body_count DESC
  `);
  console.log(JSON.stringify(emptyBody[0], null, 2));

  console.log("\n=== PART 3a: Timestamp corruption (year > 2030 or < 2020) ===");
  const tsCorrupt = await db.execute(sql`
    SELECT 
      COUNT(*) as corrupted_count,
      MIN(timestamp) as earliest_corrupt,
      MAX(timestamp) as latest_corrupt
    FROM conversations
    WHERE YEAR(timestamp) > 2030 OR YEAR(timestamp) < 2020
  `);
  console.log(JSON.stringify(tsCorrupt[0], null, 2));

  console.log("\n=== PART 3a: Outbound missing ghlMessageId ===");
  const missingGhlId = await db.execute(sql`
    SELECT 
      COUNT(*) as missing_ghl_id_count,
      channel,
      senderType
    FROM conversations
    WHERE direction = 'outbound'
      AND (ghlMessageId IS NULL OR ghlMessageId = '')
    GROUP BY channel, senderType
    ORDER BY missing_ghl_id_count DESC
  `);
  console.log(JSON.stringify(missingGhlId[0], null, 2));

  console.log("\n=== PART 3b: Pipeline history check — does pipeline_events table exist? ===");
  const pipelineCheck = await db.execute(sql`
    SELECT COUNT(*) as pipeline_event_count FROM pipeline_events LIMIT 1
  `).catch(() => ({ 0: [{ pipeline_event_count: 'TABLE_NOT_FOUND' }] }));
  console.log(JSON.stringify(pipelineCheck[0], null, 2));

  console.log("\n=== PART 3b: Pipeline events sample (if exists) ===");
  const pipelineSample = await db.execute(sql`
    SELECT id, leadId, fromStage, toStage, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') as ts
    FROM pipeline_events
    ORDER BY createdAt DESC LIMIT 10
  `).catch(() => ({ 0: [{ error: 'TABLE_NOT_FOUND' }] }));
  console.log(JSON.stringify(pipelineSample[0], null, 2));

  console.log("\n=== PART 3c: Appointment table check ===");
  const apptCheck = await db.execute(sql`
    SELECT COUNT(*) as appt_count FROM appointments LIMIT 1
  `).catch(() => ({ 0: [{ appt_count: 'TABLE_NOT_FOUND' }] }));
  console.log(JSON.stringify(apptCheck[0], null, 2));

  console.log("\n=== PART 3c: Brenie Wooten (leadId=1365) appointment check ===");
  const brenieLead = await db.execute(sql`
    SELECT id, name, email, phone, pipelineStage, nextAppointmentAt,
           DATE_FORMAT(updatedAt, '%Y-%m-%d %H:%i:%s') as leadUpdatedAt
    FROM leads WHERE id = 1365
  `);
  console.log(JSON.stringify(brenieLead[0], null, 2));

  console.log("\n=== PART 3d: Inbound channel distribution last 30 days ===");
  const channelDist = await db.execute(sql`
    SELECT DISTINCT channel, COUNT(*) as msg_count
    FROM conversations
    WHERE direction = 'inbound'
      AND timestamp > DATE_SUB(NOW(), INTERVAL 30 DAY)
    GROUP BY channel
    ORDER BY msg_count DESC
  `);
  console.log(JSON.stringify(channelDist[0], null, 2));

  console.log("\n=== PART 3e: webhook_logs table — event type distribution last 7 days ===");
  const webhookLogDist = await db.execute(sql`
    SELECT 
      eventType,
      detectedType,
      COUNT(*) as received,
      SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) as processed_ok,
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as failed_count
    FROM webhook_logs
    WHERE receivedAt > DATE_SUB(NOW(), INTERVAL 7 DAY)
    GROUP BY eventType, detectedType
    ORDER BY received DESC
    LIMIT 30
  `).catch(() => ({ 0: [{ error: 'TABLE_NOT_FOUND' }] }));
  console.log(JSON.stringify(webhookLogDist[0], null, 2));

  console.log("\n=== PART 3e: webhook_logs total count ===");
  const webhookLogTotal = await db.execute(sql`
    SELECT COUNT(*) as total_webhook_logs FROM webhook_logs
  `).catch(() => ({ 0: [{ total_webhook_logs: 'TABLE_NOT_FOUND' }] }));
  console.log(JSON.stringify(webhookLogTotal[0], null, 2));

  console.log("\n=== PART 4: Brenie Wooten — all conversations (leadId=1365) ===");
  const brenieCons = await db.execute(sql`
    SELECT id, 
           DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') as ts,
           direction, channel, senderType, 
           LEFT(messageBody, 200) as body_preview, 
           ghlMessageId
    FROM conversations 
    WHERE leadId = 1365
    ORDER BY timestamp ASC
  `);
  console.log(JSON.stringify(brenieCons[0], null, 2));

  console.log("\n=== PART 4: Brenie Wooten — brain_council_audit ===");
  const brenieBCA = await db.execute(sql`
    SELECT id, 
           DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') as ts,
           channel, triggerSource,
           LEFT(finalMessage, 200) as msg_preview,
           sendOutcomeKind
    FROM brain_council_audit
    WHERE leadId = 1365
    ORDER BY createdAt ASC
  `).catch(() => ({ 0: [{ error: 'COLUMN_NOT_FOUND' }] }));
  console.log(JSON.stringify(brenieBCA[0], null, 2));

  console.log("\n=== PART 4: Brenie Wooten — send_attempts ===");
  const brenieSA = await db.execute(sql`
    SELECT id, 
           DATE_FORMAT(attemptedAt, '%Y-%m-%d %H:%i:%s') as ts,
           channel, ghlMessageId, outcomeKind, errorMsg
    FROM send_attempts
    WHERE leadId = 1365
    ORDER BY attemptedAt ASC
  `);
  console.log(JSON.stringify(brenieSA[0], null, 2));

  console.log("\n=== PART 4: Brenie Wooten — outbox rows ===");
  const brenieOutbox = await db.execute(sql`
    SELECT id, idemKey, source, 
           DATE_FORMAT(scheduledAt, '%Y-%m-%d %H:%i:%s') as scheduledAt,
           DATE_FORMAT(sentAt, '%Y-%m-%d %H:%i:%s') as sentAt,
           status as outbox_status, retryCount,
           DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') as created
    FROM outbox WHERE leadId = 1365
    ORDER BY createdAt ASC
  `);
  console.log(JSON.stringify(brenieOutbox[0], null, 2));

  console.log("\n=== PART 4: Brenie Wooten — pipeline_events ===");
  const breniePipeline = await db.execute(sql`
    SELECT * FROM pipeline_events WHERE leadId = 1365 ORDER BY createdAt ASC
  `).catch(() => ({ 0: [{ error: 'TABLE_NOT_FOUND' }] }));
  console.log(JSON.stringify(breniePipeline[0], null, 2));

  console.log("\n=== PART 4: Brenie Wooten — decision_log ===");
  const brenieDecision = await db.execute(sql`
    SELECT id, 
           DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') as ts,
           trigger, channel, inputGuardResult, outputGuardResult,
           LEFT(brainReasoning, 200) as reasoning_preview
    FROM decision_log
    WHERE leadId = 1365
    ORDER BY createdAt ASC
  `).catch(() => ({ 0: [{ error: 'TABLE_NOT_FOUND' }] }));
  console.log(JSON.stringify(brenieDecision[0], null, 2));

  console.log("\n=== PART 4: Brenie Wooten — leads full record ===");
  const brenieLeadFull = await db.execute(sql`
    SELECT * FROM leads WHERE id = 1365
  `);
  console.log(JSON.stringify(brenieLeadFull[0], null, 2));

  await conn.end();
}

main().catch(console.error);
