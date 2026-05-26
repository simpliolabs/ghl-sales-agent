import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

async function main() {
  const db = drizzle(process.env.DATABASE_URL!);

  // A.5 Step C — send_attempts has no conversationId/ghlMessageId.
  // Best available proxy: outbound AI conversations in last 24h that have NO
  // send_attempts row for the same leadId within ±60 seconds of the conversation timestamp.
  // This catches the timeout-path ghost sends (no audit row at all for that lead+time).
  const unauditedRows = await db.execute(sql`
    SELECT 
      c.id as conv_id,
      c.leadId,
      DATE_FORMAT(c.timestamp, '%Y-%m-%d %H:%i:%s') as ts,
      c.ghlMessageId,
      (SELECT COUNT(*) FROM send_attempts sa 
       WHERE sa.leadId = c.leadId 
         AND sa.attemptedAt BETWEEN DATE_SUB(c.timestamp, INTERVAL 60 SECOND) 
                                AND DATE_ADD(c.timestamp, INTERVAL 60 SECOND)
      ) as nearby_attempt_rows,
      (SELECT COUNT(*) FROM brain_council_audit bca 
       WHERE bca.leadId = c.leadId 
         AND bca.createdAt BETWEEN DATE_SUB(c.timestamp, INTERVAL 120 SECOND) 
                               AND DATE_ADD(c.timestamp, INTERVAL 120 SECOND)
      ) as nearby_audit_rows
    FROM conversations c
    WHERE c.direction = 'outbound' 
      AND c.senderType = 'ai'
      AND c.timestamp > DATE_SUB(NOW(), INTERVAL 24 HOUR)
    ORDER BY c.timestamp DESC
    LIMIT 50
  `);

  // A.5 Step C — denominator
  const totalOutbound = await db.execute(sql`
    SELECT COUNT(*) as total_outbound_24h
    FROM conversations 
    WHERE direction = 'outbound' AND senderType = 'ai'
      AND timestamp > DATE_SUB(NOW(), INTERVAL 24 HOUR)
  `);

  // C.3 Step C — fabricated infrastructure language
  const c3Rows = await db.execute(sql`
    SELECT 
      c.id,
      c.leadId,
      DATE_FORMAT(c.timestamp, '%Y-%m-%d %H:%i:%s') as ts,
      c.messageBody
    FROM conversations c
    WHERE c.direction = 'outbound' 
      AND c.senderType = 'ai'
      AND c.timestamp > DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND (
        c.messageBody REGEXP '(calendar invite|appointment.{0,20}(confirm|scheduled|set up)|booked.{0,20}(call|meeting|appointment))'
        OR c.messageBody LIKE '%saved your%appointment%'
        OR c.messageBody LIKE '%your appointment%confirm%'
        OR c.messageBody LIKE '%got you on the%calendar%'
      )
    ORDER BY c.timestamp DESC
  `);

  // Schema 3a: MySQL version
  const mysqlVersion = await db.execute(sql`SELECT VERSION() as version`);

  // Schema 3b: outbox columns
  const outboxDesc = await db.execute(sql`DESCRIBE outbox`);

  // Schema 3c: outbox unique index
  const outboxIndex = await db.execute(sql`SHOW INDEXES FROM outbox WHERE Key_name = 'unique_lead_idem'`);

  // Schema 3d: sent_messages table
  const sentMsgTable = await db.execute(sql`SHOW TABLES LIKE 'sent_messages'`);

  // Schema 3e: lock and audit tables
  const composeLockTable = await db.execute(sql`SHOW TABLES LIKE 'lead_compose_lock'`);
  const stateLogTable = await db.execute(sql`SHOW TABLES LIKE 'leadStateLog'`);

  // Schema 3f: conversations.ghlMessageId index
  const ghlMsgIdIndex = await db.execute(sql`SHOW INDEXES FROM conversations WHERE Column_name = 'ghlMessageId'`);

  // Schema 3g: leads columns
  const leadsDesc = await db.execute(sql`DESCRIBE leads`);

  // Schema 3h: firstContactSentAt victim candidates
  // Check if column exists first
  let victimCandidates: any;
  try {
    victimCandidates = await db.execute(sql`
      SELECT COUNT(*) as victim_candidates
      FROM leads l
      LEFT JOIN conversations c ON c.leadId = l.id 
        AND c.direction = 'outbound' AND c.senderType = 'ai'
      WHERE l.firstContactSentAt IS NOT NULL
        AND c.id IS NULL
    `);
  } catch {
    victimCandidates = [[{ victim_candidates: 'COLUMN_NOT_FOUND' }]];
  }

  console.log(JSON.stringify({
    a5_unaudited: (unauditedRows as any)[0],
    a5_total: (totalOutbound as any)[0],
    c3_matches: (c3Rows as any)[0],
    schema_version: (mysqlVersion as any)[0],
    schema_outbox: (outboxDesc as any)[0],
    schema_outbox_index: (outboxIndex as any)[0],
    schema_sent_messages: (sentMsgTable as any)[0],
    schema_compose_lock: (composeLockTable as any)[0],
    schema_state_log: (stateLogTable as any)[0],
    schema_ghlmsgid_index: (ghlMsgIdIndex as any)[0],
    schema_leads: (leadsDesc as any)[0],
    schema_victims: (victimCandidates as any)[0],
  }, null, 2));
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
