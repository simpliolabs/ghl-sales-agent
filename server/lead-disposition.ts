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
 *    - humanTakeover=1 with lastAgentActivityAt older than 24 HOURS (was 7 days)
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

import { NOT_QUALIFIED_STAGE_IDS, getNqStageId } from "../shared/ghl-stages";

interface DispositionStats {
  processed: number;
  dncDisposed: number;
  takeoverExpired: number;
  emailEscalated: number;
  staleRecorded: number;
  errors: number;
}

/**
 * Move a lead to "Not Qualified" in GHL pipeline and update local DB
 */
async function moveToNotQualified(leadId: number, ghlOpportunityId: string | null, ghlPipelineId: string | null, reason: string): Promise<boolean> {
  try {
    // Update GHL pipeline stage if we have the opportunity ID
    // ALWAYS update local DB first — prevents infinite retry loops
    const nqStageId = getNqStageId(ghlPipelineId);
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
  const stats: DispositionStats = { processed: 0, dncDisposed: 0, takeoverExpired: 0, emailEscalated: 0, staleRecorded: 0, errors: 0 };
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
        // NOTE: Removed 3-day age filter — the 24hr agent inactivity window is sufficient
        // to prevent premature release of fresh leads. Previously this blocked leads
        // younger than 3 days from stale takeover processing (e.g. lead #690005).
        or(
          isNull(leads.lastAgentActivityAt),
          lte(leads.lastAgentActivityAt, new Date(Date.now() - 24 * 60 * 60 * 1000)) // 24hr timeout
        ),
      ))
      .limit(MAX_PER_CYCLE);

    for (const candidate of staleTakeoverCandidates) {
      if (stats.processed >= MAX_PER_CYCLE) break;

      // Skip if already handled in Pass 1
      // (DNC leads were already moved to not_qualified)

      // ─── CIRCUIT BREAKER GUARD ─────────────────────────────────────────────
      // If this humanTakeover was set by the circuit breaker (3 consecutive QC
      // failures), do NOT auto-release it. The owner must manually review and
      // reset consecutiveRejects before re-enabling AI for this lead.
      // We detect this by checking for a circuit breaker audit in the last 7 days.
      try {
        const cbResult = await db.execute(sql`
          SELECT COUNT(*) as cnt FROM brain_council_audit
          WHERE leadId = ${candidate.id}
            AND violationCategory = 'safety_violation'
            AND blockReason LIKE '%Circuit breaker%'
            AND createdAt > DATE_SUB(NOW(), INTERVAL 7 DAY)
        `);
        const cbCount = Number(((cbResult as any[])[0] as any[])[0]?.cnt || 0);
        if (cbCount > 0) {
          console.log(`[Disposition] Lead ${candidate.id} → SKIPPED stale takeover release — circuit breaker set this humanTakeover (${cbCount} CB audits in 7d). Requires manual review.`);
          stats.processed++;
          continue;
        }
      } catch (cbErr) {
        console.error(`[Disposition] Circuit breaker guard check failed for lead ${candidate.id} (non-fatal):`, cbErr);
        // Fail SAFE: if we can't check, don't release
        stats.processed++;
        continue;
      }
      // ─────────────────────────────────────────────────────────────────────────

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
          : "Stale humanTakeover (no agent activity for 24+ hours), escalating to email";
        const success = await escalateToEmail(candidate.id, reason);
        stats.processed++;
        if (success) stats.emailEscalated++;
        else stats.errors++;
        continue;
      }

      // No email available or email also blocked — release takeover and reschedule
      if (!candidate.lastAgentActivityAt) {
        // NULL lastAgentActivityAt with humanTakeover=1 — this is the permanent freeze bug
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
      } else {
        // HAS lastAgentActivityAt but it's >24hr old — agent went silent
        // Release takeover and reschedule for near-future AI follow-up
        // If agent was on FB/IG, AI can try email/SMS as a support role
        const agentChannel = candidate.preferredChannel || "SMS";
        const useEmail = hasEmail && emailNotBlocked && (agentChannel === "FB" || agentChannel === "IG" || alreadyOnEmail);
        const newChannel = useEmail ? "EMAIL" : (candidate.preferredChannel || "SMS");
        await updateLeadFields(candidate.id, {
          humanTakeover: 0,
          preferredChannel: newChannel,
          nextFollowUpAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2hr from now
        });
        console.log(`[Disposition] Lead ${candidate.id} → Released stale takeover (agent silent >24hr), channel: ${newChannel}, next follow-up in 2hr`);
        stats.processed++;
        stats.takeoverExpired++;
      }
    }

    // ─── PASS 4: AUTO-STALE OUTCOME RECORDING ───
    // Detect leads with 3+ AI outbound messages, 0 inbound replies, oldest outbound > 14 days
    // Record as "stale" outcome for the learning loop to analyze
    try {
      const STALE_THRESHOLD_DAYS = 14;
      const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
      const staleLeads = await db.select({
        id: leads.id,
        ghlContactId: leads.ghlContactId,
      })
        .from(leads)
        .where(and(
          // Not already in terminal state
          sql`${leads.pipelineStage} NOT IN ('not_qualified', 'Not Qualified', 'Lost', 'delivered', 'Delivered', 'completed', 'Completed')`,
          // Has been around for a while
          sql`${leads.createdAt} < ${staleThreshold}`,
          // Not already recorded as stale
          sql`${leads.id} NOT IN (
            SELECT DISTINCT leadId
            FROM conversation_outcomes
            WHERE outcome = 'stale'
          )`,
        ))
        .limit(20); // Cap per cycle

      for (const staleLead of staleLeads) {
        try {
          // Verify: 3+ AI outbound, 0 inbound
          const [outboundCount] = await db.execute(sql`
            SELECT COUNT(*) as cnt FROM conversations
            WHERE leadId = ${staleLead.id} AND senderType = 'ai' AND direction = 'outbound'
          `);
          const [inboundCount] = await db.execute(sql`
            SELECT COUNT(*) as cnt FROM conversations
            WHERE leadId = ${staleLead.id} AND senderType = 'lead' AND direction = 'inbound'
          `);
          const aiOut = Number((outboundCount as any)?.[0]?.cnt || 0);
          const leadIn = Number((inboundCount as any)?.[0]?.cnt || 0);

          if (aiOut >= 3 && leadIn === 0) {
            const journey = await buildJourneyFromLead(staleLead.id, "stale", "no_reply_14d");
            if (journey) {
              await recordConversationOutcome(journey);
              stats.staleRecorded++;
              console.log(`[Disposition] Stale outcome recorded for lead ${staleLead.id}: ${aiOut} AI outbound, 0 inbound, >14d old`);
            }
          }
        } catch (err) {
          console.error(`[Disposition] Error recording stale for lead ${staleLead.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[Disposition] Error in stale outcome detection:", err);
    }

    // Notify owner if significant dispositions happened
    if (stats.dncDisposed > 0 || stats.emailEscalated > 0 || stats.takeoverExpired > 0 || stats.staleRecorded > 0) {
      try {
        await notifyOwner({
          title: `Lead Disposition: ${stats.dncDisposed} DNC, ${stats.emailEscalated} email escalated, ${stats.takeoverExpired} takeover expired, ${stats.staleRecorded} stale recorded`,
          content: `Disposition sweep completed:\n- ${stats.dncDisposed} DNC leads moved to Not Qualified\n- ${stats.emailEscalated} leads escalated to email outreach\n- ${stats.takeoverExpired} stale takeovers expired\n- ${stats.staleRecorded} stale outcomes recorded for learning\n- ${stats.errors} errors\n\nTotal processed: ${stats.processed}`,
          priority: "standard",
        });
      } catch { /* best effort notification */ }
    }

  } catch (err) {
    console.error("[Disposition] Fatal error in disposition sweep:", err);
    stats.errors++;
  }

  return stats;
}
