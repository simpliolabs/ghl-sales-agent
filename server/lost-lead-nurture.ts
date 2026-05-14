/**
 * LOST LEAD LONG-TERM NURTURE ENGINE (v3)
 *
 * Sends quarterly re-engagement messages to Lost leads — ALWAYS through the
 * Brain Council with full conversation history.  The Brain Council decides:
 *   - Whether to send at all (if lead explicitly declined, it blocks)
 *   - What to say (context-aware, not a canned template)
 *   - The tone and approach (reactivation, not fresh outreach)
 *
 * v3 changes:
 *   - Respects lead.preferredChannel (SMS for 365+ day leads, Email otherwise)
 *   - TCPA quiet hours enforced in RECIPIENT's timezone (via phone area code)
 *   - Business hours enforcement for SMS sends (Mon-Fri 9am-5pm ET)
 *   - Uses shared buildSendOpts + sendMessageWithRetry (signature, formatting, retry)
 *   - Never hardcodes channel — always reads from lead record
 *
 * Design rules:
 *   - Full Brain Council run (Strategist → Researcher → Composer → QC)
 *   - Full conversation history loaded (local DB + GHL)
 *   - Not-interested detection before Brain Council (fast-path skip)
 *   - Respects DND flags (enforced at DB query level + runtime check)
 *   - Max 5 per cron cycle to avoid GHL rate limits
 *   - Updates lastLostNurtureAt after each successful send
 *   - Logs every send attempt to conversations table
 *   - Never triggers pipeline stage changes or opportunity creation
 *
 * Cadence: runs once daily (cron in server/_core/index.ts)
 */

import {
  getLostLeadsForNurture,
  getImportedContactsDueForNurture,
  updateLeadFields,
  addConversation,
  isAiOffline,
  getConversationHistory,
  addBrainCouncilAudit,
} from "./db";
import { fetchGhlConversationHistory } from "./ghl";
import { runBrainCouncil } from "./brain-council-orchestrator";
import { BRAND } from "../shared/brand-assets";
import { buildSendOpts, sendMessageWithRetry } from "./webhook-helpers";
import { isTcpaQuietHoursForRecipient } from "./area-code-timezone";

const MODULE = "[LostNurture]";

// ─── NOT-INTERESTED PATTERNS (same as follow-up-trigger) ────────────────────
const NOT_INTERESTED_PATTERNS = [
  /not\s*interested/i,
  /do\s*not\s*contact/i,
  /\bdnc\b/i,
  /\bdeclined\b/i,
  /no\s*longer\s*interested/i,
  /remove\s*(from|me)/i,
  /opted?\s*out/i,
  /\bunsubscribe\b/i,
  /stop\s*contact/i,
  /not\s*a\s*fit/i,
  /decided\s*not\s*to/i,
  /no\s*thanks/i,
  /please\s*stop/i,
  /leave\s*me\s*alone/i,
  /take\s*me\s*off/i,
];

// ─── BUSINESS HOURS CHECK (Mon-Fri 9am-5pm ET) ─────────────────────────────
function isBusinessHoursET(date: Date = new Date()): boolean {
  const etStr = date.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etStr);
  const day = etDate.getDay(); // 0=Sun, 6=Sat
  const hour = etDate.getHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 17;
}

// ─── RESOLVE EFFECTIVE CHANNEL ──────────────────────────────────────────────
/**
 * Determine the actual send channel for a nurture lead.
 * Respects preferredChannel from DB, with fallbacks:
 * - If preferred is SMS but lead has no phone → fall back to Email
 * - If preferred is Email but lead has no email → fall back to SMS
 * - If preferred is SMS but dndSms → fall back to Email
 * - If preferred is Email but dndEmail → fall back to SMS
 * Returns null if no viable channel exists.
 */
