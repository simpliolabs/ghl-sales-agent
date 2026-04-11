import { getDb } from "./server/db.ts";
import { leads, conversations, brainCouncilAudit, webhookLogs } from "./drizzle/schema.ts";
import { like, desc, sql } from "drizzle-orm";

const db = await getDb();

// Check if lead exists
const lead = await db.select().from(leads).where(like(leads.name, "%Yagami%")).limit(5);
console.log("=== LEAD ===");
console.log(JSON.stringify(lead.map(l => ({
  id: l.id, name: l.name, email: l.email, phone: l.phone,
  businessName: l.businessName, pipelineStage: l.pipelineStage,
  humanTakeover: l.humanTakeover, assignedAgent: l.assignedAgent,
  source: l.source, nextFollowUpAt: l.nextFollowUpAt,
  lastMessageAt: l.lastMessageAt, lastAiSendAttemptAt: l.lastAiSendAttemptAt,
  processingLockedAt: l.processingLockedAt, createdAt: l.createdAt,
  ghlContactId: l.ghlContactId,
})), null, 2));

if (lead.length > 0) {
  const leadId = lead[0].id;
  
  const convos = await db.select().from(conversations).where(sql`${conversations.leadId} = ${leadId}`).orderBy(desc(conversations.timestamp)).limit(10);
  console.log("\n=== CONVERSATIONS ===");
  console.log(JSON.stringify(convos.map(c => ({
    direction: c.direction, channel: c.channel, messageBody: (c.messageBody || "").substring(0, 150),
    timestamp: c.timestamp
  })), null, 2));
  
  const audits = await db.select().from(brainCouncilAudit).where(sql`${brainCouncilAudit.leadId} = ${leadId}`).orderBy(desc(brainCouncilAudit.createdAt)).limit(5);
  console.log("\n=== BRAIN COUNCIL AUDIT ===");
  console.log(JSON.stringify(audits.map(a => ({
    id: a.id, approach: a.strategyApproach, channel: a.channel,
    framework: a.strategyFramework, qcScore: a.qcScore,
    messageSent: a.messageSent, violationCategory: a.violationCategory,
    qcReason: (a.qcReason || "").substring(0, 200),
    createdAt: a.createdAt,
  })), null, 2));
}

// Recent webhook logs
const recentWebhooks = await db.select().from(webhookLogs)
  .where(sql`${webhookLogs.createdAt} > DATE_SUB(NOW(), INTERVAL 6 HOUR)`)
  .orderBy(desc(webhookLogs.createdAt)).limit(20);
console.log("\n=== RECENT WEBHOOK LOGS (last 6h) ===");
console.log(JSON.stringify(recentWebhooks.map(w => ({
  id: w.id, eventType: w.eventType, action: w.action,
  ghlContactId: w.ghlContactId, error: (w.error || "").substring(0, 150),
  createdAt: w.createdAt,
})), null, 2));

process.exit(0);
