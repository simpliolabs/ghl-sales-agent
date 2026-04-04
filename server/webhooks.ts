import { Router, Request, Response } from "express";
import { upsertLead, addConversation, addPipelineEvent, getLeadByGhlContactId, updateLeadFields } from "./db";
import { generateAIResponse, classifySegment, shouldHandoffToAgent, generateContactNotes, estimateOrderValue } from "./ai-brain";
import { sendMessage, updateContactCustomField, createTask, addNote, updateOpportunityValue, updateOpportunityStage, fetchGhlConversationHistory } from "./ghl";
import { pushContactToOmnisend } from "./omnisend";
import { upsertAiState, getConversationHistory } from "./db";
import { addAgentAssignment, getAgentWorkload } from "./db";

// --- TEAM ROSTER ---
const SALES_AGENTS = ["Abby Bouwer", "Chris McHendry"];
const DESIGNER = "César Vásquez";
const PRODUCTION_MANAGER = "Cindy Muchnick";

// --- PIPELINE STAGES ---
const STAGES = {
  NEW_LEAD: "New Lead",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  QUOTE_SENT: "Quote Sent",
  PAID_PROOF_NEEDED: "Paid - Proof Needed",
  PROOF_SENT: "Proof Sent",
  APPROVED: "Approved + Deposit",
  IN_PRODUCTION: "In Production",
  READY: "Ready",
  DELIVERED: "Delivered",
} as const;

// --- CUSTOMER NOTIFICATION MESSAGES ---
function getStageNotification(stage: string, leadName: string, extras?: Record<string, string>): { message: string; fromName: string } | null {
  const firstName = (leadName || "").split(" ")[0] || "there";
  switch (stage) {
    case STAGES.CONTACTED:
      return null; // AI handles intro message separately
    case STAGES.QUALIFIED:
      return {
        message: `Hey ${firstName}! I've got everything I need to put together a custom quote for you. Let me get our team on it — you'll hear back shortly.`,
        fromName: "Adorb Custom Tees",
      };
    case STAGES.QUOTE_SENT:
      return null; // Agent sends the quote directly
    case STAGES.PAID_PROOF_NEEDED:
      return {
        message: `Payment received — thank you, ${firstName}! Our design team is working on your proof now. You'll see it within 1-3 business days depending on complexity.`,
        fromName: "Your Custom Tee Order",
      };
    case STAGES.PROOF_SENT:
      return {
        message: `Hey ${firstName}! Your proof is ready — take a look and let us know if you'd like any changes, or if it's good to go! 🎨`,
        fromName: "Your Custom Tee Order",
      };
    case STAGES.APPROVED:
      return {
        message: `Your design is approved and locked in, ${firstName}! We're moving it into production now. Estimated completion: ${extras?.turnaround || "3-7 business days"}.`,
        fromName: "Adorb Custom Tees",
      };
    case STAGES.IN_PRODUCTION:
      return null; // No proactive message — AI responds if customer asks
    case STAGES.READY:
      return {
        message: `Great news, ${firstName} — your order is ready! You can pick it up at our Hallandale Beach location, or we can ship it out today. What works best for you?`,
        fromName: "Adorb Custom Tees",
      };
    case STAGES.DELIVERED:
      return null; // Post-delivery review is scheduled, not immediate
    default:
      return null;
  }
}

