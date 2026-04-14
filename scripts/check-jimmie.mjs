import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Find Jimmie's lead record
const [leads] = await conn.query(
  "SELECT id, ghlContactId, name, businessName, appointmentId, nextAppointmentAt, appointmentStatus, convState FROM leads WHERE name LIKE '%Jimmie%' OR businessName LIKE '%Basoom%' LIMIT 5"
);
console.log('=== Jimmie Lead ===');
console.log(JSON.stringify(leads, null, 2));

if (leads.length > 0) {
  const leadId = leads[0].id;
  const ghlContactId = leads[0].ghlContactId;

  // Get recent brain council audit entries
  const [audits] = await conn.query(
    "SELECT id, composedMessage, finalMessage, channel, qcApproved, qcIssues, blocked, blockReason, messageSent, createdAt FROM brain_council_audit WHERE leadId = ? ORDER BY createdAt DESC LIMIT 10",
    [leadId]
  );
  console.log('\n=== Recent Brain Council Audit ===');
  audits.forEach(a => {
    console.log(`[${a.channel}/${a.qcApproved ? 'QC-PASS' : 'QC-FAIL'}/sent=${a.messageSent}/blocked=${a.blocked}] ${new Date(a.createdAt).toISOString()}`);
    if (a.blockReason) console.log(`  BLOCKED: ${a.blockReason}`);
    const msg = a.finalMessage || a.composedMessage || '';
    console.log(`  MSG: ${msg.slice(0, 250)}`);
  });

  // Get recent webhook events
  const [events] = await conn.query(
    "SELECT id, eventType, payload, createdAt FROM webhook_logs WHERE contactId = ? ORDER BY createdAt DESC LIMIT 10",
    [ghlContactId]
  );
  console.log('\n=== Recent Webhook Events ===');
  events.forEach(e => {
    const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {});
    console.log(`[${e.eventType}] ${new Date(e.createdAt).toISOString()}: ${JSON.stringify(p).slice(0, 250)}`);
  });
}

await conn.end();
