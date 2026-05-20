const mysql = require('../node_modules/mysql2/promise');

async function run() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  const [rows] = await conn.query(
    `SELECT id, DATE_FORMAT(createdAt, '%H:%i:%s') as ts, decisionType, triggerSource, outputGuardResult, blockReason
     FROM decision_log
     WHERE leadId = 4860035
       AND createdAt BETWEEN '2026-05-18 13:50:00' AND '2026-05-18 13:56:00'
     ORDER BY createdAt`
  );
  console.log('=== decision_log ===');
  if (rows.length === 0) {
    console.log('No rows');
  } else {
    rows.forEach(r => console.log(JSON.stringify(r)));
  }

  const [orows] = await conn.query(
    `SELECT id, DATE_FORMAT(createdAt, '%H:%i:%s') as ts, source, outbox_status, idemKey, err
     FROM outbox
     WHERE leadId = 4860035
       AND createdAt BETWEEN '2026-05-18 13:50:00' AND '2026-05-18 13:56:00'
     ORDER BY createdAt`
  );
  console.log('=== outbox ===');
  if (orows.length === 0) {
    console.log('No rows');
  } else {
    orows.forEach(r => console.log(JSON.stringify(r)));
  }

  const [crows] = await conn.query(
    `SELECT id, DATE_FORMAT(createdAt, '%H:%i:%s') as ts, direction, senderType, ghlMessageId, SUBSTRING(body,1,120) as body
     FROM conversations
     WHERE leadId = 4860035
       AND createdAt BETWEEN '2026-05-18 13:50:00' AND '2026-05-18 13:56:00'
     ORDER BY createdAt`
  );
  console.log('=== conversations ===');
  if (crows.length === 0) {
    console.log('No rows');
  } else {
    crows.forEach(r => console.log(JSON.stringify(r)));
  }

  await conn.end();
}

run().catch(e => { console.error(e); process.exit(1); });