// --- STAGE AUTOMATION: Team assignments and tasks ---
async function handleStageAutomation(stage: string, lead: { id: number; ghlContactId: string; name: string | null; businessName: string | null; email: string | null; assignedAgent: string | null; pipelineValue: number | null }, opportunityId?: string) {
  const leadLabel = lead.name || lead.businessName || "Lead";
  const contactId = lead.ghlContactId;

  switch (stage) {
    case STAGES.NEW_LEAD: {
      // AI handles: research, score, segment, first outreach
      // Auto-assign sales agent if not assigned
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
      // Create task for assigned sales agent to build a quote
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
      // Assign design proof task to César
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
      // Schedule proof follow-up in 2 days if no response
      const followUp = new Date();
      followUp.setDate(followUp.getDate() + 2);
      await updateLeadFields(lead.id, { nextFollowUpAt: followUp });
      try {
        await addNote(contactId, `🤖 Proof sent to customer. Follow-up scheduled for ${followUp.toLocaleDateString()} if no response.`);
      } catch { /* best effort */ }
      break;
    }

    case STAGES.APPROVED: {
      // Assign production task to Cindy
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
      // Assign shipping/pickup task to Cindy
      try {
        await createTask(contactId, {
          title: `📦 Ship/arrange pickup for ${leadLabel}`,
          body: `Order is ready. Arrange shipping or coordinate pickup with the customer.\n\nBusiness: ${lead.businessName || "N/A"}`,
          assignedTo: PRODUCTION_MANAGER,
        });
        await addNote(contactId, `🤖 Order ready. Shipping/pickup assigned to ${PRODUCTION_MANAGER}.`);
      } catch { /* best effort */ }
      // Schedule pickup follow-up in 1 day
      const pickupFollowUp = new Date();
      pickupFollowUp.setDate(pickupFollowUp.getDate() + 1);
      await updateLeadFields(lead.id, { nextFollowUpAt: pickupFollowUp });
      break;
    }

    case STAGES.DELIVERED: {
      // Schedule post-delivery review request (3 days) and reorder outreach (30 days)
      const reviewDate = new Date();
      reviewDate.setDate(reviewDate.getDate() + 3);
      await updateLeadFields(lead.id, { nextFollowUpAt: reviewDate });
      try {
        await addNote(contactId, `🤖 Order delivered. Review request scheduled for ${reviewDate.toLocaleDateString()}. Reorder outreach in 30 days.`);
      } catch { /* best effort */ }
      break;
    }

    default:
      break;
  }
}

