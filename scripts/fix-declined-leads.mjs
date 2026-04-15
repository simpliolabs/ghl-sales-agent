/**
 * Fix 2 confirmed declined leads to not_qualified stage.
 * 
 * Lead #536 (Liani Echagarruga) — "cancelled our order through the owner"
 * Lead #1291 (test12) — "no thanks"
 */

import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const LEADS_TO_FIX = [536, 1291];

async function main() {
  console.log(`\n=== FIXING ${LEADS_TO_FIX.length} DECLINED LEADS ===\n`);
  
  const conn = await mysql.createConnection(DATABASE_URL);
  
  try {
    for (const leadId of LEADS_TO_FIX) {
      // Verify current state
      const [rows] = await conn.execute(
        `SELECT id, name, pipelineStage FROM leads WHERE id = ?`,
        [leadId]
      );
      
      if (rows.length === 0) {
        console.log(`  ⚠️ Lead #${leadId} not found — skipping`);
        continue;
      }
      
      const lead = rows[0];
      console.log(`  Lead #${leadId} (${lead.name}) — current stage: ${lead.pipelineStage}`);
      
      if (lead.pipelineStage === "not_qualified" || lead.pipelineStage === "lost") {
        console.log(`  ✅ Already in terminal stage — no change needed`);
        continue;
      }
      
      await conn.execute(
        `UPDATE leads SET pipelineStage = 'not_qualified' WHERE id = ?`,
        [leadId]
      );
      console.log(`  ✅ → not_qualified`);
    }
    
    console.log(`\n✅ Done.`);
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error("Fix failed:", err);
  process.exit(1);
});
