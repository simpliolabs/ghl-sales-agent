/**
 * POST-DELIVERY EXECUTOR — Runs due post-delivery sequence steps
 * 
 * Runs every 30 minutes. Finds pending post_delivery_sequences steps where
 * scheduledAt <= NOW() and status = 'pending', then triggers the Brain Council
 * with the appropriate context (satisfaction check, review request, or upsell).
 * 
 * Sequence steps:
 *   Step 1 (Day 3):  Satisfaction check — "How's everything going with your order?"
 *   Step 2 (Day 10): Review request — "Would you mind leaving us a review?"
 *   Step 3 (Day 21): Upsell/referral — "We have new items you might love"
 */

import { getDuePostDeliverySteps, markPostDeliveryStepSent, getLeadById, getConversationHistory, addConversation, updateLeadFields } from "./db";
import { getDb } from "./db";
import { postDeliverySequences } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { runBrainCouncil } from "./brain-council-orchestrator";
import { sendMessage, addNote } from "./ghl";
import { sendMessageWithRetry, normalizeChannel, formatEmailHtml, buildContextSubject } from "./webhook-helpers";
import { notifyOwner } from "./_core/notification";

const MAX_PER_CYCLE = 5;

const STEP_CONTEXTS: Record<string, string> = {
  satisfaction_check: "[POST-DELIVERY: SATISFACTION CHECK] This customer received their order ~3 days ago. Check in warmly — ask how everything is going, if the product met their expectations, and if there's anything we can help with. Keep it brief and genuine, not salesy.",
  review_request: "[POST-DELIVERY: REVIEW REQUEST] This customer received their order ~10 days ago and we already checked in on satisfaction. Now gently ask if they'd be willing to leave a review — mention how much it helps small businesses. Include a soft CTA but don't pressure.",
  upsell_referral: "[POST-DELIVERY: UPSELL/REFERRAL] This customer received their order ~21 days ago. They're a proven buyer. Mention any new products, seasonal specials, or referral incentives. Frame it as 'thought of you' rather than a hard sell. Keep it personal.",
};

async function skipPostDeliveryStep(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(postDeliverySequences).set({ status: "skipped" }).where(eq(postDeliverySequences.id, id));
}

