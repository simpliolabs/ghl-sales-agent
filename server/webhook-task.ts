/**
 * WEBHOOK TASK HANDLER — Handles task completion events from GHL
 * 
 * When a team member completes a task, auto-advance the pipeline stage:
 * - Design proof completed → Proof Sent
 * - Production completed → Ready
 * - Shipping/pickup completed → Delivered
 */

import { Response } from "express";
import { getLeadByGhlContactId, updateLeadFields, addConversation } from "./db";
import { addNote } from "./ghl";
import { DESIGNER, PRODUCTION_MANAGER, STAGES, sendMessageWithRetry } from "./webhook-helpers";
import { handleStageAutomation } from "./webhook-pipeline";

// --- STAGE NOTIFICATION (inline for task handler) ---
function getStageNotification(stage: string, leadName: string): { message: string; fromName: string } | null {
  const firstName = (leadName || "").split(" ")[0] || "there";
  switch (stage) {
    case STAGES.PROOF_SENT:
      return { message: `Hey ${firstName}! Your proof is ready — take a look and let us know if you'd like any changes, or if it's good to go! 🎨`, fromName: "Your Custom Tee Order" };
    case STAGES.READY:
      return { message: `Great news, ${firstName} — your order is ready! You can pick it up at our Hallandale Beach location, or we can ship it out today. What works best for you?`, fromName: "Adorb Custom Tees" };
    default: return null;
  }
}

export async function handleTaskWebhook(payload: Record<string, unknown>, res: Response) {
  const contactId = (payload.contactId || payload.contact_id) as string;
  const taskTitle = (payload.title || payload.taskTitle || "") as string;
  const status = (payload.status || "") as string;

  if (status !== "completed" || !contactId) {
    res.json({ success: true, action: "ignored" });
    return;
  }

  const lead = await getLeadByGhlContactId(contactId);
  if (!lead) { res.json({ success: true, action: "lead_not_found" }); return; }

  const titleLower = taskTitle.toLowerCase();

  if (titleLower.includes("design proof") || titleLower.includes("create proof")) {
    await updateLeadFields(lead.id, { pipelineStage: STAGES.PROOF_SENT });
    await handleStageAutomation(STAGES.PROOF_SENT, {
      id: lead.id, ghlContactId: contactId, name: lead.name,
      businessName: lead.businessName, email: lead.email,
      assignedAgent: lead.assignedAgent, pipelineValue: lead.pipelineValue ?? null,
    });
    const notification = getStageNotification(STAGES.PROOF_SENT, lead.name || "");
    if (notification && lead.phone) {
      try {
        await sendMessageWithRetry(contactId, { type: "SMS", message: notification.message }, { email: lead.email, phone: lead.phone, id: lead.id });
        await addConversation({ leadId: lead.id, channel: "SMS", direction: "outbound", messageBody: notification.message, senderType: "ai", senderName: notification.fromName });
      } catch { /* best effort */ }
    }
    try { await addNote(contactId, `🤖 Design proof completed by ${DESIGNER}. Sent to customer for approval.`); } catch { /* best effort */ }
  }

  if (titleLower.includes("start production") || titleLower.includes("production for")) {
    await updateLeadFields(lead.id, { pipelineStage: STAGES.READY });
    await handleStageAutomation(STAGES.READY, {
      id: lead.id, ghlContactId: contactId, name: lead.name,
      businessName: lead.businessName, email: lead.email,
      assignedAgent: lead.assignedAgent, pipelineValue: lead.pipelineValue ?? null,
    });
    const notification = getStageNotification(STAGES.READY, lead.name || "");
    if (notification && lead.phone) {
      try {
        await sendMessageWithRetry(contactId, { type: "SMS", message: notification.message }, { email: lead.email, phone: lead.phone, id: lead.id });
        await addConversation({ leadId: lead.id, channel: "SMS", direction: "outbound", messageBody: notification.message, senderType: "ai", senderName: notification.fromName });
      } catch { /* best effort */ }
    }
    try { await addNote(contactId, `🤖 Production completed by ${PRODUCTION_MANAGER}. Order ready for pickup/shipping.`); } catch { /* best effort */ }
  }

  if (titleLower.includes("ship") || titleLower.includes("pickup") || titleLower.includes("arrange")) {
    await updateLeadFields(lead.id, { pipelineStage: STAGES.DELIVERED });
    await handleStageAutomation(STAGES.DELIVERED, {
      id: lead.id, ghlContactId: contactId, name: lead.name,
      businessName: lead.businessName, email: lead.email,
      assignedAgent: lead.assignedAgent, pipelineValue: lead.pipelineValue ?? null,
    });
    try { await addNote(contactId, `🤖 Order delivered. Review request scheduled in 3 days. Reorder outreach in 30 days.`); } catch { /* best effort */ }
  }

  res.json({ success: true, action: "task_processed" });
}
