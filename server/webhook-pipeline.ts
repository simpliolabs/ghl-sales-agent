/**
 * WEBHOOK PIPELINE HANDLER — Pipeline stage changes, stage automation, and customer notifications
 */

import { Response } from "express";
import { getLeadByGhlContactId, addPipelineEvent, getPipelineEvents, updateLeadFields, addConversation, addAgentAssignment, getAgentWorkload, isAiOffline } from "./db";
import { calculateNextFollowUp } from "./scheduling-engine";
import { createTask, addNote, createAppointment, getNextBusinessHoursSlot, toETOffsetString, AGENT_CALENDAR_IDS, AGENT_GHL_USER_IDS } from "./ghl";
import { getConversationHistory } from "./db";
import { attributeStageAdvance } from "./outcome-engine";
import { buildJourneyFromLead, recordConversationOutcome, extractAgentPatterns, recordAgentLearning } from "./learning-loop";
import {
  SALES_AGENTS,
  DESIGNER,
  PRODUCTION_MANAGER,
  STAGES,
  sendMessageWithRetry,
  formatEmailHtml,
} from "./webhook-helpers";

// --- CUSTOMER NOTIFICATION MESSAGES ---
function getStageNotification(stage: string, leadName: string, extras?: Record<string, string>): { message: string; fromName: string } | null {
  const firstName = (leadName || "").split(" ")[0] || "there";
  switch (stage) {
    case STAGES.CONTACTED: return null;
    case STAGES.QUALIFIED:
      return { message: `Hey ${firstName}! I've got everything I need to put together a custom quote for you. Let me get our team on it — you'll hear back shortly.`, fromName: "Adorb Custom Tees" };
    case STAGES.QUOTE_SENT: return null;
    case STAGES.PAID_PROOF_NEEDED:
      return { message: `Payment received — thank you, ${firstName}! Our design team is working on your proof now. You'll see it within 1-3 business days depending on complexity.`, fromName: "Your Custom Tee Order" };
    case STAGES.PROOF_SENT:
      return { message: `Hey ${firstName}! Your proof is ready — take a look and let us know if you'd like any changes, or if it's good to go! 🎨`, fromName: "Your Custom Tee Order" };
    case STAGES.APPROVED:
      return { message: `Your design is approved and locked in, ${firstName}! We're moving it into production now. Estimated completion: ${extras?.turnaround || "3-7 business days"}.`, fromName: "Adorb Custom Tees" };
    case STAGES.IN_PRODUCTION: return null;
    case STAGES.READY:
      return { message: `Great news, ${firstName} — your order is ready! You can pick it up at our Hallandale Beach location, or we can ship it out today. What works best for you?`, fromName: "Adorb Custom Tees" };
    case STAGES.DELIVERED: return null;
    default: return null;
  }
}

