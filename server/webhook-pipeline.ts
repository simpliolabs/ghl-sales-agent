/**
 * WEBHOOK PIPELINE HANDLER — Pipeline stage changes, stage automation, and customer notifications
 */

import { Response } from "express";
import { getLeadByGhlContactId, addPipelineEvent, updateLeadFields, addConversation, addAgentAssignment, getAgentWorkload } from "./db";
import { calculateNextFollowUp } from "./scheduling-engine";
import { createTask, addNote } from "./ghl";
import { attributeStageAdvance } from "./outcome-engine";
import {
  SALES_AGENTS,
  DESIGNER,
  PRODUCTION_MANAGER,
  STAGES,
  sendMessageWithRetry,
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
  lead: { id: number; ghlContactId: string; name: string | null; businessName: string | null; email: string | null; assignedAgent: string | null; pipelineValue: number | null },
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
      try {
        await createTask(contactId, {
          title: `🎨 Create design proof for ${leadLabel}`,
          body: `Payment received. Create the design proof based on the order details.\n\nBusiness: ${lead.businessName || "N/A"}\nOrder Value: $${lead.pipelineValue || "N/A"}\n\nCheck the contact notes for product details, quantities, and design preferences.`,
          assignedTo: DESIGNER,
        });
        await addNote(contactId, `🤖 Payment received. Design proof assigned to ${DESIGNER}.`);
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
      try {
        await createTask(contactId, {
          title: `📦 Ship/arrange pickup for ${leadLabel}`,
          body: `Order is ready. Arrange shipping or coordinate pickup with the customer.\n\nBusiness: ${lead.businessName || "N/A"}`,
          assignedTo: PRODUCTION_MANAGER,
        });
        await addNote(contactId, `🤖 Order ready. Shipping/pickup assigned to ${PRODUCTION_MANAGER}.`);
      } catch { /* best effort */ }
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

  const notification = getStageNotification(toStage, lead.name || "");
  if (notification) {
    try {
      const notifOpts: Parameters<typeof import("./ghl").sendMessage>[1] = lead.phone
        ? { type: "SMS", message: notification.message }
        : { type: "Email", subject: notification.fromName, html: notification.message, fromName: notification.fromName };
      if (lead.phone || lead.email) {
        await sendMessageWithRetry(contactId, notifOpts, { email: lead.email, phone: lead.phone, id: lead.id });
      }
      await addConversation({
        leadId: lead.id, channel: lead.phone ? "SMS" : "Email", direction: "outbound",
        messageBody: notification.message, senderType: "ai", senderName: notification.fromName,
      });
    } catch (err) { console.error("[Webhook] Failed to send stage notification:", err); }
  }

  res.json({ success: true, stage: toStage });
}
