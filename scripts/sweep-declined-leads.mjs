/**
 * DB SWEEP: Find leads who explicitly declined but are NOT in not_qualified/lost stage.
 * 
 * Scans the conversations table for inbound messages containing decline language,
 * then checks if those leads are still in active pipeline stages.
 * 
 * Usage:
 *   DRY_RUN=1 node scripts/sweep-declined-leads.mjs   # Preview only
 *   node scripts/sweep-declined-leads.mjs               # Apply fixes
 */

import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const DRY_RUN = process.env.DRY_RUN === "1";

const NOT_INTERESTED_PATTERNS = [
  "not interested",
  "do not contact",
  "no longer interested",
  "remove me",
  "remove from",
  "opted out",
  "opt out",
  "unsubscribe",
  "stop contact",
  "not a fit",
  "decided not to",
  "no thanks",
  "please stop",
  "leave me alone",
  "take me off",
  "cancel",
  "not looking",
];

async function main() {
  console.log(`\n=== DECLINED LEAD SWEEP ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"} ===\n`);
  
  const conn = await mysql.createConnection(DATABASE_URL);
  
  try {
    // Find all leads with inbound messages containing decline language
    // that are NOT already in not_qualified or lost stages
    // Use parameterized queries to avoid SQL injection from apostrophes
    const likeParams = NOT_INTERESTED_PATTERNS.map(p => `%${p}%`);
    const likeConditions = NOT_INTERESTED_PATTERNS.map(() => `c.messageBody LIKE ?`).join(" OR ");
    
    const query = `
      SELECT DISTINCT l.id, l.name, l.email, l.phone, l.pipelineStage, l.ghlContactId,
             c.messageBody AS declineMessage, c.timestamp AS declineDate
      FROM leads l
      INNER JOIN conversations c ON c.leadId = l.id
      WHERE c.direction = 'inbound'
        AND c.senderType = 'lead'
        AND (${likeConditions})
        AND l.pipelineStage NOT IN ('not_qualified', 'lost')
      ORDER BY c.timestamp DESC
    `;
    
    const [rows] = await conn.execute(query, likeParams);
    
    console.log(`Found ${rows.length} leads with decline language in active stages:\n`);
    
    if (rows.length === 0) {
      console.log("✅ No misrouted declined leads found. All clear.");
      return;
    }
    
    const seen = new Set();
    const uniqueLeads = [];
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        uniqueLeads.push(row);
      }
    }
    
    console.log(`Unique leads: ${uniqueLeads.length}\n`);
    
    for (const lead of uniqueLeads) {
      const msg = (lead.declineMessage || "").substring(0, 120);
      console.log(`  Lead #${lead.id} | ${lead.name || "Unknown"} | Stage: ${lead.pipelineStage} | Decline: "${msg}"`);
    }
    
    if (DRY_RUN) {
      console.log(`\n🔍 DRY RUN — no changes made. Run without DRY_RUN=1 to apply fixes.`);
      return;
    }
    
    // Apply fixes
    let fixed = 0;
    for (const lead of uniqueLeads) {
      await conn.execute(
        `UPDATE leads SET pipelineStage = 'not_qualified' WHERE id = ?`,
        [lead.id]
      );
      fixed++;
      console.log(`  ✅ Lead #${lead.id} (${lead.name}) → not_qualified`);
    }
    
    console.log(`\n✅ Fixed ${fixed} leads to not_qualified stage.`);
    
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error("Sweep failed:", err);
  process.exit(1);
});