// --- STAGE AUTOMATION: Team assignments and tasks ---
export async function handleStageAutomation(
  stage: string,
  lead: { id: number; ghlContactId: string; name: string | null; businessName: string | null; email: string | null; assignedAgent: string | null; pipelineValue: number | null; lastPaymentNotifiedAt?: Date | null },
  opportunityId?: string
) {
  const leadLabel = lead.name || lead.businessName || "Lead";
  const contactId = lead.ghlContactId;

  switch (stage) {
    case STAGES.NEW_LEAD: {
      if (!lead.assignedAgent) {
        const workload = await getAgentWorkload();
        const workloadMap: Record<string, number> = {};
        for (const w of workload) { if (w.agent) workloadMap[w.agent] = w.count; }
        let minAgent = SALES_AGENTS[0];
        let minCount = workloadMap[SALES_AGENTS[0]] || 0;
        for (const agent of SALES_AGENTS) {
          const count = workloadMap[agent] || 0;
          if (count < minCount) { minAgent = agent; minCount = count; }
        }
        await addAgentAssignment({ leadId: lead.id, agentName: minAgent, assignmentReason: "Auto-assigned via round-robin on new lead" });
        await updateLeadFields(lead.id, { assignedAgent: minAgent });
      }
      break;
    }

    case STAGES.QUALIFIED: {
      const agent = lead.assignedAgent || SALES_AGENTS[0];
      const estValue = lead.pipelineValue ? ` — Est. $${lead.pipelineValue}` : "";
      try {
        await createTask(contactId, {
          title: `📋 Create quote for ${leadLabel}${estValue}`,
          body: `Lead has been qualified by AI. Review the conversation and notes, then create and send a custom quote.\n\nBusiness: ${lead.businessName || "N/A"}\nEmail: ${lead.email || "N/A"}\nEstimated Value: $${lead.pipelineValue || "TBD"}`,
          assignedTo: agent,
        });
        await addNote(contactId, `🤖 AI moved to Qualified. Assigned to ${agent} for quoting.`);
      } catch { /* best effort */ }
      break;
    }

    case STAGES.PAID_PROOF_NEEDED: {
      // Build conversation summary for the designer
      let designSummary = "";
      try {
        const history = await getConversationHistory(lead.id, 20);
        if (history.length > 0) {
          const recent = history.slice(0, 10).reverse();
          designSummary = recent.map((m: any) => {
            const who = m.direction === "inbound" ? (lead.name || "Customer") : "AI (Abby)";
            const time = m.timestamp ? new Date(m.timestamp).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
            return `[${time}] ${who}: ${(m.messageBody || "").slice(0, 200)}`;
          }).join("\n");
        }
      } catch { /* best effort */ }

      // 1. Create design task for César
      try {
        await createTask(contactId, {
          title: `🎨 Create design proof for ${leadLabel}`,
          body: [
            `Payment received. Create the design proof based on the order details.`,
            ``,
            `Business: ${lead.businessName || "N/A"}`,
            `Contact: ${lead.name || "N/A"} | Email: ${lead.email || "N/A"}`,
            `Order Value: $${lead.pipelineValue || "N/A"}`,
            ``,
            `Check the contact notes and conversation below for product details,`,
            `quantities, sizes, and design preferences.`,
            ...(designSummary ? [``, `--- Recent Conversation ---`, designSummary] : []),
          ].join("\n"),
          assignedTo: DESIGNER,
        });
      } catch { /* best effort */ }

      // 2. Create appointment for César to work on the proof
      try {
        const slot = getNextBusinessHoursSlot();
        const cesarCalendar = AGENT_CALENDAR_IDS["Abby Bouwer"]; // Use default calendar
        const cesarUserId = AGENT_GHL_USER_IDS[DESIGNER];
        const endTime = new Date(slot.start.getTime() + 60 * 60 * 1000); // 1hr for design work
        await createAppointment({
          calendarId: cesarCalendar,
          contactId,
          title: `🎨 Design proof for ${leadLabel}`,
          description: [
            `Payment received. Create mockup/proof.`,
            `Order Value: $${lead.pipelineValue || "N/A"}`,
            ...(designSummary ? [``, `--- Order Details from Conversation ---`, designSummary] : []),
          ].join("\n"),
          startTime: toETOffsetString(slot.start),
          endTime: toETOffsetString(endTime),
          assignedUserId: cesarUserId,
        });
      } catch { /* best effort */ }

      // 3. Add detailed note
      try {
        await addNote(contactId,
          [
            `🤖 Payment received. Design proof assigned to ${DESIGNER}.`,
            `Task and appointment created for ${DESIGNER}.`,
            `Order Value: $${lead.pipelineValue || "N/A"}`,
            ...(designSummary ? [``, `--- Conversation Summary ---`, designSummary] : []),
          ].join("\n")
        );
      } catch { /* best effort */ }

      // 4. Notify owner — with dedup guard (6h minimum between notifications per lead)
      // Prevents repeated notifications when GHL re-fires the webhook (e.g., test leads, workflow loops)
      try {
        const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
        const lastNotified = lead.lastPaymentNotifiedAt ? new Date(lead.lastPaymentNotifiedAt).getTime() : 0;
        const hoursSinceLast = (Date.now() - lastNotified) / (1000 * 60 * 60);
        if (hoursSinceLast >= 6) {
          const { notifyOwner } = await import("./_core/notification");
          await notifyOwner({
            title: `💰 Payment received: ${leadLabel}`,
            content: `${leadLabel} has paid. Order value: $${lead.pipelineValue || "N/A"}. Design proof assigned to ${DESIGNER}.`,
            priority: "critical",
          });
          // Update dedup timestamp
          await updateLeadFields(lead.id, { lastPaymentNotifiedAt: new Date() });
        } else {
          console.log(`[Pipeline] Payment notification dedup: lead ${lead.id} already notified ${hoursSinceLast.toFixed(1)}h ago — skipping`);
        }
      } catch { /* best effort */ }
      break;
    }

    case STAGES.PROOF_SENT: {
      const proofSchedule = await calculateNextFollowUp({ leadId: lead.id, triggerEvent: "stage_change", stageTransition: "Proof Sent" });
      await updateLeadFields(lead.id, { nextFollowUpAt: proofSchedule.nextFollowUpAt, cadencePosition: proofSchedule.cadencePosition });
      try { await addNote(contactId, `🤖 Proof sent to customer. Follow-up scheduled for ${proofSchedule.nextFollowUpAt.toLocaleDateString()} if no response. [${proofSchedule.reason}]`); } catch { /* best effort */ }
      break;
    }

    case STAGES.APPROVED: {
      try {
        await createTask(contactId, {
          title: `🏭 Start production for ${leadLabel}`,
          body: `Proof approved by customer. Start the print job.\n\nBusiness: ${lead.businessName || "N/A"}\nOrder Value: $${lead.pipelineValue || "N/A"}\n\nCheck contact notes for product specs, quantities, and approved design.`,
          assignedTo: PRODUCTION_MANAGER,
        });
        await addNote(contactId, `🤖 Proof approved. Production assigned to ${PRODUCTION_MANAGER}.`);
      } catch { /* best effort */ }
      break;
    }

    case STAGES.READY: {
      // NOTE: No GHL task/appointment created here — fulfillment is handled internally via Shopify.
      // Only update the follow-up schedule so the AI can send a pickup/delivery notification to the customer.
      const readySchedule = await calculateNextFollowUp({ leadId: lead.id, triggerEvent: "stage_change", stageTransition: "Ready" });
      await updateLeadFields(lead.id, { nextFollowUpAt: readySchedule.nextFollowUpAt, cadencePosition: readySchedule.cadencePosition });
      break;
    }

    case STAGES.DELIVERED: {
      const deliveredSchedule = await calculateNextFollowUp({ leadId: lead.id, triggerEvent: "stage_change", stageTransition: "Delivered" });
      await updateLeadFields(lead.id, { nextFollowUpAt: deliveredSchedule.nextFollowUpAt, cadencePosition: deliveredSchedule.cadencePosition });
      try { await addNote(contactId, `🤖 Order delivered. ${deliveredSchedule.reason}`); } catch { /* best effort */ }
      break;
    }

    default: break;
  }
}