export function createWebhookRouter(): Router {
  const router = Router();

  // --- UNIFIED GHL WEBHOOK ENDPOINT ---
  // All GHL workflows point to this single URL
  router.post("/api/webhooks/ghl", async (req: Request, res: Response) => {
    try {
      const payload = req.body;

      // Detect event type from payload
      const eventType = detectEventType(payload);

      switch (eventType) {
        case "contact":
          return await handleContactWebhook(payload, res);
        case "message":
          return await handleMessageWebhook(payload, res);
        case "pipeline":
          return await handlePipelineWebhook(payload, res);
        case "task":
          return await handleTaskWebhook(payload, res);
        default:
          // Try to handle as generic — check for contactId and route accordingly
          if (payload.body || payload.message || payload.messageType) {
            return await handleMessageWebhook(payload, res);
          }
          if (payload.currentStage || payload.toStage || payload.stageName || payload.pipelineId) {
            return await handlePipelineWebhook(payload, res);
          }
          if (payload.id || payload.contactId) {
            return await handleContactWebhook(payload, res);
          }
          res.json({ success: true, action: "unrecognized_event" });
      }
    } catch (err) {
      console.error("[Webhook] Error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // Keep legacy endpoints for backward compatibility
  router.post("/api/webhooks/ghl/contact", async (req: Request, res: Response) => {
    try { await handleContactWebhook(req.body, res); } catch (err) {
      console.error("[Webhook] Contact error:", err); res.status(500).json({ error: "Internal error" });
    }
  });

  router.post("/api/webhooks/ghl/message", async (req: Request, res: Response) => {
    try { await handleMessageWebhook(req.body, res); } catch (err) {
      console.error("[Webhook] Message error:", err); res.status(500).json({ error: "Internal error" });
    }
  });

  router.post("/api/webhooks/ghl/pipeline", async (req: Request, res: Response) => {
    try { await handlePipelineWebhook(req.body, res); } catch (err) {
      console.error("[Webhook] Pipeline error:", err); res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}

// --- EVENT TYPE DETECTION ---
function detectEventType(payload: Record<string, unknown>): "contact" | "message" | "pipeline" | "task" | "unknown" {
  // Check for explicit type field
  if (payload.type === "ContactCreate" || payload.type === "ContactUpdate" || payload.event === "contact.create") return "contact";
  if (payload.type === "InboundMessage" || payload.type === "OutboundMessage" || payload.event === "message.received" || payload.messageType) return "message";
  if (payload.type === "PipelineStageChanged" || payload.event === "opportunity.stageUpdate" || payload.currentStage || payload.toStage) return "pipeline";
  if (payload.type === "TaskCompleted" || payload.event === "task.completed" || (payload.taskId && payload.status === "completed")) return "task";
  // Check for message indicators
  if (payload.body && payload.contactId && (payload.direction || payload.messageId)) return "message";
  // Check for pipeline indicators
  if (payload.pipelineId || payload.stageName) return "pipeline";
  return "unknown";
}

// --- CONTACT HANDLER ---
async function handleContactWebhook(payload: Record<string, unknown>, res: Response) {
  const contactId = (payload.id || payload.contactId) as string;
  if (!contactId) { res.status(400).json({ error: "No contact ID" }); return; }

  const lead = await upsertLead({
    ghlContactId: contactId,
    name: payload.name as string || (payload.firstName ? `${payload.firstName || ""} ${payload.lastName || ""}`.trim() : undefined),
    email: payload.email as string,
    phone: payload.phone as string,
    businessName: (payload.companyName || payload.businessName) as string,
    website: payload.website as string,
    source: (payload.source || (payload.tags as string[])?.[0] || "ghl") as string,
  });

  if (lead && lead.businessName) {
    const segment = await classifySegment(lead.businessName, lead.website || undefined);
    await updateLeadFields(lead.id, { omnisendSegment: segment });

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
  }

  // Auto-assign sales agent and trigger New Lead automation
  if (lead) {
    await handleStageAutomation(STAGES.NEW_LEAD, {
      id: lead.id,
      ghlContactId: contactId,
      name: lead.name || null,
      businessName: lead.businessName || null,
      email: lead.email || null,
      assignedAgent: lead.assignedAgent || null,
      pipelineValue: null,
    });

    // --- INITIAL AI OUTREACH FOR NEW CONTACTS ---
    // Fetch GHL conversation history to check if there's an existing conversation
    // (e.g., form submission, chatbot interaction) and use it as context
    try {
      const ghlHistory = await fetchGhlConversationHistory(contactId);
      let ghlHistoryStr = "";
      let lastInboundMessage = "";

      if (ghlHistory.length > 0) {
        ghlHistoryStr = ghlHistory
          .filter(m => m.body && m.body.trim())
          .map(m => `[${m.direction === "outbound" ? "agent" : "lead"}/${m.type}] ${m.body}`)
          .join("\n");

        // Find the last inbound message from the lead (form submission, chat, etc.)
        const inboundMsgs = ghlHistory.filter(m => m.direction === "inbound" && m.body?.trim());
        if (inboundMsgs.length > 0) {
          lastInboundMessage = inboundMsgs[inboundMsgs.length - 1].body;
        }
      }

      // Only engage if the lead has a phone number (for SMS) or email
      if (lead.phone || lead.email) {
        const channel = lead.phone ? "SMS" : "Email";
        const introMessage = lastInboundMessage
          || `New lead: ${lead.name || "someone"} from ${lead.businessName || "a business"} just signed up. They're interested in custom printing.`;

        const aiResponse = await generateAIResponse(
          lead.id,
          introMessage,
          channel,
          ghlHistoryStr || undefined
        );

        // Send the AI response
        if (channel === "Email" && lead.email) {
          await sendMessage(contactId, { type: "Email", subject: aiResponse.fromName, html: aiResponse.message, fromName: aiResponse.fromName });
        } else if (lead.phone) {
          await sendMessage(contactId, { type: "SMS", message: aiResponse.message });
        }

        // Store the conversation
        await addConversation({
          leadId: lead.id,
          channel,
          direction: "outbound",
          messageBody: aiResponse.message,
          senderType: "ai",
          senderName: aiResponse.fromName,
        });

        // Update lead with AI scoring
        await updateLeadFields(lead.id, {
          opportunityScore: aiResponse.score,
          omnisendSegment: aiResponse.segment,
          lastMessageAt: new Date(),
        });

        await upsertAiState(lead.id, {
          lastAngleUsed: aiResponse.angle,
          lastFrameworkUsed: aiResponse.framework,
          extractedDates: aiResponse.extractedDates as unknown as undefined,
          messageCount: 1,
        });
      }
    } catch (err) {
      console.error("[Webhook] Initial AI outreach error (non-fatal):", err);
      // Non-fatal — contact is still saved even if AI outreach fails
    }
  }

  res.json({ success: true });
}

// --- CHANNEL NORMALIZATION ---
function normalizeChannel(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("email")) return "Email";
  if (lower.includes("whatsapp")) return "WhatsApp";
  if (lower.includes("fb") || lower.includes("facebook")) return "FB";
  if (lower.includes("ig") || lower.includes("instagram")) return "IG";
  // "SMS", "InboundMessage", "OutboundMessage", "TYPE_SMS", etc. → SMS
  return "SMS";
}

// --- MESSAGE HANDLER ---
async function handleMessageWebhook(payload: Record<string, unknown>, res: Response) {
  const contactId = payload.contactId as string;
  const messageBody = (payload.body || payload.message) as string;
  const rawChannel = (payload.messageType || payload.type || "SMS") as string;
  // Normalize channel: GHL webhooks may send type like "InboundMessage", "OutboundMessage" etc.
  const channel = normalizeChannel(rawChannel);
  const direction = (payload.direction || "inbound") as string;

  if (!contactId || !messageBody) { res.status(400).json({ error: "Missing data" }); return; }

  let lead = await getLeadByGhlContactId(contactId);
  if (!lead) {
    const newLead = await upsertLead({ ghlContactId: contactId, source: "ghl_message" });
    if (!newLead) { res.status(500).json({ error: "Failed to create lead" }); return; }
    lead = { ...newLead, id: newLead.id, humanTakeover: 0, lastAgentActivityAt: null, pipelineValue: null } as unknown as NonNullable<typeof lead>;
  }

  // Store the message
  await addConversation({
    leadId: lead!.id,
    channel,
    direction: direction === "outbound" ? "outbound" : "inbound",
    messageBody,
    senderType: direction === "outbound" ? "human" : "lead",
    ghlMessageId: payload.messageId as string,
  });

  await updateLeadFields(lead!.id, { lastMessageAt: new Date() });

  // If outbound from a human agent, mark agent activity
  if (direction === "outbound") {
    await updateLeadFields(lead!.id, {
      humanTakeover: 1,
      lastAgentActivityAt: new Date(),
    });
    res.json({ success: true, action: "human_message_logged" });
    return;
  }

  // --- SMART HANDOFF LOGIC ---
  let lastAgentHoursAgo: number | null = null;
  if (lead!.lastAgentActivityAt) {
    const agentTime = new Date(lead!.lastAgentActivityAt).getTime();
    lastAgentHoursAgo = (Date.now() - agentTime) / (1000 * 60 * 60);
  }

  // Fetch BOTH local and GHL conversation history for full context
  const convHistory = await getConversationHistory(lead!.id, 20);
  let historyStr = convHistory.map(c => `[${c.senderType}/${c.channel}] ${c.messageBody}`).join("\n");

  // If local history is thin, pull from GHL to get prior outreach context
  if (convHistory.length < 3) {
    try {
      const ghlHistory = await fetchGhlConversationHistory(contactId);
      if (ghlHistory.length > 0) {
        const ghlHistoryStr = ghlHistory
          .filter(m => m.body && m.body.trim())
          .map(m => `[${m.direction === "outbound" ? "agent" : "lead"}/${m.type}] ${m.body}`)
          .join("\n");
        if (ghlHistoryStr) {
          historyStr = `--- Prior GHL conversation history ---\n${ghlHistoryStr}\n--- Recent messages ---\n${historyStr}`;
        }
      }
    } catch { /* best effort — continue with local history only */ }
  }

  const handoffDecision = await shouldHandoffToAgent(historyStr, lastAgentHoursAgo);

  if (handoffDecision.handoff && !handoffDecision.resumeAI) {
    if (lead!.assignedAgent) {
      try {
        await createTask(contactId, {
          title: `💬 New message from ${lead!.name || "lead"} — you're managing this conversation`,
          body: `${lead!.name || "Lead"} replied: "${messageBody.substring(0, 200)}"\n\nReason AI is not responding: ${handoffDecision.reason}`,
          assignedTo: lead!.assignedAgent,
        });
      } catch { /* best effort */ }
    }
    res.json({ success: true, action: "handed_off_to_agent" });
    return;
  }

  if (handoffDecision.resumeAI) {
    await updateLeadFields(lead!.id, { humanTakeover: 0 });
  }

  if (lead!.humanTakeover && !handoffDecision.resumeAI) {
    res.json({ success: true, action: "human_takeover_active" });
    return;
  }

  // --- AI RESPONSE (with GHL history context) ---
  const aiResponse = await generateAIResponse(lead!.id, messageBody, channel, historyStr);

  // Check if AI wants to hand off (e.g., lead asking for firm quote)
  const aiHandoff = await shouldHandoffToAgent(
    historyStr + `\n[lead/${channel}] ${messageBody}`,
    null
  );

  if (aiHandoff.handoff) {
    const leadInfo = `${lead!.name || "Unknown"} - ${lead!.businessName || "Unknown"} - ${lead!.email || "N/A"}`;
    const [notes, valueEstimate] = await Promise.all([
      generateContactNotes(leadInfo, historyStr + `\n[lead/${channel}] ${messageBody}`),
      estimateOrderValue(historyStr + `\n[lead/${channel}] ${messageBody}`, leadInfo),
    ]);

    try { await addNote(contactId, `🤖 AI Handoff Notes:\n${notes}`); } catch { /* best effort */ }

    if (valueEstimate.estimatedValue > 0 && payload.opportunityId) {
      try { await updateOpportunityValue(payload.opportunityId as string, valueEstimate.estimatedValue); } catch { /* best effort */ }
    }

    await updateLeadFields(lead!.id, {
      humanTakeover: 1,
      lastAgentActivityAt: new Date(),
      pipelineValue: valueEstimate.estimatedValue,
    });

    if (lead!.assignedAgent) {
      try {
        await createTask(contactId, {
          title: `🔥 Quote needed: ${lead!.name || lead!.businessName || "Lead"} — Est. $${valueEstimate.estimatedValue}`,
          body: `Lead needs a firm quote. AI has handed off.\n\nReason: ${aiHandoff.reason}\n\n${notes}\n\nEstimated Value: $${valueEstimate.estimatedValue} (${valueEstimate.confidence} confidence)\n${valueEstimate.reasoning}`,
          assignedTo: lead!.assignedAgent,
        });
      } catch { /* best effort */ }
    }

    // Send handoff message
    if (channel === "Email") {
      await sendMessage(contactId, { type: "Email", subject: aiResponse.fromName, html: aiResponse.message, fromName: aiResponse.fromName });
    } else {
      await sendMessage(contactId, { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message });
    }

    await addConversation({
      leadId: lead!.id, channel, direction: "outbound", messageBody: aiResponse.message,
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

  await addConversation({
    leadId: lead!.id, channel, direction: "outbound", messageBody: aiResponse.message,
    senderType: "ai", senderName: aiResponse.fromName,
  });

  await upsertAiState(lead!.id, {
    lastAngleUsed: aiResponse.angle,
    lastFrameworkUsed: aiResponse.framework,
    extractedDates: aiResponse.extractedDates as unknown as undefined,
    messageCount: undefined,
  });

  await updateLeadFields(lead!.id, {
    opportunityScore: aiResponse.score,
    omnisendSegment: aiResponse.segment,
  });

  try {
    await updateContactCustomField(contactId, [
      { id: "opportunity_score", field_value: String(aiResponse.score) },
    ]);
  } catch { /* custom field may not exist yet */ }

  // Generate notes periodically (every 5 messages)
  const totalMsgs = convHistory.length;
  if (totalMsgs > 0 && totalMsgs % 5 === 0) {
    try {
      const leadInfo = `${lead!.name || "Unknown"} - ${lead!.businessName || "Unknown"}`;
      const notes = await generateContactNotes(leadInfo, historyStr);
      await addNote(contactId, `🤖 AI Summary (${new Date().toLocaleDateString()}):\n${notes}`);
    } catch { /* best effort */ }
  }

  // Estimate value periodically
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
    const earliestDate = new Date(aiResponse.extractedDates[0]);
    if (!isNaN(earliestDate.getTime())) {
      const daysUntilEvent = Math.floor((earliestDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysUntilEvent > 60) {
        nextFollowUp.setDate(nextFollowUp.getDate() + 30);
      } else if (daysUntilEvent > 30) {
        nextFollowUp.setDate(nextFollowUp.getDate() + 14);
      } else {
        nextFollowUp.setDate(nextFollowUp.getDate() + 3);
      }
    } else {
      nextFollowUp.setDate(nextFollowUp.getDate() + 3);
    }
  } else {
    nextFollowUp.setDate(nextFollowUp.getDate() + 3);
  }
  await updateLeadFields(lead!.id, { nextFollowUpAt: nextFollowUp });

  res.json({ success: true, action: "ai_responded" });
}

// --- PIPELINE STAGE CHANGE HANDLER ---
async function handlePipelineWebhook(payload: Record<string, unknown>, res: Response) {
  const contactId = (payload.contactId || payload.contact_id) as string;
  const fromStage = (payload.previousStage || payload.fromStage) as string;
  const toStage = (payload.currentStage || payload.toStage || payload.stageName) as string;
  const monetaryValue = (payload.monetaryValue || payload.value) as number | undefined;
  const opportunityId = (payload.opportunityId || payload.opportunity_id) as string | undefined;

  if (!contactId) { res.status(400).json({ error: "Missing contact ID" }); return; }

  const lead = await getLeadByGhlContactId(contactId);
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  await addPipelineEvent({
    leadId: lead.id,
    fromStage,
    toStage,
    triggeredBy: "webhook",
  });

  // Sync pipeline value and stage
  const updateFields: Record<string, unknown> = { pipelineStage: toStage };
  if (monetaryValue !== undefined && monetaryValue !== null) {
    updateFields.pipelineValue = Number(monetaryValue);
  }
  await updateLeadFields(lead.id, updateFields);

  // --- EXECUTE STAGE-SPECIFIC AUTOMATION ---
  await handleStageAutomation(toStage, {
    id: lead.id,
    ghlContactId: contactId,
    name: lead.name,
    businessName: lead.businessName,
    email: lead.email,
    assignedAgent: lead.assignedAgent,
    pipelineValue: monetaryValue !== undefined ? Number(monetaryValue) : (lead.pipelineValue ?? null),
  }, opportunityId);

  // --- SEND CUSTOMER NOTIFICATION ---
  const notification = getStageNotification(toStage, lead.name || "");
  if (notification) {
    try {
      // Try SMS first, fallback to email
      if (lead.phone) {
        await sendMessage(contactId, { type: "SMS", message: notification.message });
      } else if (lead.email) {
        await sendMessage(contactId, { type: "Email", subject: notification.fromName, html: notification.message, fromName: notification.fromName });
      }
      // Log the notification
      await addConversation({
        leadId: lead.id,
        channel: lead.phone ? "SMS" : "Email",
        direction: "outbound",
        messageBody: notification.message,
        senderType: "ai",
        senderName: notification.fromName,
      });
    } catch (err) {
      console.error("[Webhook] Failed to send stage notification:", err);
    }
  }

  res.json({ success: true, stage: toStage });
}

// --- TASK COMPLETED HANDLER ---
async function handleTaskWebhook(payload: Record<string, unknown>, res: Response) {
  const contactId = (payload.contactId || payload.contact_id) as string;
  const taskTitle = (payload.title || payload.taskTitle || "") as string;
  const status = (payload.status || "") as string;

  if (status !== "completed" || !contactId) {
    res.json({ success: true, action: "ignored" });
    return;
  }

  const lead = await getLeadByGhlContactId(contactId);
  if (!lead) { res.json({ success: true, action: "lead_not_found" }); return; }

  // Determine which stage to advance to based on the completed task
  const titleLower = taskTitle.toLowerCase();

  if (titleLower.includes("design proof") || titleLower.includes("create proof")) {
    // César finished the proof → move to Proof Sent
    await updateLeadFields(lead.id, { pipelineStage: STAGES.PROOF_SENT });
    await handleStageAutomation(STAGES.PROOF_SENT, {
      id: lead.id, ghlContactId: contactId, name: lead.name,
      businessName: lead.businessName, email: lead.email,
      assignedAgent: lead.assignedAgent, pipelineValue: lead.pipelineValue ?? null,
    });
    const notification = getStageNotification(STAGES.PROOF_SENT, lead.name || "");
    if (notification && lead.phone) {
      try {
        await sendMessage(contactId, { type: "SMS", message: notification.message });
        await addConversation({ leadId: lead.id, channel: "SMS", direction: "outbound", messageBody: notification.message, senderType: "ai", senderName: notification.fromName });
      } catch { /* best effort */ }
    }
    try { await addNote(contactId, `🤖 Design proof completed by ${DESIGNER}. Sent to customer for approval.`); } catch { /* best effort */ }
  }

  if (titleLower.includes("start production") || titleLower.includes("production for")) {
    // Cindy finished production → move to Ready
    await updateLeadFields(lead.id, { pipelineStage: STAGES.READY });
    await handleStageAutomation(STAGES.READY, {
      id: lead.id, ghlContactId: contactId, name: lead.name,
      businessName: lead.businessName, email: lead.email,
      assignedAgent: lead.assignedAgent, pipelineValue: lead.pipelineValue ?? null,
    });
    const notification = getStageNotification(STAGES.READY, lead.name || "");
    if (notification && lead.phone) {
      try {
        await sendMessage(contactId, { type: "SMS", message: notification.message });
        await addConversation({ leadId: lead.id, channel: "SMS", direction: "outbound", messageBody: notification.message, senderType: "ai", senderName: notification.fromName });
      } catch { /* best effort */ }
    }
    try { await addNote(contactId, `🤖 Production completed by ${PRODUCTION_MANAGER}. Order ready for pickup/shipping.`); } catch { /* best effort */ }
  }

  if (titleLower.includes("ship") || titleLower.includes("pickup") || titleLower.includes("arrange")) {
    // Cindy shipped/arranged pickup → move to Delivered
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
