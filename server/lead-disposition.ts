/**
 * LEAD DISPOSITION ENGINE — Periodic sweep that makes decisions on stuck/stale leads
 * 
 * Runs every 2 hours. Evaluates leads that are stuck in limbo and takes action:
 * 
 * 1. DNC LEADS → Move to Not Qualified in GHL pipeline
 *    - Leads with "Stop", "unsubscribe", etc. in conversation history
 *    - Leads with DnD enabled on all channels
 * 
 * 2. STALE TAKEOVER LEADS → Auto-expire humanTakeover when no agent activity
 *    - humanTakeover=1 with NULL lastAgentActivityAt (permanently frozen bug)
 *    - humanTakeover=1 with lastAgentActivityAt older than 7 days
 *    - If lead has email available → reset for email outreach
 *    - If lead has no email → move to Not Qualified
 * 
 * 3. CHANNEL ESCALATION → Try email when SMS is blocked
 *    - Leads with DND on SMS but email available
 *    - Leads with 3+ unanswered SMS attempts but email available
 * 
 * Safeguards:
 * - Max 20 leads per cycle (avoid GHL rate limits)
 * - Only processes leads older than 7 days (don't rush decisions)
 * - Logs every disposition action
 * - Notifies owner on bulk dispositions
 */

import { getDb } from "./db";
import { updateLeadFields, getConversationHistory } from "./db";
import { updateOpportunityStage, addNote, getOpportunitiesByContact } from "./ghl";
import { checkDnc, DNC_KEYWORDS } from "./scheduling-engine";
import { handleChannelDnc, allChannelsExhausted as checkAllExhausted } from "./channel-fallback";
import { leads, conversations } from "../drizzle/schema";
import { eq, and, sql, isNull, lte, or } from "drizzle-orm";
import { notifyOwner } from "./_core/notification";
import { buildJourneyFromLead, recordConversationOutcome } from "./learning-loop";

const MAX_PER_CYCLE = 20;

// GHL "Not Qualified" stage IDs per pipeline
const NOT_QUALIFIED_STAGE_IDS: Record<string, string> = {
  "OpojlMx3cTa0ts0e2pMc": "6f1ca442-4a6b-490f-bf49-95a5870f7f86", // Bulk Printing Pipeline
  "5YIrCvKmzb27yXHP3fBF": "6ca358e4-db09-4818-9896-ab21bad0c0e7", // 100 T-shirt Inquiry
};

interface DispositionStats {
  processed: number;
  dncDisposed: number;
  takeoverExpired: number;
  emailEscalated: number;
  errors: number;
}

/**
 * Move a lead to "Not Qualified" in GHL pipeline and update local DB
 */
async function moveToNotQualified(leadId: number, ghlOpportunityId: string | null, ghlPipelineId: string | null, reason: string): Promise<boolean> {
  try {
    // Update GHL pipeline stage if we have the opportunity ID
    // ALWAYS update local DB first — prevents infinite retry loops
    const nqStageId = (ghlPipelineId && NOT_QUALIFIED_STAGE_IDS[ghlPipelineId]) || null;
    await updateLeadFields(leadId, {
      pipelineStage: "not_qualified",
      ...(nqStageId ? { ghlStageId: nqStageId } : {}),
      humanTakeover: 1, // Keep locked — don't re-engage DNC leads
    });

    // Best-effort GHL pipeline update
    if (ghlOpportunityId && nqStageId) {
      try {
        await updateOpportunityStage(ghlOpportunityId, nqStageId);
        console.log(`[Disposition] Lead ${leadId} → Not Qualified in GHL (reason: ${reason})`);
      } catch (ghlErr: any) {
        console.warn(`[Disposition] Lead ${leadId} → Not Qualified (local DB updated, GHL API failed: ${ghlErr?.message}). Reason: ${reason}`);
      }
    } else {
      console.log(`[Disposition] Lead ${leadId} → Not Qualified (local only) (reason: ${reason})`);
    }

    // Add a note to the lead in GHL
    try {
      const db = await getDb();
      if (db) {
        const [leadRow] = await db.select({ ghlContactId: leads.ghlContactId }).from(leads).where(eq(leads.id, leadId)).limit(1);
        if (leadRow?.ghlContactId) {
          await addNote(leadRow.ghlContactId, `🤖 Auto-Disposition: Moved to Not Qualified\nReason: ${reason}\nTimestamp: ${new Date().toISOString()}`);
        }
      }
    } catch { /* best effort note */ }

    // --- LEARNING LOOP: Record DNC/lost outcome ---
    try {
      const isDnc = reason.toLowerCase().includes('dnc') || reason.toLowerCase().includes('dnd') || reason.toLowerCase().includes('unsubscribe');
      const outcome = isDnc ? 'dnc' as const : 'lost' as const;
      const journey = await buildJourneyFromLead(leadId, outcome, reason);
      if (journey) await recordConversationOutcome(journey);
    } catch (learnErr) {
      console.error('[Disposition/Learn] Outcome recording error (non-fatal):', learnErr);
    }

    return true;
  } catch (err) {
    console.error(`[Disposition] Failed to move lead ${leadId} to Not Qualified:`, err);
    return false;
  }
}

