import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 1. Find the lead
const [leads] = await conn.execute(
  "SELECT id, name, email, phone, source, pipelineStage, preferredChannel, lastOutboundChannel, reactivatedFromMigration, humanTakeover, assignedAgent, createdAt, lastMessageAt, nextFollowUpAt FROM leads WHERE name LIKE '%Gathers%' OR name LIKE '%Mary G%' LIMIT 5"
);
console.log("=== LEAD RECORD ===");
console.log(JSON.stringify(leads, null, 2));

if (leads.length > 0) {
  const leadId = leads[0].id;

  // 2. Get researchData
  const [rd] = await conn.execute(
    "SELECT researchData FROM leads WHERE id = ?", [leadId]
  );
  const researchData = rd[0]?.researchData;
  if (researchData) {
    const parsed = typeof researchData === 'string' ? JSON.parse(researchData) : researchData;
    console.log("\n=== RESEARCH DATA ===");
    console.log("transferredContact:", JSON.stringify(parsed.transferredContact, null, 2));
    console.log("segment:", parsed.segment);
    console.log("customFields:", JSON.stringify(parsed.customFields, null, 2));
  } else {
    console.log("\n=== NO RESEARCH DATA ===");
  }

  // 3. Get recent Brain Council audit entries
  const [audits] = await conn.execute(
    "SELECT id, strategyApproach, strategyFramework, strategyReasoning, researchSummary, composedMessage, qcScore, qcApproved, blocked, blockReason, violationCategory, fallbackUsed, fallbackMessage, createdAt FROM brain_council_audit WHERE leadId = ? ORDER BY id DESC LIMIT 5",
    [leadId]
  );
  console.log("\n=== BRAIN COUNCIL AUDIT (last 5) ===");
  for (const a of audits) {
    console.log(`\n--- Audit #${a.id} (${a.createdAt}) ---`);
    console.log("Approach:", a.strategyApproach, "| Framework:", a.strategyFramework);
    console.log("QC Score:", a.qcScore, "| Approved:", a.qcApproved, "| Blocked:", a.blocked);
    console.log("Block Reason:", a.blockReason || "none");
    console.log("Violation:", a.violationCategory || "none");
    console.log("Fallback:", a.fallbackUsed ? "YES" : "no");
    console.log("Reasoning:", a.strategyReasoning?.substring(0, 500));
    console.log("Research:", a.researchSummary?.substring(0, 300));
    console.log("Message:", a.composedMessage?.substring(0, 500));
    if (a.fallbackMessage) console.log("Fallback Msg:", a.fallbackMessage?.substring(0, 300));
  }

  // 4. Get conversation history
  const [convos] = await conn.execute(
    "SELECT direction, channel, message, createdAt FROM conversations WHERE leadId = ? ORDER BY createdAt DESC LIMIT 10",
    [leadId]
  );
  console.log("\n=== CONVERSATION HISTORY (last 10) ===");
  for (const c of convos) {
    console.log(`[${c.createdAt}] ${c.direction}/${c.channel}: ${c.message?.substring(0, 200)}`);
  }
}

await conn.end();