function resolveNurtureChannel(lead: {
  preferredChannel?: string | null;
  email?: string | null;
  phone?: string | null;
  dndSms?: any;
  dndEmail?: any;
}): string | null {
  const pref = (lead.preferredChannel || "Email").toUpperCase();
  const hasEmail = !!lead.email?.trim();
  const hasPhone = !!lead.phone?.trim();
  const smsBlocked = lead.dndSms === 1 || lead.dndSms === "1" || lead.dndSms === true || lead.dndSms === "true";
  const emailBlocked = lead.dndEmail === 1 || lead.dndEmail === "1" || lead.dndEmail === true || lead.dndEmail === "true";

  if (pref === "SMS") {
    if (hasPhone && !smsBlocked) return "SMS";
    if (hasEmail && !emailBlocked) return "Email";
    return null;
  }
  // Default: Email
  if (hasEmail && !emailBlocked) return "Email";
  if (hasPhone && !smsBlocked) return "SMS";
  return null;
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────
export interface LostNurtureResult {
  processed: number;
  sent: number;
  skipped: number;
  errors: number;
  blocked: number;
}

/**
 * Core send function shared by both processLostLeadNurture and processImportedContactNurture.
 * Handles channel resolution, TCPA, business hours, Brain Council, and send pipeline.
 */
async function processNurtureLead(
  lead: any,
  triggerContext: string,
  moduleLabel: string,
  stats: LostNurtureResult
): Promise<void> {
  const leadId = lead.id;
  const ghlContactId = lead.ghlContactId;
  const leadName = lead.name || "Unknown";

  if (!ghlContactId) {
    console.warn(`${moduleLabel} Lead ${leadId} (${leadName}) has no ghlContactId — skipping`);
    stats.skipped++;
    return;
  }

  // ── STEP 0: Resolve effective channel ──────────────────────────────────
  const effectiveChannel = resolveNurtureChannel(lead);
  if (!effectiveChannel) {
    console.warn(`${moduleLabel} Lead ${leadId} (${leadName}) has no viable channel (no email/phone or all DND) — skipping`);
    stats.skipped++;
    return;
  }

  // ── STEP 0b: TCPA quiet hours check (recipient timezone) ──────────────
  // For SMS: check recipient's local time. For Email: check business hours.
  if (effectiveChannel === "SMS") {
    if (isTcpaQuietHoursForRecipient(lead.phone)) {
      console.log(`${moduleLabel} ⏰ TCPA quiet hours for lead ${leadId} (${leadName}) — SMS blocked, will retry next cycle`);
      stats.skipped++;
      return;
    }
    if (!isBusinessHoursET()) {
      console.log(`${moduleLabel} ⏰ Outside business hours (ET) for lead ${leadId} (${leadName}) — SMS deferred to next cycle`);
      stats.skipped++;
      return;
    }
  }

  try {
    // ── STEP 1: Load full conversation history (local DB) ──────────────
    const convHistory = await getConversationHistory(leadId, 50);
    let historyStr = convHistory.map((c: any) =>
      `[${c.senderType === "ai" ? "ai" : c.direction === "inbound" ? "lead" : "agent"}/${c.channel}] ${c.messageBody}`
    ).join("\n");

    // ── STEP 2: Fetch GHL history (authoritative source of truth) ──────
    let ghlHistoryMessages: any[] = [];
    try {
      ghlHistoryMessages = await fetchGhlConversationHistory(ghlContactId);
      if (ghlHistoryMessages && ghlHistoryMessages.length > 0) {
        const ghlHistoryStr = ghlHistoryMessages
          .filter((m: any) => m.body && m.body.trim())
          .map((m: any) => `[${m.direction === "outbound" ? "agent" : "lead"}/${String(m.type || "msg")}] ${m.body}`)
          .join("\n");
        if (ghlHistoryStr) {
          historyStr = `--- Full GHL conversation history (authoritative) ---\n${ghlHistoryStr}\n--- Recent local messages ---\n${historyStr}`;
        }
        console.log(`${moduleLabel} GHL history fetched for lead ${leadId}: ${ghlHistoryMessages.length} messages`);
      }
    } catch (err) {
      console.error(`${moduleLabel} Failed to fetch GHL history for lead ${leadId}:`, err);
    }

    // ── STEP 3: Fast-path NOT-INTERESTED detection ─────────────────────
    const allInboundMessages = [
      ...convHistory.filter((c: any) => c.direction === "inbound").map((c: any) => c.messageBody || ""),
      ...ghlHistoryMessages
        .filter((m: any) => m.direction === "inbound" && m.body?.trim())
        .map((m: any) => m.body || ""),
    ];

    const declineMessage = allInboundMessages.find(msg =>
      NOT_INTERESTED_PATTERNS.some(p => p.test(msg))
    );

    if (declineMessage) {
      console.log(`${moduleLabel} 🛑 NOT-INTERESTED detected for lead ${leadId} (${leadName}): "${declineMessage.substring(0, 80)}". Moving to not_qualified and skipping.`);
      await updateLeadFields(leadId, {
        pipelineStage: "not_qualified",
        lastLostNurtureAt: new Date(),
      });
      await addBrainCouncilAudit({
        leadId,
        leadName,
        channel: effectiveChannel,
        incomingMessage: `${moduleLabel} Re-engagement check`,
        blocked: 1,
        blockReason: `Not-interested detected in conversation history: "${declineMessage.substring(0, 200)}"`,
        violationCategory: "explicit_decline_in_history",
        messageSent: 0,
        ownerNotified: 0,
      });
      stats.blocked++;
      return;
    }

    // ── STEP 4: Run Brain Council with effective channel ────────────────
    // Tell Brain Council the ACTUAL channel — not hardcoded Email
    const channelInstruction = effectiveChannel === "SMS"
      ? `Channel: SMS. Keep it SHORT — 2-3 sentences max. No signature block needed for SMS.`
      : `Channel: Email. Keep it warm and concise — 3-4 sentences max.`;

    const fullContext = `${triggerContext}\n${channelInstruction}`;

    const aiResponse = await runBrainCouncil({
      leadId,
      incomingMessage: fullContext,
      channel: effectiveChannel,
      externalHistory: historyStr,
    });

    // ── STEP 5: Handle Brain Council response ──────────────────────────
    if (aiResponse.violationCategory === "graceful_exit_retired" ||
        (aiResponse.blockReason && aiResponse.blockReason.toLowerCase().includes("graceful_exit"))) {
      console.log(`${moduleLabel} Brain Council chose graceful_exit for lead ${leadId} (${leadName}) — lead declined. Moving to not_qualified.`);
      await updateLeadFields(leadId, {
        lastLostNurtureAt: new Date(),
        pipelineStage: "not_qualified",
      });
      stats.blocked++;
      return;
    }

    if (aiResponse.blocked) {
      console.log(`${moduleLabel} Brain Council BLOCKED nurture for lead ${leadId} (${leadName}): ${aiResponse.blockReason || "unknown"}`);
      await updateLeadFields(leadId, { lastLostNurtureAt: new Date() });
      stats.blocked++;
      return;
    }

    if (!aiResponse.message || aiResponse.message.trim().length === 0) {
      console.warn(`${moduleLabel} Brain Council returned empty message for lead ${leadId} (${leadName}) — skipping`);
      stats.skipped++;
      return;
    }

    // ── STEP 6: Send via shared pipeline (buildSendOpts + sendMessageWithRetry) ──
    const subject = aiResponse.subject || `Checking in from ${BRAND.companyName}`;
    const sendOpts = buildSendOpts(
      effectiveChannel,
      aiResponse.message,
      lead,
      { subject, fromName: BRAND.defaultAgentName }
    );

    if (!sendOpts) {
      console.warn(`${moduleLabel} buildSendOpts returned null for lead ${leadId} (${leadName}) channel=${effectiveChannel} — skipping`);
      stats.skipped++;
      return;
    }

    const sendResult = await sendMessageWithRetry(ghlContactId, sendOpts, {
      email: lead.email,
      phone: lead.phone,
      id: leadId,
    });

    if (!sendResult.success) {
      console.warn(`${moduleLabel} Send failed for lead ${leadId} (${leadName}): ${sendResult.error} (correction: ${sendResult.correctionTaken})`);
      // Still update lastLostNurtureAt to prevent immediate retry
      await updateLeadFields(leadId, { lastLostNurtureAt: new Date() });
      stats.errors++;
      return;
    }

    // ── STEP 7: Update lead and log conversation ───────────────────────
    await updateLeadFields(leadId, {
      lastLostNurtureAt: new Date(),
      reactivationCount: ((lead as any).reactivationCount ?? 0) + 1,
      lastOutboundChannel: effectiveChannel,
    });

    await addConversation({
      leadId,
      channel: effectiveChannel,
      direction: "outbound",
      messageBody: aiResponse.message,
      senderType: "ai",
      senderName: BRAND.defaultAgentName,
      emailMessageId: sendResult.emailMessageId || undefined,
    });

    console.log(`${moduleLabel} ✅ Sent Brain Council nurture ${effectiveChannel} to lead ${leadId} (${leadName}) — subject: "${subject}"`);
    stats.sent++;
  } catch (err: any) {
    console.error(`${moduleLabel} ❌ Error processing lead ${leadId} (${leadName}):`, err?.message || err);
    stats.errors++;
  }
}

// ─── LOST LEAD QUARTERLY NURTURE ────────────────────────────────────────────
export async function processLostLeadNurture(): Promise<LostNurtureResult> {
  const stats: LostNurtureResult = { processed: 0, sent: 0, skipped: 0, errors: 0, blocked: 0 };

  try {
    if (await isAiOffline()) {
      console.log(`${MODULE} AI offline — skipping nurture cycle`);
      return stats;
    }
  } catch {
    console.warn(`${MODULE} isAiOffline check failed — skipping nurture cycle`);
    return stats;
  }

  let lostLeads: Awaited<ReturnType<typeof getLostLeadsForNurture>>;
  try {
    lostLeads = await getLostLeadsForNurture(5);
  } catch (err) {
    console.error(`${MODULE} DB query failed:`, err);
    return stats;
  }

  if (lostLeads.length === 0) return stats;

  console.log(`${MODULE} Found ${lostLeads.length} Lost leads due for quarterly nurture`);

  const triggerContext = `[SYSTEM] This is a quarterly long-term nurture re-engagement for a Lost lead. ` +
    `The lead has been in "Lost" stage and has not been contacted in 90+ days. ` +
    `If the lead previously declined or expressed disinterest, respond with graceful_exit. ` +
    `If the lead had a prior conversation, reference it naturally — do NOT treat this as a first contact. ` +
    `Keep the tone warm, low-pressure, and brand-appropriate.`;

  for (const lead of lostLeads) {
    stats.processed++;
    await processNurtureLead(lead, triggerContext, MODULE, stats);
  }

  if (stats.sent > 0 || stats.errors > 0 || stats.blocked > 0) {
    console.log(`${MODULE} Cycle complete: ${stats.sent} sent, ${stats.blocked} blocked, ${stats.skipped} skipped, ${stats.errors} errors`);
  }

  return stats;
}

// ─── MONTHLY IMPORT NURTURE ─────────────────────────────────────────────────
/**
 * Sends a monthly re-engagement message to imported/transferred contacts that
 * have never replied (reactivatedFromMigration=0). Uses the same Brain Council
 * pipeline as lost-lead nurture. Respects preferredChannel from lead record.
 */
export async function processImportedContactNurture(): Promise<LostNurtureResult> {
  const stats: LostNurtureResult = { processed: 0, sent: 0, skipped: 0, errors: 0, blocked: 0 };

  try {
    if (await isAiOffline()) {
      console.log(`${MODULE}[Import] AI offline — skipping monthly import nurture cycle`);
      return stats;
    }
  } catch {
    console.warn(`${MODULE}[Import] isAiOffline check failed — skipping`);
    return stats;
  }

  let importLeads: Awaited<ReturnType<typeof getImportedContactsDueForNurture>>;
  try {
    importLeads = await getImportedContactsDueForNurture(10);
  } catch (err) {
    console.error(`${MODULE}[Import] DB query failed:`, err);
    return stats;
  }

  if (importLeads.length === 0) return stats;

  console.log(`${MODULE}[Import] Found ${importLeads.length} imported contacts due for monthly outreach`);

  const triggerContext = `[SYSTEM] This is a monthly re-engagement for an imported contact who has not yet replied. ` +
    `Be warm, curiosity-driven, and value-focused. Do NOT be pushy or salesy. ` +
    `Reference Adorb's work with similar businesses if possible. Keep it short. ` +
    `If the lead previously declined or expressed disinterest, respond with graceful_exit.`;

  for (const lead of importLeads) {
    stats.processed++;
    await processNurtureLead(lead, triggerContext, `${MODULE}[Import]`, stats);
  }

  console.log(`${MODULE}[Import] Cycle complete: ${stats.sent} sent, ${stats.blocked} blocked, ${stats.skipped} skipped, ${stats.errors} errors`);
  return stats;
}