/**
 * Reset a lead for email outreach — clear humanTakeover, set preferredChannel to EMAIL
 */
async function escalateToEmail(leadId: number, reason: string): Promise<boolean> {
  try {
    const nextFollowUp = new Date(Date.now() + 24 * 60 * 60 * 1000); // Schedule for tomorrow
    await updateLeadFields(leadId, {
      humanTakeover: 0,
      preferredChannel: "EMAIL",
      lastOutboundChannel: "EMAIL",
      nextFollowUpAt: nextFollowUp,
      cadencePosition: 0, // Reset cadence for email
    });

    // Add a note
    try {
      const db = await getDb();
      if (db) {
        const [leadRow] = await db.select({ ghlContactId: leads.ghlContactId }).from(leads).where(eq(leads.id, leadId)).limit(1);
        if (leadRow?.ghlContactId) {
          await addNote(leadRow.ghlContactId, `🤖 Auto-Escalation: Switching to EMAIL outreach\nReason: ${reason}\nNext follow-up: ${nextFollowUp.toISOString()}`);
        }
      }
    } catch { /* best effort note */ }

    console.log(`[Disposition] Lead ${leadId} → Email escalation (reason: ${reason})`);
    return true;
  } catch (err) {
    console.error(`[Disposition] Failed to escalate lead ${leadId} to email:`, err);
    return false;
  }
}

/**
 * Main disposition sweep — runs periodically to clean up stuck leads
 */
