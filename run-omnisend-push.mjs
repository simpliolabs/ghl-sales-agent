import { getDb } from "./server/db.ts";
import { leads } from "./drizzle/schema.ts";
import { isNotNull, sql } from "drizzle-orm";
import { pushContactToOmnisend } from "./server/omnisend.ts";

const BATCH_DELAY_MS = 500; // 500ms between pushes to avoid rate limits
const MAX = parseInt(process.env.OMNISEND_MAX || "0") || 99999;

async function main() {
  const db = await getDb();

  // Get all leads with email addresses
  const allLeads = await db.select()
    .from(leads)
    .where(isNotNull(leads.email))
    .limit(MAX);

  console.log(`[Omnisend/Bulk] Found ${allLeads.length} leads with email addresses`);

  let pushed = 0;
  let skipped = 0;
  let errors = 0;

  for (const lead of allLeads) {
    if (!lead.email || !lead.email.includes("@")) {
      skipped++;
      continue;
    }

    // Build tags from segment + pipeline stage + score tier
    const tags = [];
    if (lead.omnisendSegment) tags.push(lead.omnisendSegment);
    if (lead.pipelineStage) tags.push(`stage:${lead.pipelineStage}`);
    if (lead.opportunityScore && lead.opportunityScore >= 80) tags.push("hot_lead");
    else if (lead.opportunityScore && lead.opportunityScore >= 50) tags.push("warm_lead");
    tags.push("bulk_import");

    try {
      await pushContactToOmnisend({
        email: lead.email,
        firstName: lead.firstName || undefined,
        lastName: lead.lastName || undefined,
        phone: lead.phone || undefined,
        tags,
      });
      pushed++;
      if (pushed % 50 === 0) {
        console.log(`[Omnisend/Bulk] Progress: ${pushed} pushed, ${skipped} skipped, ${errors} errors`);
      }
    } catch (err) {
      errors++;
      console.error(`[Omnisend/Bulk] Failed for lead ${lead.id} (${lead.email}):`, err);
    }

    // Rate limit delay
    await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }

  console.log(`[Omnisend/Bulk] Complete: ${pushed} pushed, ${skipped} skipped, ${errors} errors out of ${allLeads.length} total`);
}

main().catch(console.error);
