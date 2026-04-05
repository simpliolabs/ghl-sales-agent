import { getDb } from './server/db.ts';
import { leads, webhookLogs, conversations } from './drizzle/schema.ts';
import { like, eq, desc, or, sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();

  // Bobby Clarner found — id 240002, ghlId 69QiQjof8od7o0GLGAAu
  const leadId = 240002;
  const ghlId = '69QiQjof8od7o0GLGAAu';

  // Check webhook logs for this contact by contactId
  const wh = await db.select().from(webhookLogs).where(eq(webhookLogs.contactId, ghlId)).orderBy(desc(webhookLogs.receivedAt)).limit(10);
  console.log('Webhook logs for Bobby:', wh.length);
  for (const w of wh) {
    console.log('  -', w.id, w.eventType, w.detectedType, w.action, w.error, w.receivedAt, w.payloadSummary?.substring(0, 200));
  }

  // Check conversations
  const convos = await db.select().from(conversations).where(eq(conversations.leadId, leadId)).orderBy(desc(conversations.createdAt)).limit(10);
  console.log('\nConversations:', convos.length);
  for (const c of convos) {
    console.log('  -', c.id, c.direction, c.channel, c.message?.substring(0, 120), c.createdAt);
  }

  // Check all recent webhooks in the last hour
  const recent = await db.select().from(webhookLogs).orderBy(desc(webhookLogs.receivedAt)).limit(20);
  console.log('\nLast 20 webhooks:');
  for (const r of recent) {
    console.log('  -', r.id, r.eventType, r.detectedType, r.contactId, r.action, r.error?.substring(0, 80), r.receivedAt);
  }

  process.exit(0);
}
main();
