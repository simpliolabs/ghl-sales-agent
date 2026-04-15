import { createConnection } from "mysql2/promise";
import * as dotenv from "dotenv";
dotenv.config();

const db = await createConnection(process.env.DATABASE_URL);

// Find Paulette
const [leads] = await db.execute(
  'SELECT id, name, businessName, pipelineStage, ghlOpportunityStatus, humanTakeover, consecutiveRejects, nextFollowUpAt, lastEngagedAt FROM leads WHERE name LIKE "%Paulette%" LIMIT 5'
);
console.log("Leads:", JSON.stringify(leads, null, 2));

if (leads.length > 0) {
  const ids = leads.map(l => l.id);
  const placeholders = ids.map(() => "?").join(",");
  
  // Check brain council audit
  const [audit] = await db.execute(
    `SELECT leadId, createdAt, violationCategories, LEFT(composedMessage, 100) as msg, action, qcScore FROM brain_council_audit WHERE leadId IN (${placeholders}) ORDER BY createdAt DESC LIMIT 10`,
    ids
  );
  console.log("\nBrain Council Audit:", JSON.stringify(audit, null, 2));
  
  // Check AI state
  const [state] = await db.execute(
    `SELECT leadId, humanTakeover, consecutiveRejects, processingLockedAt, lastInteractionSummary FROM ai_state WHERE leadId IN (${placeholders})`,
    ids
  );
  console.log("\nAI State:", JSON.stringify(state, null, 2));
}

await db.end();
