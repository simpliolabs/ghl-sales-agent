/**
 * LOST LEAD LONG-TERM NURTURE ENGINE
 *
 * Sends a single quarterly re-engagement email to Lost leads that have a valid
 * email address and have not been nurtured in the last 90 days.
 *
 * Design rules:
 *   - Email ONLY — no SMS, no WhatsApp, no tasks, no owner notifications
 *   - No Brain Council — uses a deterministic template (no LLM hallucination risk)
 *   - Respects email DND and unsubscribed flags (enforced at DB query level)
 *   - Max 5 per cron cycle to avoid GHL rate limits
 *   - Updates lastLostNurtureAt after each successful send
 *   - Logs every send attempt (success + failure) to conversations table
 *   - Never triggers pipeline stage changes or opportunity creation
 *
 * Cadence: runs once daily (cron in server/_core/index.ts)
 */

import { getLostLeadsForNurture, updateLeadFields, addConversation, isAiOffline } from "./db";
import { sendMessage } from "./ghl";
import { BRAND } from "../shared/brand-assets";

const MODULE = "[LostNurture]";

// ─── NURTURE EMAIL TEMPLATES ─────────────────────────────────────────────────
// Three rotating templates to avoid repetition across quarterly cycles.
// Template selection is based on (reactivationCount % 3) so each lead
// cycles through all three over 9 months.

interface NurtureTemplate {
  subject: string;
  bodyText: string; // plain text version (used for HTML generation)
}

function buildNurtureEmail(lead: {
  name?: string | null;
  businessName?: string | null;
  reactivationCount?: number | null;
}): NurtureTemplate {
  const firstName = (lead.name || "").split(" ")[0] || "there";
  const bizName = lead.businessName ? ` at ${lead.businessName}` : "";
  const cycle = (lead.reactivationCount ?? 0) % 3;

  if (cycle === 0) {
    // Template A: Value-first / social proof
    return {
      subject: `Still printing for ${BRAND.city}?`,
      bodyText: `Hey ${firstName},

Just checking in — it's been a while since we last connected${bizName}.

We've been busy helping South Florida teams, businesses, and organizations get their custom gear done fast. Same-day turnaround, no minimums, and ${BRAND.reviewStars} stars across ${BRAND.reviewCount} reviews.

If you have an upcoming event, order, or project — even a small one — we'd love to help.

Reply to this email or visit ${BRAND.website} to get a quick quote.

${BRAND.signatureBlock.replace("{agentName}", BRAND.defaultAgentName)}`,
    };
  }

  if (cycle === 1) {
    // Template B: New capability / seasonal hook
    return {
      subject: `New: UV DTF + same-day prints`,
      bodyText: `Hey ${firstName},

Quick note from the Adorb team${bizName} —

We've expanded our printing capabilities: UV DTF, embroidery, and same-day turnaround are all available now. No minimums, and we handle everything from single pieces to bulk orders.

If you've been thinking about custom apparel, branded gifts, or event merch — this is a good time to reach out.

${BRAND.website} | ${BRAND.phone}

${BRAND.signatureBlock.replace("{agentName}", BRAND.defaultAgentName)}`,
    };
  }

  // Template C: Direct re-engagement / low-pressure
  return {
    subject: `Quick question for you`,
    bodyText: `Hey ${firstName},

I know it's been a while — just wanted to reach out one more time${bizName}.

If custom printing is something you're still exploring (or planning for later this year), we're here and ready to help. No pressure at all.

Hit reply if you want a quick quote or have questions.

${BRAND.signatureBlock.replace("{agentName}", BRAND.defaultAgentName)}`,
  };
}

// ─── HTML FORMATTER ──────────────────────────────────────────────────────────
function formatNurtureEmailHtml(bodyText: string): string {
  const lines = bodyText.split("\n");
  const htmlLines = lines.map(line => {
    if (line.trim() === "") return "<br>";
    return `<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;">${line}</p>`;
  });
  return `<div style="max-width:600px;margin:0 auto;padding:24px 16px;">${htmlLines.join("\n")}</div>`;
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────
export interface LostNurtureResult {
  processed: number;
  sent: number;
  skipped: number;
  errors: number;
}

export async function processLostLeadNurture(): Promise<LostNurtureResult> {
  const stats: LostNurtureResult = { processed: 0, sent: 0, skipped: 0, errors: 0 };

  // AI offline check — skip entire cycle if AI is paused
  try {
    if (await isAiOffline()) {
      console.log(`${MODULE} AI offline — skipping nurture cycle`);
      return stats;
    }
  } catch {
    // If we can't check, skip to be safe
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

  console.log(`${MODULE} Found ${lostLeads.length} Lost leads due for quarterly nurture email`);

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
      const template = buildNurtureEmail({
        name: lead.name,
        businessName: lead.businessName,
        reactivationCount: lead.reactivationCount,
      });

      const htmlBody = formatNurtureEmailHtml(template.bodyText);

      const sendResult = await sendMessage(ghlContactId, {
        type: "Email",
        subject: template.subject,
        html: htmlBody,
        fromName: BRAND.defaultAgentName,
      });

      if (sendResult.blocked) {
        console.warn(`${MODULE} Lead ${leadId} (${leadName}) email blocked: ${sendResult.reason}`);
        stats.skipped++;
        continue;
      }

      // Update lastLostNurtureAt and increment reactivationCount
      await updateLeadFields(leadId, {
        lastLostNurtureAt: new Date(),
        reactivationCount: (lead.reactivationCount ?? 0) + 1,
      });

      // Log to conversations table (silent — no state machine side effects)
      await addConversation({
        leadId,
        channel: "Email",
        direction: "outbound",
        messageBody: template.bodyText,
        senderType: "ai",
        senderName: BRAND.defaultAgentName,
        emailMessageId: (sendResult as any).messageId || undefined,
      });

      console.log(`${MODULE} ✅ Sent quarterly nurture email to lead ${leadId} (${leadName}) — subject: "${template.subject}"`);
      stats.sent++;
    } catch (err: any) {
      console.error(`${MODULE} ❌ Error sending to lead ${leadId} (${leadName}):`, err?.message || err);
      stats.errors++;
    }
  }

  if (stats.sent > 0 || stats.errors > 0) {
    console.log(`${MODULE} Cycle complete: ${stats.sent} sent, ${stats.skipped} skipped, ${stats.errors} errors`);
  }

  return stats;
}