// --- PIPELINE STAGE CHANGE HANDLER ---
export async function handlePipelineWebhook(payload: Record<string, unknown>, res: Response) {
  const contactId = (payload.contactId || payload.contact_id) as string;
  const fromStage = (payload.previousStage || payload.fromStage) as string;
  const toStage = (payload.currentStage || payload.toStage || payload.stageName) as string;
  const monetaryValue = (payload.monetaryValue || payload.value) as number | undefined;
  const opportunityId = (payload.opportunityId || payload.opportunity_id) as string | undefined;

  if (!contactId) { res.status(400).json({ error: "Missing contact ID" }); return; }

  const lead = await getLeadByGhlContactId(contactId);
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  // --- DB-LEVEL DEDUP: Permanent — block if this exact stage transition already recorded ---
  // Uses fromStage+toStage as the dedup key so a lead CAN re-enter a stage
  // from a different origin (e.g. "Proof Sent" → "Qualified" is allowed even if
  // "New Lead" → "Qualified" was already processed).
  const recentEvents = await getPipelineEvents(lead.id);
  const isDuplicate = recentEvents.some((evt: { fromStage: string | null; toStage: string }) => {
    return evt.fromStage === (fromStage || null) && evt.toStage === toStage;
  });
  if (isDuplicate) {
    console.log(`[Webhook/Pipeline] DB-dedup blocked: lead ${lead.id} already has "${fromStage || '(none)'}" → "${toStage}" transition`);
    res.json({ success: true, action: "pipeline_db_dedup_blocked" });
    return;
  }

  await addPipelineEvent({ leadId: lead.id, fromStage, toStage, triggeredBy: "webhook" });

  // --- SELF-LEARNING: Attribute stage advance to the AI message that influenced it ---
  try {
    await attributeStageAdvance({
      leadId: lead.id,
      toStage,
      previousScore: lead.opportunityScore ?? undefined,
    });
  } catch (err) {
    console.error('[Webhook/Learn] Stage attribution error (non-fatal):', err);
  }

  const updateFields: Record<string, unknown> = { pipelineStage: toStage };
  if (monetaryValue !== undefined && monetaryValue !== null) updateFields.pipelineValue = Number(monetaryValue);
  await updateLeadFields(lead.id, updateFields);

  const pipelineSchedule = await calculateNextFollowUp({ leadId: lead.id, triggerEvent: "stage_change", stageTransition: toStage });
  await updateLeadFields(lead.id, { nextFollowUpAt: pipelineSchedule.nextFollowUpAt, cadencePosition: pipelineSchedule.cadencePosition, preferredChannel: pipelineSchedule.channel });
  console.log(`[Webhook] Pipeline schedule for lead ${lead.id} → ${toStage}: ${pipelineSchedule.reason}`);

  await handleStageAutomation(toStage, {
    id: lead.id, ghlContactId: contactId, name: lead.name, businessName: lead.businessName,
    email: lead.email, assignedAgent: lead.assignedAgent,
    pipelineValue: monetaryValue !== undefined ? Number(monetaryValue) : (lead.pipelineValue ?? null),
  }, opportunityId);

  // Check if AI is offline before sending customer notifications
  const aiOffline = await isAiOffline();
  const notification = getStageNotification(toStage, lead.name || "");
  if (notification && !aiOffline) {
    try {
      const notifOpts: Parameters<typeof import("./ghl").sendMessage>[1] = lead.phone
        ? { type: "SMS", message: notification.message }
        : { type: "Email", subject: notification.fromName, html: formatEmailHtml(notification.message), fromName: notification.fromName };
      if (lead.phone || lead.email) {
        const notifResult = await sendMessageWithRetry(contactId, notifOpts, { email: lead.email, phone: lead.phone, id: lead.id });
        if (notifResult.success) {
          if (notifResult.isPhantom) console.warn(`[Pipeline] PR#3.12: Phantom stage notification for lead ${lead.id}`);
          await addConversation({
            leadId: lead.id, channel: lead.phone ? "SMS" : "Email", direction: "outbound",
            messageBody: notification.message, senderType: "ai", senderName: notification.fromName,
            ghlMessageId: notifResult.ghlMessageId,
          });
        } else {
          console.error(`[Pipeline] Stage notification send FAILED for lead ${lead.id}: ${notifResult.error} — conversation NOT stored`);
        }
      }
    } catch (err) { console.error("[Webhook] Failed to send stage notification:", err); }
  } else if (aiOffline && notification) {
    console.log(`[Pipeline] AI offline — skipping stage notification for lead ${lead.id} (${toStage})`);
  }

  // --- LEARNING LOOP: Record conversation outcome on terminal stages ---
  const TERMINAL_WON_STAGES: string[] = [STAGES.DELIVERED, "Proof Approved", "In Production", "Approved + Deposit"];
  const TERMINAL_LOST_STAGES = ["Not Qualified", "Lost"];
  const isTerminalWon = TERMINAL_WON_STAGES.some(s => toStage.toLowerCase() === s.toLowerCase());
  const isTerminalLost = TERMINAL_LOST_STAGES.some(s => toStage.toLowerCase().includes(s.toLowerCase()));
  if (isTerminalWon || isTerminalLost) {
    try {
      const outcome = isTerminalWon ? "won" as const : "lost" as const;
      const journey = await buildJourneyFromLead(lead.id, outcome, toStage);
      if (journey) await recordConversationOutcome(journey);

      // --- AGENT SUCCESS LEARNING: Extract patterns from human agent wins ---
      if (isTerminalWon) {
        try {
          const patterns = await extractAgentPatterns(lead.id);
          if (patterns.length > 0) {
            const recorded = await recordAgentLearning(lead.id, patterns);
            console.log(`[Webhook/AgentLearn] Extracted ${patterns.length} patterns, recorded ${recorded} for lead ${lead.id} (stage: ${toStage})`);
          }
        } catch (agentErr) {
          console.error('[Webhook/AgentLearn] Agent pattern extraction error (non-fatal):', agentErr);
        }
      }
    } catch (err) {
      console.error('[Webhook/Learn] Conversation outcome recording error (non-fatal):', err);
    }
  }

  res.json({ success: true, stage: toStage });
}
