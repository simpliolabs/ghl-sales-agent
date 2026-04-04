import { Router, Request, Response } from "express";
import { upsertLead, addConversation, addPipelineEvent, getLeadByGhlContactId, updateLeadFields } from "./db";
import { generateAIResponse, classifySegment, shouldHandoffToAgent, generateContactNotes, estimateOrderValue } from "./ai-brain";
import { sendMessage, updateContactCustomField, createTask, addNote, updateOpportunityValue } from "./ghl";
import { pushContactToOmnisend } from "./omnisend";
import { upsertAiState, getConversationHistory } from "./db";
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
        lead = { ...newLead, id: newLead.id, humanTakeover: 0, lastAgentActivityAt: null } as unknown as typeof lead & { id: number; humanTakeover: number; lastAgentActivityAt: Date | null };
      }

      // Store the message
      await addConversation({
        leadId: lead!.id,
        channel,
        direction: direction === "outbound" ? "outbound" : "inbound",
        messageBody,
        senderType: direction === "outbound" ? "human" : "lead",
        ghlMessageId: payload.messageId,
      });

      await updateLeadFields(lead!.id, { lastMessageAt: new Date() });

      // If outbound from a human agent, mark agent activity and don't auto-respond
      if (direction === "outbound") {
        await updateLeadFields(lead!.id, {
          humanTakeover: 1,
          lastAgentActivityAt: new Date(),
        });
        res.json({ success: true, action: "human_message_logged" });
        return;
      }

      // --- SMART HANDOFF LOGIC ---
      // Calculate hours since last agent activity
      let lastAgentHoursAgo: number | null = null;
      if (lead!.lastAgentActivityAt) {
        const agentTime = new Date(lead!.lastAgentActivityAt).getTime();
        lastAgentHoursAgo = (Date.now() - agentTime) / (1000 * 60 * 60);
      }

      // Get conversation history for context
      const convHistory = await getConversationHistory(lead!.id, 20);
      const historyStr = convHistory.map(c => `[${c.senderType}/${c.channel}] ${c.messageBody}`).join("\n");

      // Check if we should hand off or resume
      const handoffDecision = await shouldHandoffToAgent(historyStr, lastAgentHoursAgo);

      if (handoffDecision.handoff && !handoffDecision.resumeAI) {
        // Stay handed off — notify agent via task
        if (lead!.assignedAgent) {
          try {
            await createTask(contactId, {
              title: `New message from ${lead!.name || "lead"} — you're managing this conversation`,
              body: `${lead!.name || "Lead"} replied: "${messageBody.substring(0, 200)}"\n\nReason AI is not responding: ${handoffDecision.reason}`,
            });
          } catch { /* best effort */ }
        }
        res.json({ success: true, action: "handed_off_to_agent" });
        return;
      }

      // If resuming after 24hr agent inactivity, clear handoff flag
      if (handoffDecision.resumeAI) {
        await updateLeadFields(lead!.id, { humanTakeover: 0 });
      }

      // If still in human takeover and not resuming, don't respond
      if (lead!.humanTakeover && !handoffDecision.resumeAI) {
        res.json({ success: true, action: "human_takeover_active" });
        return;
      }

      // --- AI RESPONSE ---
      const aiResponse = await generateAIResponse(lead!.id, messageBody, channel);

      // Check if AI wants to hand off (e.g., lead asking for firm quote)
      const aiHandoff = await shouldHandoffToAgent(
        historyStr + `\n[lead/${channel}] ${messageBody}`,
        null
      );

      if (aiHandoff.handoff) {
        // Hand off: generate notes for agent, estimate value, create task
        const leadInfo = `${lead!.name || "Unknown"} - ${lead!.businessName || "Unknown"} - ${lead!.email || "N/A"}`;
        
        const [notes, valueEstimate] = await Promise.all([
          generateContactNotes(leadInfo, historyStr + `\n[lead/${channel}] ${messageBody}`),
          estimateOrderValue(historyStr + `\n[lead/${channel}] ${messageBody}`, leadInfo),
        ]);

        // Add notes to GHL contact
        try {
          await addNote(contactId, `🤖 AI Handoff Notes:\n${notes}`);
        } catch { /* best effort */ }

        // Update pipeline value if estimated
        if (valueEstimate.estimatedValue > 0 && payload.opportunityId) {
          try {
            await updateOpportunityValue(payload.opportunityId, valueEstimate.estimatedValue);
          } catch { /* best effort */ }
        }

        // Update lead with estimated value
        await updateLeadFields(lead!.id, {
          humanTakeover: 1,
          lastAgentActivityAt: new Date(),
          pipelineValue: valueEstimate.estimatedValue,
        });

        // Create task for agent
        if (lead!.assignedAgent) {
          try {
            await createTask(contactId, {
              title: `🔥 Quote needed: ${lead!.name || lead!.businessName || "Lead"} — Est. $${valueEstimate.estimatedValue}`,
              body: `Lead needs a firm quote. AI has handed off.\n\nReason: ${aiHandoff.reason}\n\n${notes}\n\nEstimated Value: $${valueEstimate.estimatedValue} (${valueEstimate.confidence} confidence)\n${valueEstimate.reasoning}`,
            });
          } catch { /* best effort */ }
        }

        // Send a handoff message to the lead
        const handoffMsg = aiResponse.message; // AI already knows to redirect to agent for quotes
        if (channel === "Email") {
          await sendMessage(contactId, { type: "Email", subject: aiResponse.fromName, html: handoffMsg, fromName: aiResponse.fromName });
        } else {
          await sendMessage(contactId, { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: handoffMsg });
        }

        await addConversation({
          leadId: lead!.id, channel, direction: "outbound", messageBody: handoffMsg,
          senderType: "ai", senderName: aiResponse.fromName,
        });

        res.json({ success: true, action: "ai_responded_and_handed_off" });
        return;
      }

      // --- NORMAL AI RESPONSE ---
      if (channel === "Email") {
        await sendMessage(contactId, { type: "Email", subject: aiResponse.fromName, html: aiResponse.message, fromName: aiResponse.fromName });
      } else {
        await sendMessage(contactId, { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message });
      }

      // Store outbound AI message
      await addConversation({
        leadId: lead!.id, channel, direction: "outbound", messageBody: aiResponse.message,
        senderType: "ai", senderName: aiResponse.fromName,
      });

      // Update AI state
      await upsertAiState(lead!.id, {
        lastAngleUsed: aiResponse.angle,
        lastFrameworkUsed: aiResponse.framework,
        extractedDates: aiResponse.extractedDates as unknown as undefined,
        messageCount: undefined,
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

      // --- GENERATE NOTES periodically (every 5 messages) ---
      const totalMsgs = convHistory.length;
      if (totalMsgs > 0 && totalMsgs % 5 === 0) {
        try {
          const leadInfo = `${lead!.name || "Unknown"} - ${lead!.businessName || "Unknown"}`;
          const notes = await generateContactNotes(leadInfo, historyStr);
          await addNote(contactId, `🤖 AI Summary (${new Date().toLocaleDateString()}):\n${notes}`);
        } catch { /* best effort */ }
      }

      // --- ESTIMATE VALUE periodically ---
      if (totalMsgs > 2 && totalMsgs % 4 === 0) {
        try {
          const leadInfo = `${lead!.name || "Unknown"} - ${lead!.businessName || "Unknown"}`;
          const valueEstimate = await estimateOrderValue(historyStr, leadInfo);
          if (valueEstimate.estimatedValue > 0) {
            await updateLeadFields(lead!.id, { pipelineValue: valueEstimate.estimatedValue });
          }
        } catch { /* best effort */ }
      }

      // Calculate next follow-up based on context
      const nextFollowUp = new Date();
      if (aiResponse.extractedDates && aiResponse.extractedDates.length > 0) {
        // If dates extracted, schedule follow-up relative to earliest date
        const earliestDate = new Date(aiResponse.extractedDates[0]);
        if (!isNaN(earliestDate.getTime())) {
          const daysUntilEvent = Math.floor((earliestDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          if (daysUntilEvent > 60) {
            nextFollowUp.setDate(nextFollowUp.getDate() + 30); // Check in 30 days
          } else if (daysUntilEvent > 30) {
            nextFollowUp.setDate(nextFollowUp.getDate() + 14); // Check in 2 weeks
          } else {
            nextFollowUp.setDate(nextFollowUp.getDate() + 3); // Urgent — 3 days
          }
        } else {
          nextFollowUp.setDate(nextFollowUp.getDate() + 3);
        }
      } else {
        nextFollowUp.setDate(nextFollowUp.getDate() + 3);
      }
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
      const monetaryValue = payload.monetaryValue || payload.value;

      if (!contactId) { res.status(400).json({ error: "Missing contact ID" }); return; }

      const lead = await getLeadByGhlContactId(contactId);
      if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

      await addPipelineEvent({
        leadId: lead.id,
        fromStage,
        toStage,
        triggeredBy: "webhook",
      });

      // Sync pipeline value from GHL if manually set by agent
      const updateFields: Record<string, unknown> = { pipelineStage: toStage };
      if (monetaryValue !== undefined && monetaryValue !== null) {
        updateFields.pipelineValue = Number(monetaryValue);
      }
      await updateLeadFields(lead.id, updateFields);

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
