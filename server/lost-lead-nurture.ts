/**
 * LOST LEAD LONG-TERM NURTURE ENGINE (v2)
 *
 * Sends quarterly re-engagement emails to Lost leads — but ALWAYS through the
 * Brain Council with full conversation history.  The Brain Council decides:
 *   - Whether to send at all (if lead explicitly declined, it blocks)
 *   - What to say (context-aware, not a canned template)
 *   - The tone and approach (reactivation, not fresh outreach)
 *
 * Design rules:
 *   - Email ONLY — no SMS, no WhatsApp
 *   - Full Brain Council run (Strategist → Researcher → Composer → QC)
 *   - Full conversation history loaded (local DB + GHL)
 *   - Not-interested detection before Brain Council (fast-path skip)
 *   - Respects email DND and unsubscribed flags (enforced at DB query level)
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
import { sendMessage, fetchGhlConversationHistory } from "./ghl";
import { runBrainCouncil } from "./brain-council-orchestrator";
import { BRAND } from "../shared/brand-assets";

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

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────
export interface LostNurtureResult {
  processed: number;
  sent: number;
  skipped: number;
  errors: number;
  blocked: number;
}

export async function processLostLeadNurture(): Promise<LostNurtureResult> {
  const stats: LostNurtureResult = { processed: 0, sent: 0, skipped: 0, errors: 0, blocked: 0 };

  // AI offline check — skip entire cycle if AI is paused
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

  for (const lead of lostLeads) {
    stats.processed++;
    const leadId = lead.id;
    const ghlContactId = lead.ghlContactId;
    const leadName = lead.name || "Unknown";

    if (!ghlContactId) {
      console.warn(`${MODULE} Lead ${leadId} (${leadName}) has no ghlContactId — skipping`);
      stats.skipped++;
      continue;
    }

    if (!lead.email) {
      console.warn(`${MODULE} Lead ${leadId} (${leadName}) has no email — skipping`);
      stats.skipped++;
      continue;
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
          console.log(`${MODULE} GHL history fetched for lead ${leadId}: ${ghlHistoryMessages.length} messages`);
        }
      } catch (err) {
        console.error(`${MODULE} Failed to fetch GHL history for lead ${leadId}:`, err);
        // Continue — local history is better than nothing
      }

      // ── STEP 3: Fast-path NOT-INTERESTED detection ─────────────────────
      // Check both local and GHL inbound messages for explicit decline language
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
        console.log(`${MODULE} 🛑 NOT-INTERESTED detected for lead ${leadId} (${leadName}): "${declineMessage.substring(0, 80)}". Moving to not_qualified and skipping.`);
        await updateLeadFields(leadId, {
          pipelineStage: "not_qualified",
          lastLostNurtureAt: new Date(), // Prevent re-querying
        });
        await addBrainCouncilAudit({
          leadId,
          leadName,
          channel: "Email",
          incomingMessage: "[LostNurture] Quarterly re-engagement check",
          blocked: 1,
          blockReason: `Not-interested detected in conversation history: "${declineMessage.substring(0, 200)}"`,
          violationCategory: "explicit_decline_in_history",
          messageSent: 0,
          ownerNotified: 0,
        });
        stats.blocked++;
        continue;
      }

      // ── STEP 4: Run Brain Council with full context ────────────────────
      // The Brain Council will:
      // - Detect DECLINING if the lead's history shows disinterest
      // - Choose an appropriate reactivation approach
      // - Compose a context-aware email (not a canned template)
      // - QC will block if the message violates any rules
      const triggerContext = `[SYSTEM] This is a quarterly long-term nurture re-engagement for a Lost lead. ` +
        `The lead has been in "Lost" stage and has not been contacted in 90+ days. ` +
        `Channel: Email ONLY. Do NOT use SMS or WhatsApp. ` +
        `If the lead previously declined or expressed disinterest, respond with graceful_exit. ` +
        `If the lead had a prior conversation, reference it naturally — do NOT treat this as a first contact. ` +
        `Keep the tone warm, low-pressure, and brand-appropriate.`;

      const aiResponse = await runBrainCouncil({
        leadId,
        incomingMessage: triggerContext,
        channel: "Email",
        externalHistory: historyStr,
      });

      // ── STEP 5: Handle Brain Council response ──────────────────────────
      // Check graceful_exit FIRST (it also sets blocked=true, but we want the
      // additional pipelineStage update to not_qualified)
      if (aiResponse.violationCategory === "graceful_exit_retired" || 
          (aiResponse.blockReason && aiResponse.blockReason.toLowerCase().includes("graceful_exit"))) {
        console.log(`${MODULE} Brain Council chose graceful_exit for lead ${leadId} (${leadName}) — lead declined. Moving to not_qualified.`);
        await updateLeadFields(leadId, {
          lastLostNurtureAt: new Date(),
          pipelineStage: "not_qualified",
        });
        stats.blocked++;
        continue;
      }

      if (aiResponse.blocked) {
        console.log(`${MODULE} Brain Council BLOCKED nurture for lead ${leadId} (${leadName}): ${aiResponse.blockReason || "unknown"}`);
        // Still update lastLostNurtureAt so we don't retry immediately
        await updateLeadFields(leadId, { lastLostNurtureAt: new Date() });
        stats.blocked++;
        continue;
      }

      if (!aiResponse.message || aiResponse.message.trim().length === 0) {
        console.warn(`${MODULE} Brain Council returned empty message for lead ${leadId} (${leadName}) — skipping`);
        stats.skipped++;
        continue;
      }

      // ── STEP 6: Send the email via GHL ─────────────────────────────────
      const subject = aiResponse.subject || `Checking in from ${BRAND.companyName}`;
      const htmlBody = formatEmailHtml(aiResponse.message);

      const sendResult = await sendMessage(ghlContactId, {
        type: "Email",
        subject,
        html: htmlBody,
        fromName: BRAND.defaultAgentName,
      });

      if (sendResult.blocked) {
        console.warn(`${MODULE} Lead ${leadId} (${leadName}) email blocked by GHL: ${sendResult.reason}`);
        stats.skipped++;
        continue;
      }

      // ── STEP 7: Update lead and log conversation ───────────────────────
      await updateLeadFields(leadId, {
        lastLostNurtureAt: new Date(),
        reactivationCount: ((lead as any).reactivationCount ?? 0) + 1,
        lastOutboundChannel: "Email",
      });

      await addConversation({
        leadId,
        channel: "Email",
        direction: "outbound",
        messageBody: aiResponse.message,
        senderType: "ai",
        senderName: BRAND.defaultAgentName,
        emailMessageId: (sendResult as any).messageId || undefined,
      });

      console.log(`${MODULE} ✅ Sent Brain Council nurture email to lead ${leadId} (${leadName}) — subject: "${subject}"`);
      stats.sent++;
    } catch (err: any) {
      console.error(`${MODULE} ❌ Error processing lead ${leadId} (${leadName}):`, err?.message || err);
      stats.errors++;
    }
  }

  if (stats.sent > 0 || stats.errors > 0 || stats.blocked > 0) {
    console.log(`${MODULE} Cycle complete: ${stats.sent} sent, ${stats.blocked} blocked, ${stats.skipped} skipped, ${stats.errors} errors`);
  }

  return stats;
}

// ─── MONTHLY IMPORT NURTURE ─────────────────────────────────────────────────
/**
 * Sends a monthly re-engagement email to imported/transferred contacts that
 * have never replied (reactivatedFromMigration=0). Email ONLY — no SMS, no FB.
 * Uses the same Brain Council pipeline as lost-lead nurture.
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

  console.log(`${MODULE}[Import] Found ${importLeads.length} imported contacts due for monthly email`);

  for (const lead of importLeads) {
    stats.processed++;
    const leadId = lead.id;
    const ghlContactId = lead.ghlContactId;
    const leadName = lead.name || "Unknown";

    if (!ghlContactId || !lead.email) {
      stats.skipped++;
      continue;
    }

    try {
      // Load conversation history
      const convHistory = await getConversationHistory(leadId, 50);
      let historyStr = convHistory.map((c: any) =>
        `[${c.senderType === "ai" ? "ai" : c.direction === "inbound" ? "lead" : "agent"}/${c.channel}] ${c.messageBody}`
      ).join("\n");

      // Fast-path: skip if lead explicitly declined
      const allMessages = convHistory.map((c: any) => c.messageBody || "").join(" ");
      if (NOT_INTERESTED_PATTERNS.some(p => p.test(allMessages))) {
        console.log(`${MODULE}[Import] Lead ${leadId} (${leadName}) — not-interested detected, skipping`);
        stats.blocked++;
        await updateLeadFields(leadId, { lastLostNurtureAt: new Date() });
        continue;
      }

      // Run Brain Council — email only, monthly import context
      const triggerContext = `[SYSTEM] This is a monthly re-engagement email for an imported contact who has not yet replied. ` +
        `Channel: Email ONLY. Do NOT use SMS or WhatsApp. ` +
        `Be warm, curiosity-driven, and value-focused. Do NOT be pushy or salesy. ` +
        `Reference Adorb's work with similar businesses if possible. Keep it short — 3-4 sentences max. ` +
        `If the lead previously declined or expressed disinterest, respond with graceful_exit.`;
      const brainResult = await runBrainCouncil({
        leadId,
        incomingMessage: triggerContext,
        channel: "Email",
        externalHistory: historyStr,
      });

      if (!brainResult || brainResult.blocked) {
        console.log(`${MODULE}[Import] Lead ${leadId} (${leadName}) — Brain Council blocked send: ${brainResult?.blockReason || "unknown"}`);
        stats.blocked++;
        await updateLeadFields(leadId, { lastLostNurtureAt: new Date() });
        continue;
      }

      // Send email via GHL
      const subject = brainResult.subject || `A quick note from Adorb Custom Printing`;
      const htmlBody = formatEmailHtml(brainResult.message || "");
      const sendResult = await sendMessage(ghlContactId, {
        type: "Email",
        subject,
        html: htmlBody,
        fromName: BRAND.defaultAgentName,
      });

      if (sendResult.blocked) {
        console.warn(`${MODULE}[Import] Lead ${leadId} (${leadName}) email blocked: ${sendResult.reason}`);
        stats.skipped++;
        continue;
      }

      // Update lastLostNurtureAt so it won't fire again for 30 days
      await updateLeadFields(leadId, {
        lastLostNurtureAt: new Date(),
        reactivationCount: ((lead as any).reactivationCount ?? 0) + 1,
        lastOutboundChannel: "Email",
      });

      // Log to conversations
      await addConversation({
        leadId,
        channel: "Email",
        direction: "outbound",
        messageBody: brainResult.message || "",
        senderType: "ai",
        senderName: BRAND.defaultAgentName,
        emailMessageId: (sendResult as any).messageId || undefined,
      });

      stats.sent++;
      console.log(`${MODULE}[Import] ✅ Sent monthly email to lead ${leadId} (${leadName}) — subject: "${subject}"`);
    } catch (err) {
      console.error(`${MODULE}[Import] Error processing lead ${leadId}:`, err);
      stats.errors++;
    }
  }

  console.log(`${MODULE}[Import] Cycle complete: ${stats.sent} sent, ${stats.blocked} blocked, ${stats.skipped} skipped, ${stats.errors} errors`);
  return stats;
}

// ─── HTML FORMATTER ──────────────────────────────────────────────────────────
function formatEmailHtml(bodyText: string): string {
  const lines = bodyText.split("\n");
  const htmlLines = lines.map(line => {
    if (line.trim() === "") return "<br>";
    return `<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;">${line}</p>`;
  });
  return `<div style="max-width:600px;margin:0 auto;padding:24px 16px;">${htmlLines.join("\n")}</div>`;
}