export async function processPostDeliverySteps(): Promise<{ processed: number; sent: number; skipped: number; errors: number }> {
  const stats = { processed: 0, sent: 0, skipped: 0, errors: 0 };

  try {
    const dueSteps = await getDuePostDeliverySteps(MAX_PER_CYCLE);
    if (dueSteps.length === 0) return stats;

    console.log(`[PostDelivery] Found ${dueSteps.length} due post-delivery steps`);

    for (const step of dueSteps) {
      stats.processed++;
      try {
        // Load lead
        const lead = await getLeadById(step.leadId);
        if (!lead) {
          await skipPostDeliveryStep(step.id);
          stats.skipped++;
          continue;
        }

        // Skip if lead is in humanTakeover, DNC, or not_qualified
        if (lead.humanTakeover === 1 || lead.pipelineStage === "not_qualified") {
          await skipPostDeliveryStep(step.id);
          console.log(`[PostDelivery] Skipped step ${step.id} for lead ${step.leadId}: humanTakeover=${lead.humanTakeover}, stage=${lead.pipelineStage}`);
          stats.skipped++;
          continue;
        }

        // Build trigger context
        const triggerContext = STEP_CONTEXTS[step.stepType] || `[POST-DELIVERY: step ${step.step}]`;
        const channel = normalizeChannel(step.channel || lead.preferredChannel || "SMS");

        // Get conversation history
        const history = await getConversationHistory(step.leadId, 20);
        const historyStr = history.map((c: any) => {
          const dir = c.direction === "inbound" ? "customer" : "ai";
          return `[${dir}/${c.channel}] ${c.messageBody}`;
        }).join("\n");

        // Run Brain Council
        const aiResponse = await runBrainCouncil({
          leadId: step.leadId,
          incomingMessage: triggerContext,
          channel,
          externalHistory: historyStr,
        });

        if (aiResponse.blocked) {
          await skipPostDeliveryStep(step.id);
          console.log(`[PostDelivery] Step ${step.id} blocked by QC: ${aiResponse.blockReason}`);
          stats.skipped++;
          continue;
        }

        // Send the message
        const ghlContactId = lead.ghlContactId;
        if (!ghlContactId) {
          await skipPostDeliveryStep(step.id);
          console.log(`[PostDelivery] Skipped step ${step.id}: no ghlContactId`);
          stats.skipped++;
          continue;
        }
        // Email threading: look up prior email thread for reply threading
        let emailThreadId: string | null = null;
        let priorEmailSubject: string | null = null;
        if (channel === "Email") {
          const { getLastEmailThreadInfo } = await import("./db");
          const threadInfo = await getLastEmailThreadInfo(step.leadId);
          emailThreadId = threadInfo?.threadId || null;
          priorEmailSubject = threadInfo?.subject || null;
          if (emailThreadId) console.log(`[PostDelivery] Threading email for lead ${step.leadId} (threadId: ${emailThreadId})`);
        }
        let emailSubject = aiResponse.subject || buildContextSubject({ name: lead.name, businessName: (lead as any).businessName }, aiResponse.fromName);
        if (emailThreadId && priorEmailSubject) {
          emailSubject = priorEmailSubject.startsWith("Re:") ? priorEmailSubject : `Re: ${priorEmailSubject}`;
        }
        const msgOpts = channel === "Email"
          ? {
              type: "Email" as const,
              subject: emailSubject,
              html: formatEmailHtml(aiResponse.message),
              fromName: aiResponse.fromName,
              ...(emailThreadId ? { threadId: emailThreadId, replyMessageId: emailThreadId } : {}),
            }
          : { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message };

        const sendResult = await sendMessageWithRetry(ghlContactId, msgOpts, {
          email: lead.email,
          phone: lead.phone,
          id: step.leadId,
        });

        if (sendResult.success) {
          const actualChannel = sendResult.correctionTaken?.includes("email") ? "Email"
            : sendResult.correctionTaken?.includes("sms") ? "SMS"
            : channel;
          await addConversation({
            leadId: step.leadId,
            channel: actualChannel,
            direction: "outbound",
            messageBody: aiResponse.message,
            senderType: "ai",
            senderName: aiResponse.fromName,
            emailMessageId: sendResult.emailMessageId || undefined,
          });
          await updateLeadFields(step.leadId, {
            lastMessageAt: new Date(),
            lastOutboundChannel: actualChannel,
          });
          await markPostDeliveryStepSent(step.id);
          console.log(`[PostDelivery] ✅ Sent ${step.stepType} to lead ${step.leadId} via ${actualChannel}`);
          stats.sent++;
        } else {
          await skipPostDeliveryStep(step.id); // mark as skipped on failure
          console.error(`[PostDelivery] ❌ Failed to send ${step.stepType} to lead ${step.leadId}: ${sendResult.error}`);
          stats.errors++;
          // Self-healing: record send failure into error-memory
          try {
            const { recordError } = await import("./error-memory");
            await recordError({
              errorType: "post_delivery_error",
              errorMessage: `Post-delivery ${step.stepType} send failed for lead ${step.leadId}: ${sendResult.error}`,
              context: `leadId=${step.leadId} stepType=${step.stepType} channel=${channel} error=${sendResult.error}`,
            });
          } catch { /* best effort */ }
        }
      } catch (err) {
        console.error(`[PostDelivery] Error processing step ${step.id}:`, err);
        await skipPostDeliveryStep(step.id).catch(() => {});
        stats.errors++;
        // Self-healing: record processing error into error-memory
        try {
          const { recordError } = await import("./error-memory");
          await recordError({
            errorType: "post_delivery_error",
            errorMessage: `Post-delivery step ${step.id} processing error: ${err instanceof Error ? err.message : String(err)}`,
            context: `stepId=${step.id} leadId=${step.leadId} stepType=${step.stepType}`,
          });
        } catch { /* best effort */ }
      }
    }
  } catch (err) {
    console.error("[PostDelivery] Fatal error:", err);
    stats.errors++;
  }

  return stats;
}
