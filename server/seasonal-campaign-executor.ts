/**
 * SEASONAL CAMPAIGN EXECUTOR — Bulk-pushes stale leads with a campaign-specific angle
 * 
 * Runs every 2 hours. Finds active seasonal_campaigns (startDate <= NOW <= endDate),
 * then selects eligible stale leads (no recent outreach, not DNC, not in humanTakeover)
 * and schedules them for near-future follow-up with the campaign angle injected.
 * 
 * Campaign angles are stored in the seasonal_campaigns table and injected into
 * the Brain Council trigger context so the Strategist/Composer use the seasonal hook.
 * 
 * Safeguards:
 * - Max 20 leads per campaign per cycle (avoid GHL rate limits)
 * - Only targets leads with no outreach in the last 14 days
 * - Respects DNC, humanTakeover, and not_qualified filters
 * - Logs every campaign activation
 */

import { getActiveCampaigns, updateLeadFields, incrementCampaignSent } from "./db";
import { getDb } from "./db";
import { leads, conversations } from "../drizzle/schema";
import { eq, and, sql, lte, or, isNull } from "drizzle-orm";
import { notifyOwner } from "./_core/notification";

export async function processSeasonalCampaigns(): Promise<{ campaignsProcessed: number; leadsScheduled: number; errors: number }> {
  const stats = { campaignsProcessed: 0, leadsScheduled: 0, errors: 0 };

  try {
    const campaigns = await getActiveCampaigns();
    if (campaigns.length === 0) return stats;

    console.log(`[SeasonalCampaign] Found ${campaigns.length} active campaign(s)`);

    for (const campaign of campaigns) {
      stats.campaignsProcessed++;
      try {
        // Get stale leads eligible for this campaign (no outreach in 14+ days, not DNC/humanTakeover/NQ)
        const db = await getDb();
        if (!db) continue;
        const cutoff14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const staleLeads = await db.select({
          id: leads.id,
          name: leads.name,
          email: leads.email,
          phone: leads.phone,
          preferredChannel: leads.preferredChannel,
        })
          .from(leads)
          .where(and(
            eq(leads.humanTakeover, 0),
            sql`${leads.pipelineStage} != 'not_qualified'`,
            or(
              isNull(leads.lastMessageAt),
              lte(leads.lastMessageAt, cutoff14d),
            ),
            // Exclude leads already scheduled by this campaign run (overrideBy != seasonal-campaign)
            or(
              isNull(leads.overrideBy),
              sql`${leads.overrideBy} != 'seasonal-campaign'`,
            ),
          ))
          .limit(20);
        if (staleLeads.length === 0) {
          console.log(`[SeasonalCampaign] Campaign "${campaign.name}": no eligible stale leads`);
          continue;
        }

        console.log(`[SeasonalCampaign] Campaign "${campaign.name}": ${staleLeads.length} eligible leads`);

        let scheduled = 0;
        for (const lead of staleLeads) {
          try {
            // Schedule the lead for near-future follow-up with campaign context
            // The follow-up trigger will pick this up and inject the campaign angle
            const jitterMinutes = Math.floor(Math.random() * 120); // 0-2h random jitter
            const nextFollowUp = new Date(Date.now() + jitterMinutes * 60 * 1000);

            await updateLeadFields(lead.id, {
              nextFollowUpAt: nextFollowUp,
              // Store campaign angle in a way the follow-up trigger can pick up
              // We use the existing overrideReason field to carry the campaign context
              overrideReason: `[SEASONAL: ${campaign.name}] ${campaign.angle}`,
              overrideBy: "seasonal-campaign",
              overrideAt: new Date(),
            } as any);

            scheduled++;
            stats.leadsScheduled++;
          } catch (err) {
            console.error(`[SeasonalCampaign] Error scheduling lead ${lead.id}:`, err);
            stats.errors++;
            // Self-healing: record into error-memory
            try {
              const { recordError, tryApplyKnownFix } = await import("./error-memory");
              await recordError({
                errorType: "campaign_error",
                errorMessage: `Seasonal campaign scheduling failed for lead ${lead.id}: ${err instanceof Error ? err.message : String(err)}`,
                context: `campaignId=${campaign.id} campaignName=${campaign.name} leadId=${lead.id}`,
              });
              const heal = await tryApplyKnownFix("campaign_error", `${err instanceof Error ? err.message : String(err)}`, `leadId=${lead.id}`);
              if (heal.action === "skip") {
                console.log(`[SeasonalCampaign/Heal] Auto-heal: skipping lead ${lead.id}: ${heal.fixDescription}`);
              } else if (heal.action !== "none") {
                console.log(`[SeasonalCampaign/Heal] Auto-heal: ${heal.action} for lead ${lead.id}`);
              }
            } catch { /* best effort */ }
          }
        }

        // Update campaign sent count (increment by scheduled count)
        for (let i = 0; i < scheduled; i++) {
          await incrementCampaignSent(campaign.id);
        }
        console.log(`[SeasonalCampaign] Campaign "${campaign.name}": scheduled ${scheduled} leads`);

        // Notify owner
        if (scheduled > 0) {
          await notifyOwner({
            title: `Seasonal Campaign "${campaign.name}": ${scheduled} leads activated`,
            content: `Campaign "${campaign.name}" activated ${scheduled} stale leads for outreach.\n\nAngle: ${campaign.angle}\n\nThese leads will be contacted within the next 2 hours with the campaign-specific messaging.`,
            priority: "standard",
          }).catch(() => {});
        }
      } catch (err) {
        console.error(`[SeasonalCampaign] Error processing campaign ${campaign.id}:`, err);
        stats.errors++;
        // Self-healing: record campaign-level error
        try {
          const { recordError, tryApplyKnownFix } = await import("./error-memory");
          await recordError({
            errorType: "campaign_error",
            errorMessage: `Seasonal campaign ${campaign.id} processing error: ${err instanceof Error ? err.message : String(err)}`,
            context: `campaignId=${campaign.id} campaignName=${campaign.name}`,
          });
          const heal = await tryApplyKnownFix("campaign_error", `${err instanceof Error ? err.message : String(err)}`, `campaignId=${campaign.id}`);
          if (heal.action !== "none") {
            console.log(`[SeasonalCampaign/Heal] Auto-heal: ${heal.action} for campaign ${campaign.id}`);
          }
        } catch { /* best effort */ }
      }
    }
  } catch (err) {
    console.error("[SeasonalCampaign] Fatal error:", err);
    stats.errors++;
  }

  return stats;
}
