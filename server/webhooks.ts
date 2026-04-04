import { Router, Request, Response } from "express";
import { upsertLead, addConversation, addPipelineEvent, getLeadByGhlContactId, updateLeadFields } from "./db";
import { generateAIResponse } from "./ai-brain";
import { classifySegment } from "./ai-brain";
import { sendMessage, updateContactCustomField, createTask } from "./ghl";
import { pushContactToOmnisend } from "./omnisend";
import { upsertAiState } from "./db";
import { addAgentAssignment, getAgentWorkload } from "./db";

const AGENTS = ["Abby Bouwer", "Chris McHendry"];

export function createWebhookRouter(): Router {
  const router = Router();

  // GHL Contact Create/Update webhook
  router.post("/api/webhooks/ghl/contact", async (req: Request, res: Response) => {
    try {
      const payload = req.body;
      const contactId = payload.id || payload.contactId;
      if (!contactId) { res.status(400).json({ error: "No contact ID" }); return; }

      const lead = await upsertLead({
        ghlContactId: contactId,
        name: payload.name || payload.firstName ? `${payload.firstName || ""} ${payload.lastName || ""}`.trim() : undefined,
        email: payload.email,
        phone: payload.phone,
        businessName: payload.companyName || payload.businessName,
        website: payload.website,
        source: payload.source || payload.tags?.[0] || "ghl",
      });

      if (lead && lead.businessName) {
        const segment = await classifySegment(lead.businessName, lead.website || undefined);
        await updateLeadFields(lead.id, { omnisendSegment: segment });

        // Push to Omnisend
        if (lead.email) {
          const nameParts = (lead.name || "").split(" ");
          await pushContactToOmnisend({
            email: lead.email,
            firstName: nameParts[0],
            lastName: nameParts.slice(1).join(" "),
            phone: lead.phone || undefined,
            tags: [segment],
          });
        }

        // Auto-assign agent (round-robin based on workload)
        if (!lead.assignedAgent) {
          const workload = await getAgentWorkload();
          const workloadMap: Record<string, number> = {};
          for (const w of workload) { if (w.agent) workloadMap[w.agent] = w.count; }
          let minAgent = AGENTS[0];
          let minCount = workloadMap[AGENTS[0]] || 0;
          for (const agent of AGENTS) {
            const count = workloadMap[agent] || 0;
            if (count < minCount) { minAgent = agent; minCount = count; }
          }
          await addAgentAssignment({ leadId: lead.id, agentName: minAgent, assignmentReason: "Auto-assigned via round-robin" });
        }
      }

      res.json({ success: true });
    } catch (err) {
      console.error("[Webhook] Contact error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GHL Inbound Message webhook
  router.post("/api/webhooks/ghl/message", async (req: Request, res: Response) => {
    try {
      const payload = req.body;
      const contactId = payload.contactId;
      const messageBody = payload.body || payload.message;
      const channel = payload.type || payload.messageType || "SMS";
      const direction = payload.direction || "inbound";

      if (!contactId || !messageBody) { res.status(400).json({ error: "Missing data" }); return; }

      let lead = await getLeadByGhlContactId(contactId);
      if (!lead) {
        const newLead = await upsertLead({ ghlContactId: contactId, source: "ghl_message" });
        if (!newLead) { res.status(500).json({ error: "Failed to create lead" }); return; }
        lead = { ...newLead, id: newLead.id, humanTakeover: 0 } as unknown as typeof lead & { id: number; humanTakeover: number };
      }

      // Store the inbound message
      await addConversation({
        leadId: lead!.id,
        channel,
        direction: direction === "outbound" ? "outbound" : "inbound",
        messageBody,
        senderType: direction === "outbound" ? "human" : "lead",
        ghlMessageId: payload.messageId,
      });

      await updateLeadFields(lead!.id, { lastMessageAt: new Date() });

      // If human has taken over, don't auto-respond
      if (lead!.humanTakeover) { res.json({ success: true, action: "human_takeover" }); return; }

      // If outbound (human sent), mark as human takeover temporarily
      if (direction === "outbound") {
        await updateLeadFields(lead!.id, { humanTakeover: 1 });
        res.json({ success: true, action: "human_message_logged" });
        return;
      }

      // Generate AI response
      const aiResponse = await generateAIResponse(lead!.id, messageBody, channel);

      // Send via GHL
      if (channel === "Email") {
        await sendMessage(contactId, {
          type: "Email",
          subject: aiResponse.fromName,
          html: aiResponse.message,
          fromName: aiResponse.fromName,
        });
      } else {
        await sendMessage(contactId, {
          type: channel as "SMS" | "WhatsApp" | "FB" | "IG",
          message: aiResponse.message,
        });
      }

      // Store outbound AI message
      await addConversation({
        leadId: lead!.id,
        channel,
        direction: "outbound",
        messageBody: aiResponse.message,
        senderType: "ai",
        senderName: aiResponse.fromName,
      });

      // Update AI state
      await upsertAiState(lead!.id, {
        lastAngleUsed: aiResponse.angle,
        lastFrameworkUsed: aiResponse.framework,
        extractedDates: aiResponse.extractedDates as unknown as undefined,
        messageCount: undefined, // will be incremented
      });

      // Update lead score and segment
      await updateLeadFields(lead!.id, {
        opportunityScore: aiResponse.score,
        omnisendSegment: aiResponse.segment,
      });

      // Update GHL custom field with score
      try {
        await updateContactCustomField(contactId, [
          { id: "opportunity_score", field_value: String(aiResponse.score) },
        ]);
      } catch { /* custom field may not exist yet */ }

      // Calculate next follow-up
      const nextFollowUp = new Date();
      nextFollowUp.setDate(nextFollowUp.getDate() + 3);
      await updateLeadFields(lead!.id, { nextFollowUpAt: nextFollowUp });

      res.json({ success: true, action: "ai_responded" });
    } catch (err) {
      console.error("[Webhook] Message error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GHL Pipeline Stage Change webhook
  router.post("/api/webhooks/ghl/pipeline", async (req: Request, res: Response) => {
    try {
      const payload = req.body;
      const contactId = payload.contactId;
      const fromStage = payload.previousStage || payload.fromStage;
      const toStage = payload.currentStage || payload.toStage || payload.stageName;

      if (!contactId) { res.status(400).json({ error: "Missing contact ID" }); return; }

      const lead = await getLeadByGhlContactId(contactId);
      if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

      await addPipelineEvent({
        leadId: lead.id,
        fromStage,
        toStage,
        triggeredBy: "webhook",
      });

      await updateLeadFields(lead.id, { pipelineStage: toStage });

      // Create task for assigned agent on stage transitions
      if (lead.assignedAgent && toStage) {
        const taskTitle = `Lead moved to ${toStage}: ${lead.name || lead.businessName || "Unknown"}`;
        try {
          await createTask(contactId, {
            title: taskTitle,
            body: `Pipeline stage changed from "${fromStage || "N/A"}" to "${toStage}". Review and take action.`,
          });
        } catch { /* task creation is best-effort */ }
      }

      res.json({ success: true });
    } catch (err) {
      console.error("[Webhook] Pipeline error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