export async function runDispositionSweep(): Promise<DispositionStats> {
  const stats: DispositionStats = { processed: 0, dncDisposed: 0, takeoverExpired: 0, emailEscalated: 0, errors: 0 };
  const db = await getDb();
  if (!db) return stats;

  try {
    // ================================================================
    // PASS 1: DNC leads still in active pipeline stages
    // Find leads with humanTakeover=1 that have DNC keywords in history
    // and are NOT already in not_qualified stage
    // ================================================================
    const dncCandidates = await db.select({
      id: leads.id,
      name: leads.name,
      ghlContactId: leads.ghlContactId,
      ghlOpportunityId: leads.ghlOpportunityId,
      ghlPipelineId: leads.ghlPipelineId,
      pipelineStage: leads.pipelineStage,
      email: leads.email,
      phone: leads.phone,
      dndSms: leads.dndSms,
      dndEmail: leads.dndEmail,
      dndFb: leads.dndFb,
      dndWhatsapp: leads.dndWhatsapp,
      preferredChannel: leads.preferredChannel,
      lastOutboundChannel: leads.lastOutboundChannel,
    })
      .from(leads)
      .where(and(
        eq(leads.humanTakeover, 1),
        sql`${leads.pipelineStage} != 'not_qualified'`,
        sql`${leads.createdAt} < DATE_SUB(NOW(), INTERVAL 3 DAY)`, // Only leads older than 3 days
      ))
      .limit(MAX_PER_CYCLE * 2); // Fetch more than we need, we'll filter

    for (const candidate of dncCandidates) {
      if (stats.processed >= MAX_PER_CYCLE) break;

      // Check conversation history for DNC keywords
      const history = await getConversationHistory(candidate.id, 20);
      const inboundOnly = history.filter((c: any) => c.direction === "inbound");
      const isDnc = checkDnc(inboundOnly);

      // Also check if ALL channels are DND-blocked
      const allChannelsDnd = candidate.dndSms && candidate.dndEmail;

      if (isDnc) {
        // CHANNEL-SPECIFIC DNC: determine which channel the DNC was on
        // Use last outbound channel as best guess for which channel they opted out of
        const dncChannel = (candidate as any).lastOutboundChannel || (candidate as any).preferredChannel || "SMS";
        const result = await handleChannelDnc(candidate.id, candidate, dncChannel, candidate.ghlContactId);
        stats.processed++;
        if (result.action === "not_qualified") {
          // All channels exhausted — move to Not Qualified
          const success = await moveToNotQualified(candidate.id, candidate.ghlOpportunityId, candidate.ghlPipelineId, `DNC on ${dncChannel} — all channels exhausted`);
          if (success) stats.dncDisposed++;
          else stats.errors++;
        } else {
          // Escalated to another channel
          stats.emailEscalated++;
          console.log(`[Disposition] Lead ${candidate.id}: DNC on ${dncChannel} → escalated to ${result.nextChannel}`);
        }
        continue;
      }

      // Check if ALL channels are DND-blocked (not keyword DNC, but GHL DND flags)
      if (checkAllExhausted(candidate)) {
        const success = await moveToNotQualified(candidate.id, candidate.ghlOpportunityId, candidate.ghlPipelineId, "All channels DND-blocked");
        stats.processed++;
        if (success) stats.dncDisposed++;
        else stats.errors++;
        continue;
      }

      // Not DNC — check if this is a stale takeover that should be escalated
      // (handled in Pass 2 below)
    }

    // ================================================================
    // PASS 2: Stale humanTakeover leads (no agent activity)
    // humanTakeover=1 with NULL lastAgentActivityAt OR lastAgentActivityAt > 7 days ago
    // These leads are permanently frozen — the AI can never resume
    // ================================================================
    const staleTakeoverCandidates = await db.select({
      id: leads.id,
      name: leads.name,
      email: leads.email,
      phone: leads.phone,
      ghlOpportunityId: leads.ghlOpportunityId,
      ghlPipelineId: leads.ghlPipelineId,
      pipelineStage: leads.pipelineStage,
      lastAgentActivityAt: leads.lastAgentActivityAt,
      dndSms: leads.dndSms,
      dndEmail: leads.dndEmail,
      preferredChannel: leads.preferredChannel,
    })
      .from(leads)
      .where(and(
        eq(leads.humanTakeover, 1),
        sql`${leads.pipelineStage} != 'not_qualified'`,
        sql`${leads.createdAt} < DATE_SUB(NOW(), INTERVAL 3 DAY)`,
        or(
          isNull(leads.lastAgentActivityAt),
          lte(leads.lastAgentActivityAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        ),
      ))
      .limit(MAX_PER_CYCLE);

    for (const candidate of staleTakeoverCandidates) {
      if (stats.processed >= MAX_PER_CYCLE) break;

      // Skip if already handled in Pass 1
      // (DNC leads were already moved to not_qualified)

      // First check if they're DNC — if so, move to not_qualified
      const history = await getConversationHistory(candidate.id, 20);
      const inboundOnly = history.filter((c: any) => c.direction === "inbound");
      if (checkDnc(inboundOnly)) {
        const success = await moveToNotQualified(
          candidate.id,
          candidate.ghlOpportunityId,
          candidate.ghlPipelineId,
          "DNC keyword in history + stale takeover"
        );
        stats.processed++;
        if (success) stats.dncDisposed++;
        else stats.errors++;
        continue;
      }

      // Not DNC — check if email escalation is possible
      const hasEmail = candidate.email && candidate.email.trim() !== "";
      const emailNotBlocked = !candidate.dndEmail;
      const smsBlocked = !!candidate.dndSms;
      const alreadyOnEmail = candidate.preferredChannel === "EMAIL";

      if (hasEmail && emailNotBlocked && !alreadyOnEmail) {
        // Escalate to email — the lead has email and it's not blocked
        const reason = smsBlocked
          ? "SMS DND-blocked, escalating to email"
          : "Stale humanTakeover (no agent activity for 7+ days), escalating to email";
        const success = await escalateToEmail(candidate.id, reason);
        stats.processed++;
        if (success) stats.emailEscalated++;
        else stats.errors++;
        continue;
      }

      // No email available or email also blocked — check if truly stale
      if (!candidate.lastAgentActivityAt) {
        // NULL lastAgentActivityAt with humanTakeover=1 — this is the permanent freeze bug
        // If no email available, move to not_qualified
        if (!hasEmail || !emailNotBlocked) {
          const success = await moveToNotQualified(
            candidate.id,
            candidate.ghlOpportunityId,
            candidate.ghlPipelineId,
            "Permanently frozen (humanTakeover=1, no agent activity, no email available)"
          );
          stats.processed++;
          if (success) {
            stats.takeoverExpired++;
          } else {
            stats.errors++;
          }
        } else {
          // Has email — expire the takeover and let the AI try email
          await updateLeadFields(candidate.id, { humanTakeover: 0, preferredChannel: "EMAIL", nextFollowUpAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
          stats.processed++;
          stats.takeoverExpired++;
        }
      }
    }

    // Notify owner if significant dispositions happened
    if (stats.dncDisposed > 0 || stats.emailEscalated > 0 || stats.takeoverExpired > 0) {
      try {
        await notifyOwner({
          title: `Lead Disposition: ${stats.dncDisposed} DNC, ${stats.emailEscalated} email escalated, ${stats.takeoverExpired} takeover expired`,
          content: `Disposition sweep completed:\n- ${stats.dncDisposed} DNC leads moved to Not Qualified\n- ${stats.emailEscalated} leads escalated to email outreach\n- ${stats.takeoverExpired} stale takeovers expired\n- ${stats.errors} errors\n\nTotal processed: ${stats.processed}`,
        });
      } catch { /* best effort notification */ }
    }

  } catch (err) {
    console.error("[Disposition] Fatal error in disposition sweep:", err);
    stats.errors++;
  }

  return stats;
}
