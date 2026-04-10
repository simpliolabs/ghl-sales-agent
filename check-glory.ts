import { getDb } from "./server/db";
import { webhookLogs, conversations, aiState } from "./drizzle/schema";
import { eq, desc, sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // Check webhook events for Glory
  const events = await db.select().from(webhookLogs)
    .where(eq(webhookLogs.contactId, "o3Kewfk0DkS4pTozWP50"))
    .orderBy(desc(webhookLogs.receivedAt))
    .limit(10);
  
  console.log("=== Webhook Events for Glory ===");
  for (const e of events) {
    console.log(`${e.receivedAt} | ${e.eventType} | ${e.detectedType} | ${e.action} | ${e.error || ""}`);
  }

  // Check conversations for Glory (lead 1040) - use raw SQL to avoid column issues
  const [convs] = await db.execute(sql`
    SELECT id, direction, channel, messageBody, timestamp 
    FROM conversations 
    WHERE leadId = 1040 
    ORDER BY timestamp DESC 
    LIMIT 10
  `);
  
  console.log("\n=== Conversations for Glory (lead 1040) ===");
  for (const c of convs as any[]) {
    console.log(`${c.timestamp} | ${c.direction} | ${c.channel} | ${(c.messageBody||"").substring(0,100)}`);
  }

  // Check AI state for Glory
  const [stateRows] = await db.execute(sql`
    SELECT humanTakeover, humanTakeoverAt, humanTakeoverReason, nextFollowUpAt, 
           consecutiveUnanswered, messageCount, lastOutboundAt, processingLockedAt,
           circuitBroken, paused
    FROM ai_state 
    WHERE leadId = 1040
  `);
  
  console.log("\n=== AI State for Glory (lead 1040) ===");
  const s = (stateRows as any[])[0];
  if (s) {
    for (const [k, v] of Object.entries(s)) {
      console.log(`${k}: ${v}`);
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
