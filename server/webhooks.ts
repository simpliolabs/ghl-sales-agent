import { Router, Request, Response } from "express";
import { upsertLead, addConversation, addPipelineEvent, getLeadByGhlContactId, getLeadById, updateLeadFields } from "./db";
import { addBrainCouncilAudit, getBrainCouncilAuditForLead } from "./db";
import { classifySegment, shouldHandoffToAgent, generateContactNotes, estimateOrderValue } from "./ai-brain";
import { researchLead } from "./lead-researcher";
import { runBrainCouncil } from "./brain-council";
import { calculateNextFollowUp, checkRateLimits, checkLeadRateLimit } from "./scheduling-engine";
import { sendMessage, updateContactCustomField, createTask, addNote, updateOpportunityValue, updateOpportunityStage, fetchGhlConversationHistory, getContact, searchContacts } from "./ghl";
import { pushContactToOmnisend } from "./omnisend";
import { detectConfusion, handleConfusionReply, postSendValidation, retroactiveCorrectionScan } from "./auto-correction";
import { upsertAiState, getConversationHistory, getRecentAiOutboundCount } from "./db";
import { addAgentAssignment, getAgentWorkload, addWebhookLog } from "./db";

// --- GHL CONTACT ID RESOLUTION ---
// GHL workflow webhooks often send wrong/mismatched contact IDs.
// This function resolves the REAL GHL contact ID by:
// 1. Trying the provided ID directly
// 2. If that fails, searching by email or phone
// Returns { resolvedId, contact } or null
async function resolveGhlContactId(
  webhookContactId: string,
  fallbackEmail?: string | null,
  fallbackPhone?: string | null
): Promise<{ resolvedId: string; contact: Record<string, unknown> } | null> {
  // Step 1: Try direct lookup
  try {
    const contact = await getContact(webhookContactId);
    if (contact) {
      return { resolvedId: webhookContactId, contact };
    }
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status !== 400 && status !== 404) {
      console.error(`[GHL Resolve] Unexpected error for ${webhookContactId}:`, err);
    } else {
      console.log(`[GHL Resolve] Contact ${webhookContactId} not found (${status}), trying search...`);
    }
  }

  // Step 2: Search by email
  if (fallbackEmail) {
    try {
      const results = await searchContacts(fallbackEmail, 1);
      if (results.length > 0) {
        console.log(`[GHL Resolve] Found contact by email ${fallbackEmail}: ${results[0].id}`);
        return { resolvedId: results[0].id, contact: results[0] };
      }
    } catch (err) {
      console.error(`[GHL Resolve] Email search failed:`, err);
    }
  }

  // Step 3: Search by phone
  if (fallbackPhone) {
    try {
      const results = await searchContacts(fallbackPhone, 1);
      if (results.length > 0) {
        console.log(`[GHL Resolve] Found contact by phone ${fallbackPhone}: ${results[0].id}`);
        return { resolvedId: results[0].id, contact: results[0] };
      }
    } catch (err) {
      console.error(`[GHL Resolve] Phone search failed:`, err);
    }
  }

  console.log(`[GHL Resolve] Could not resolve contact for webhook ID ${webhookContactId}`);
  return null;
}

// --- GHL API FALLBACK ENRICHMENT ---
// Enrich lead data from a resolved GHL contact
function extractContactData(ghlContact: Record<string, unknown>): Record<string, unknown> {
  const enriched: Record<string, unknown> = {};
  const ghlName = (ghlContact.name as string) || (ghlContact.firstName ? `${ghlContact.firstName} ${ghlContact.lastName || ""}`.trim() : null);
  if (ghlName) enriched.name = ghlName;
  if (ghlContact.email) enriched.email = ghlContact.email;
  if (ghlContact.phone) enriched.phone = ghlContact.phone;
  if (ghlContact.companyName) enriched.businessName = ghlContact.companyName;
  if (ghlContact.website) enriched.website = ghlContact.website;
  if (ghlContact.source) enriched.source = ghlContact.source;
  return enriched;
}

// Send message with automatic contact ID resolution retry
async function sendMessageWithRetry(
  contactId: string,
  opts: Parameters<typeof sendMessage>[1],
  lead: { email?: string | null; phone?: string | null; id: number }
): Promise<{ success: boolean; resolvedContactId: string; error?: string }> {
  try {
    await sendMessage(contactId, opts);
    return { success: true, resolvedContactId: contactId };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 400 || status === 404) {
      console.log(`[SendRetry] Contact ${contactId} not found, resolving real ID...`);
      const resolved = await resolveGhlContactId(contactId, lead.email, lead.phone);
      if (resolved && resolved.resolvedId !== contactId) {
        // Update lead with correct GHL contact ID
        await updateLeadFields(lead.id, { ghlContactId: resolved.resolvedId });
        console.log(`[SendRetry] Resolved to ${resolved.resolvedId}, retrying send...`);
        try {
          await sendMessage(resolved.resolvedId, opts);
          return { success: true, resolvedContactId: resolved.resolvedId };
        } catch (retryErr: unknown) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`[SendRetry] Retry also failed:`, retryMsg);
          return { success: false, resolvedContactId: resolved.resolvedId, error: retryMsg };
        }
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, resolvedContactId: contactId, error: errMsg };
  }
}

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
      // Use scheduling engine for proof follow-up
      const proofSchedule = await calculateNextFollowUp({ leadId: lead.id, triggerEvent: "stage_change", stageTransition: "Proof Sent" });
      await updateLeadFields(lead.id, { nextFollowUpAt: proofSchedule.nextFollowUpAt, cadencePosition: proofSchedule.cadencePosition });
      try {
        await addNote(contactId, `🤖 Proof sent to customer. Follow-up scheduled for ${proofSchedule.nextFollowUpAt.toLocaleDateString()} if no response. [${proofSchedule.reason}]`);
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
      // Use scheduling engine for pickup follow-up
      const readySchedule = await calculateNextFollowUp({ leadId: lead.id, triggerEvent: "stage_change", stageTransition: "Ready" });
      await updateLeadFields(lead.id, { nextFollowUpAt: readySchedule.nextFollowUpAt, cadencePosition: readySchedule.cadencePosition });
      break;
    }

    case STAGES.DELIVERED: {
      // Use scheduling engine for post-delivery follow-up
      const deliveredSchedule = await calculateNextFollowUp({ leadId: lead.id, triggerEvent: "stage_change", stageTransition: "Delivered" });
      await updateLeadFields(lead.id, { nextFollowUpAt: deliveredSchedule.nextFollowUpAt, cadencePosition: deliveredSchedule.cadencePosition });
      try {
        await addNote(contactId, `🤖 Order delivered. ${deliveredSchedule.reason}`);
      } catch { /* best effort */ }
      break;
    }

    default:
      break;
  }
}

export function createWebhookRouter(): Router {
  const router = Router();

  // --- RETROACTIVE CORRECTION SCAN (every 15 minutes) ---
  setInterval(async () => {
    try {
      const corrected = await retroactiveCorrectionScan();
      if (corrected > 0) console.log(`[AutoCorrect/Timer] Retroactive scan corrected ${corrected} messages`);
    } catch (err) {
      console.error('[AutoCorrect/Timer] Scan error:', err);
    }
  }, 15 * 60 * 1000);

  // --- WEBHOOK HEALTH CHECK ---
  router.get("/api/webhooks/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      message: "Adorb Outreach webhook endpoint is healthy",
    });
  });

  // --- UNIFIED GHL WEBHOOK ENDPOINT ---
  // All GHL workflows point to this single URL
  router.post("/api/webhooks/ghl", async (req: Request, res: Response) => {
    const startTime = Date.now();
    const payload = req.body;
    const contactId = (payload.contactId || payload.id || "") as string;
    let detectedType = "unknown";
    let action = "";
    let logError = "";

    try {
      // Detect event type from payload
      detectedType = detectEventType(payload);

      // Summarize ALL payload fields for logging (truncated) — capture everything GHL sends
      const payloadSummary = JSON.stringify({
        ...Object.fromEntries(
          Object.entries(payload).map(([k, v]) => [
            k,
            typeof v === 'string' ? v.substring(0, 200) : v
          ])
        ),
      }).substring(0, 2000);

      switch (detectedType) {
        case "contact":
          action = "contact_handler";
          await handleContactWebhook(payload, res);
          break;
        case "message":
          action = "message_handler";
          await handleMessageWebhook(payload, res);
          break;
        case "pipeline":
          action = "pipeline_handler";
          await handlePipelineWebhook(payload, res);
          break;
        case "task":
          action = "task_handler";
          await handleTaskWebhook(payload, res);
          break;
        default:
          // Try to handle as generic
          if (payload.body || payload.message || payload.messageType) {
            action = "fallback_message";
            await handleMessageWebhook(payload, res);
          } else if (payload.currentStage || payload.toStage || payload.stageName || payload.pipelineId) {
            action = "fallback_pipeline";
            await handlePipelineWebhook(payload, res);
          } else if (payload.id || payload.contactId) {
            action = "fallback_contact";
            await handleContactWebhook(payload, res);
          } else {
            action = "unrecognized";
            res.json({ success: true, action: "unrecognized_event" });
          }
      }

      // Log successful webhook
      addWebhookLog({
        eventType: (payload.type || payload.event || "unknown") as string,
        detectedType,
        contactId: contactId || undefined,
        payloadSummary,
        action,
        processingMs: Date.now() - startTime,
      }).catch(() => {});

    } catch (err) {
      logError = err instanceof Error ? err.message : String(err);
      console.error("[Webhook] Error:", err);

      // Log failed webhook
      addWebhookLog({
        eventType: (payload?.type || payload?.event || "unknown") as string,
        detectedType,
        contactId: contactId || undefined,
        action,
        error: logError,
        processingMs: Date.now() - startTime,
      }).catch(() => {});

      if (!res.headersSent) {
        res.status(500).json({ error: "Internal error" });
      }
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

  let lead = await upsertLead({
    ghlContactId: contactId,
    name: payload.name as string || (payload.firstName ? `${payload.firstName || ""} ${payload.lastName || ""}`.trim() : undefined),
    email: payload.email as string,
    phone: payload.phone as string,
    businessName: (payload.companyName || payload.businessName) as string,
    website: payload.website as string,
    source: (payload.source || (payload.tags as string[])?.[0] || "ghl") as string,
  });

  // GHL CONTACT ID RESOLUTION: Resolve the real GHL contact ID
  // GHL workflow webhooks often send wrong/mismatched IDs
  let resolvedContactId = contactId;
  if (lead) {
    const resolved = await resolveGhlContactId(contactId, lead.email || (payload.email as string), lead.phone || (payload.phone as string));
    if (resolved) {
      resolvedContactId = resolved.resolvedId;
      // Update lead with correct GHL contact ID if it changed
      if (resolvedContactId !== contactId) {
        console.log(`[Webhook] Contact ID resolved: ${contactId} → ${resolvedContactId}`);
        await updateLeadFields(lead.id, { ghlContactId: resolvedContactId });
      }
      // Enrich lead with data from resolved contact
      const enriched = extractContactData(resolved.contact);
      const updates: Record<string, unknown> = {};
      if (!lead.name && enriched.name) updates.name = enriched.name;
      if (!lead.email && enriched.email) updates.email = enriched.email;
      if (!lead.phone && enriched.phone) updates.phone = enriched.phone;
      if (!lead.businessName && enriched.businessName) updates.businessName = enriched.businessName;
      if (!lead.website && enriched.website) updates.website = enriched.website;
      if (!lead.source && enriched.source) updates.source = enriched.source;
      if (Object.keys(updates).length > 0) {
        await updateLeadFields(lead.id, updates);
        console.log(`[Webhook] Enriched lead ${lead.id} with: ${Object.keys(updates).join(", ")}`);
        lead = { ...lead, ...updates } as typeof lead;
      }
    }
  }

  if (lead && lead.businessName) {
    const segment = await classifySegment(lead.businessName, lead.website || undefined);
    // Generate REAL research context using online sources (LinkedIn + LLM synthesis)
    try {
      const research = await researchLead({
        name: lead.name || undefined,
        businessName: lead.businessName || undefined,
        source: lead.source || undefined,
        website: lead.website || undefined,
        segment,
        email: lead.email || undefined,
      });
      await updateLeadFields(lead.id, { omnisendSegment: segment, researchData: research });
    } catch (err) {
      console.error("[Webhook] Research failed for lead", lead.id, err);
      await updateLeadFields(lead.id, { omnisendSegment: segment });
    }

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

    // Use scheduling engine for initial follow-up timing
    const initialSchedule = await calculateNextFollowUp({ leadId: lead.id, triggerEvent: "new_lead" });
    await updateLeadFields(lead.id, { nextFollowUpAt: initialSchedule.nextFollowUpAt, cadencePosition: initialSchedule.cadencePosition });

    // =================================================================
    // LOCKED FIRST-CONTACT SEQUENCE (Hormozi ACA — No Brain Council)
    // =================================================================
    // Two-message template. No AI generation. No research. Deterministic.
    // Aligned with Alex Hormozi's ACA (Acknowledge, Compliment, Ask):
    //   MSG 1: Acknowledge their request + Social proof (4.9 stars)
    //   MSG 2: One low-friction Ask (design readiness)
    // =================================================================
    try {
      // GLOBAL RATE LIMIT CHECK
      const rateCheck = await checkRateLimits();
      if (!rateCheck.allowed) {
        console.log(`[Webhook] Rate limit hit for lead ${lead.id}: ${rateCheck.reason}`);
        res.json({ success: true, action: "rate_limited" });
        return;
      }

      // PER-LEAD RATE LIMIT CHECK
      const leadAllowed = await checkLeadRateLimit(lead.id);
      if (!leadAllowed) {
        console.log(`[Webhook] Per-lead rate limit for lead ${lead.id} — already contacted in last 24h`);
        res.json({ success: true, action: "lead_rate_limited" });
        return;
      }

      // DEDUP GUARD: Skip if we already sent an AI message to this lead in the last 15 minutes
      const recentAiCount = await getRecentAiOutboundCount(lead.id, 15);
      if (recentAiCount > 0) {
        console.log(`[Webhook] Skipping first-contact for lead ${lead.id} — ${recentAiCount} message(s) sent in last 15 min`);
        res.json({ success: true, action: "dedup_skipped" });
        return;
      }

      // --- EXTRACT FORM DATA ---
      // Try webhook payload first, then GHL contact custom fields
      let formFields = extractFormData(payload);
      
      // If webhook payload had no form data, pull from GHL contact custom fields
      if (formFields.length === 0) {
        try {
          const ghlContact = await getContact(resolvedContactId);
          if (ghlContact?.customFields) {
            formFields = extractFormData({ customFields: ghlContact.customFields });
          }
        } catch { /* best effort */ }
      }

      // --- DETECT CHANNEL ---
      const ghlHistory = await fetchGhlConversationHistory(resolvedContactId);
      let detectedChannel = "";
      if (ghlHistory.length > 0) {
        const lastInbound = [...ghlHistory].reverse().find(m => m.direction === "inbound");
        if (lastInbound) {
          const rawType = String(lastInbound.type || "").toLowerCase();
          if (rawType.includes("fb") || rawType.includes("facebook")) detectedChannel = "FB";
          else if (rawType.includes("ig") || rawType.includes("instagram")) detectedChannel = "IG";
          else if (rawType.includes("whatsapp")) detectedChannel = "WhatsApp";
          else if (rawType.includes("email")) detectedChannel = "Email";
          else if (rawType.includes("sms") || rawType.includes("message")) detectedChannel = "SMS";
        }
      }
      if (!detectedChannel) {
        const src = (payload.source as string || "").toLowerCase();
        if (src.includes("facebook") || src.includes("fb")) detectedChannel = "FB";
        else if (src.includes("instagram") || src.includes("ig")) detectedChannel = "IG";
        else if (src.includes("whatsapp")) detectedChannel = "WhatsApp";
        else if (lead.email && !lead.phone) detectedChannel = "Email";
        else if (lead.phone) detectedChannel = "SMS";
        else if (lead.email) detectedChannel = "Email";
      }

      if (detectedChannel && (lead.phone || lead.email)) {
        const channel = detectedChannel as "SMS" | "Email" | "WhatsApp" | "FB" | "IG";

        // --- REFRESH LEAD to get assigned agent name ---
        const freshLead = await getLeadById(lead.id);
        const agentName = freshLead?.assignedAgent || lead.assignedAgent || SALES_AGENTS[0];
        const firstName = (lead.name || "").split(" ")[0] || "there";

        // --- EXTRACT FORM FIELDS FOR TEMPLATE ---
        const productType = formFields.find(f => f.label === "Product Type")?.value || "custom gear";
        const purpose = formFields.find(f => f.label === "Purpose")?.value || "";
        const timeline = formFields.find(f => f.label === "Timeline")?.value || "";

        // --- BUILD MESSAGE 1: Intro (Acknowledge + Social Proof) ---
        // Template: Hi {name}, {agentName} here! Adorb has a 4.9 star review
        // helping {business type} with customized {product requested} {in the timeline requested}.
        let msg1 = `Hi ${firstName}, ${agentName.split(" ")[0]} here! Adorb has a 4.9 star review helping`;
        if (purpose) {
          msg1 += ` ${purpose.toLowerCase()}`;
        } else {
          msg1 += ` businesses like yours`;
        }
        msg1 += ` with customized ${productType.toLowerCase()}`;
        if (timeline) {
          msg1 += ` ${timeline.toLowerCase()}`;
        }
        msg1 += `.`;

        // --- BUILD MESSAGE 2: Ask (Design readiness) ---
        const msg2 = `Do you have a design ready or would you like our team to help?`;

        console.log(`[Webhook] LOCKED first-contact for lead ${lead.id} (${firstName}): agent=${agentName}, channel=${channel}`);
        console.log(`[Webhook] MSG1: ${msg1}`);
        console.log(`[Webhook] MSG2: ${msg2}`);

        // --- SEND MESSAGE 1 ---
        const buildSendOpts = (message: string): Parameters<typeof sendMessage>[1] | undefined => {
          if (channel === "Email" && lead.email) {
            return { type: "Email", subject: `${agentName.split(" ")[0]} from Adorb Custom Tees`, html: `<p>${message}</p><p>${msg2}</p>`, fromName: agentName };
          } else if (channel === "FB") {
            return { type: "FB", message };
          } else if (channel === "IG") {
            return { type: "IG", message };
          } else if (channel === "WhatsApp") {
            return { type: "WhatsApp", message };
          } else if (lead.phone) {
            return { type: "SMS", message };
          }
          return undefined;
        };

        const sendOpts1 = buildSendOpts(msg1);
        let msg1Sent = false;
        let msg2Sent = false;

        if (sendOpts1) {
          const sendResult1 = await sendMessageWithRetry(resolvedContactId, sendOpts1, { email: lead.email, phone: lead.phone, id: lead.id });
          if (sendResult1.resolvedContactId !== resolvedContactId) {
            resolvedContactId = sendResult1.resolvedContactId;
          }
          msg1Sent = sendResult1.success;
          if (!msg1Sent) {
            console.error(`[Webhook] Failed to send MSG1 to lead ${lead.id}: ${sendResult1.error}`);
          }
        }

        // Store MSG1 conversation
        await addConversation({
          leadId: lead.id,
          channel,
          direction: "outbound",
          messageBody: msg1,
          senderType: "ai",
          senderName: agentName,
        });

        // --- SEND MESSAGE 2 (immediate follow-up, except for Email where both are in one) ---
        if (channel !== "Email") {
          // Small delay to feel natural (2 seconds)
          await new Promise(resolve => setTimeout(resolve, 2000));

          const sendOpts2 = buildSendOpts(msg2);
          if (sendOpts2) {
            const sendResult2 = await sendMessageWithRetry(resolvedContactId, sendOpts2, { email: lead.email, phone: lead.phone, id: lead.id });
            msg2Sent = sendResult2.success;
            if (!msg2Sent) {
              console.error(`[Webhook] Failed to send MSG2 to lead ${lead.id}: ${sendResult2.error}`);
            }
          }

          // Store MSG2 conversation
          await addConversation({
            leadId: lead.id,
            channel,
            direction: "outbound",
            messageBody: msg2,
            senderType: "ai",
            senderName: agentName,
          });
        }

        // --- AUDIT LOG: Record the locked first-contact ---
        try {
          await addBrainCouncilAudit({
            leadId: lead.id,
            leadName: lead.name || undefined,
            channel,
            incomingMessage: `[FIRST CONTACT] Form data: ${formFields.map(f => `${f.label}=${f.value}`).join(", ") || "none"}`,
            strategyApproach: "first_contact",
            strategyFramework: "HORMOZI_ACA",
            strategyReasoning: "LOCKED TEMPLATE — No Brain Council. Deterministic two-message welcome sequence.",
            strategyTier: "1",
            researchSummary: "SKIPPED — Research disabled for first contact.",
            composedMessage: msg1,
            composerFromName: agentName,
            qcScore: 100,
            qcApproved: 1,
            qcIssues: undefined,
            qcFeedback: undefined,
            wasRecomposed: 0,
            finalMessage: channel === "Email" ? `${msg1}\n\n${msg2}` : `${msg1} | ${msg2}`,
            messageSent: (msg1Sent ? 1 : 0),
          });
        } catch (auditErr) {
          console.error('[Webhook] First-contact audit log error (non-fatal):', auditErr);
        }

        // --- UPDATE LEAD STATE ---
        const contactSchedule = await calculateNextFollowUp({
          leadId: lead.id,
          aiSuggestedHours: 4, // Follow up in 4 hours if no reply
          triggerEvent: "ai_response",
        });

        await updateLeadFields(lead.id, {
          lastMessageAt: new Date(),
          nextFollowUpAt: contactSchedule.nextFollowUpAt,
          cadencePosition: contactSchedule.cadencePosition,
          preferredChannel: contactSchedule.channel,
          lastOutboundChannel: channel,
        });

        await upsertAiState(lead.id, {
          lastAngleUsed: "LOCKED_FIRST_CONTACT",
          lastFrameworkUsed: "HORMOZI_ACA",
          messageCount: channel === "Email" ? 1 : 2,
        });

        console.log(`[Webhook] First-contact COMPLETE for lead ${lead.id}: msg1=${msg1Sent}, msg2=${msg2Sent || channel === "Email"}`);
      }
    } catch (err) {
      console.error("[Webhook] First-contact outreach error (non-fatal):", err);
      // Non-fatal — contact is still saved even if outreach fails
    }
  }

  res.json({ success: true });
}

// --- FORM DATA EXTRACTION ---
// Extract structured form fields from GHL webhook payloads (Facebook lead forms, etc.)
function extractFormData(payload: Record<string, unknown>): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];
  
  // Known GHL form field keys from Facebook lead forms
  // Includes both human-readable keys AND GHL custom field UUIDs
  const formFieldMappings: Record<string, string> = {
    "what_type_of_products_are_you_interested_in_": "Product Type",
    "what_do_you_need_bulk_printing_for_": "Purpose",
    "how_soon_do_you_need_your_order_": "Timeline",
    "company_name": "Company",
    "companyName": "Company",
    "full_name": "Full Name",
    "quantity": "Quantity",
    // GHL custom field UUIDs (from /locations/{id}/customFields API)
    "7bBSRMZOMh7S8z57PmX9": "Timeline",
    "OUKhuVmDD7yg44tKAYAs": "Product Type",
    "skKuaUesHa1fLm9Cq75U": "Purpose",
    "7fL3fX0KnOUcm7BOvjdi": "Quantity",
    "GCGSXhfM0eHz6MZS6tyZ": "Order Categories",
    "XcZmRrIAuIgJq64VFjhq": "Print Style",
    "vRQQP78R7rDNaXjoEFt3": "Garment Type",
    "Uq2VcaIrV7U5m5LJQKO3": "Print Size",
    "hyHJeRQGmIGbaulYhoHQ": "Sizes and Amount",
  };

  // Check top-level payload fields
  for (const [key, label] of Object.entries(formFieldMappings)) {
    const val = payload[key];
    if (val && typeof val === "string" && val.trim()) {
      fields.push({ label, value: val.trim() });
    }
  }

  // Check nested customFields or customField arrays
  const customFields = (payload.customFields || payload.customField) as Record<string, unknown>[] | Record<string, unknown> | undefined;
  if (Array.isArray(customFields)) {
    for (const cf of customFields) {
      const key = (cf.id || cf.key || cf.field_key || "") as string;
      const val = (cf.value || cf.field_value || "") as string;
      if (key && val && typeof val === "string" && val.trim()) {
        const label = formFieldMappings[key] || key.replace(/_/g, " ").replace(/\?/g, "");
        fields.push({ label, value: val.trim() });
      }
    }
  } else if (customFields && typeof customFields === "object") {
    for (const [key, val] of Object.entries(customFields)) {
      if (val && typeof val === "string" && val.trim()) {
        const label = formFieldMappings[key] || key.replace(/_/g, " ").replace(/\?/g, "");
        fields.push({ label, value: val.trim() });
      }
    }
  }

  return fields;
}

// --- CHANNEL NORMALIZATION ---
function normalizeChannel(raw: unknown): string {
  const lower = String(raw || "SMS").toLowerCase();
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

  // DEDUP: Skip outbound echoes from our own AI messages
  // GHL sends webhooks for messages WE sent — detect and skip them
  if (direction === "outbound") {
    // Check if this is an echo of our own AI message (already stored)
    // We'll still log it but won't trigger AI response
  }

  let lead = await getLeadByGhlContactId(contactId);
  if (!lead) {
    const newLead = await upsertLead({ ghlContactId: contactId, source: "ghl_message" });
    if (!newLead) { res.status(500).json({ error: "Failed to create lead" }); return; }
    lead = { ...newLead, id: newLead.id, humanTakeover: 0, lastAgentActivityAt: null, pipelineValue: null } as unknown as NonNullable<typeof lead>;
  }

  // GHL CONTACT ID RESOLUTION + ENRICHMENT
  let resolvedContactId = contactId;
  {
    const resolved = await resolveGhlContactId(contactId, lead!.email, lead!.phone);
    if (resolved) {
      resolvedContactId = resolved.resolvedId;
      if (resolvedContactId !== contactId) {
        console.log(`[Webhook/Msg] Contact ID resolved: ${contactId} → ${resolvedContactId}`);
        await updateLeadFields(lead!.id, { ghlContactId: resolvedContactId });
      }
      const enriched = extractContactData(resolved.contact);
      const updates: Record<string, unknown> = {};
      if (!lead!.name && enriched.name) updates.name = enriched.name;
      if (!lead!.email && enriched.email) updates.email = enriched.email;
      if (!lead!.phone && enriched.phone) updates.phone = enriched.phone;
      if (!lead!.businessName && enriched.businessName) updates.businessName = enriched.businessName;
      if (!lead!.source && enriched.source) updates.source = enriched.source;
      if (Object.keys(updates).length > 0) {
        await updateLeadFields(lead!.id, updates);
        console.log(`[Webhook/Msg] Enriched lead ${lead!.id} with: ${Object.keys(updates).join(", ")}`);
        lead = { ...lead!, ...updates } as typeof lead;
      }
    }
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

  // --- AUTO-CORRECTION: Detect confusion in inbound messages ---
  if (direction === "inbound" && detectConfusion(messageBody)) {
    console.log(`[Webhook] Confusion detected from lead ${lead!.id}: "${messageBody.substring(0, 100)}"`);
    // Extract form data for correction template
    let corrFormData: { productType?: string; purpose?: string; timeline?: string } | undefined;
    try {
      const ghlContact = await getContact(contactId);
      if (ghlContact?.customFields) {
        const corrFormFields = extractFormData({ customFields: ghlContact.customFields });
        corrFormData = {
          productType: corrFormFields.find(f => f.label === "Product Type")?.value,
          purpose: corrFormFields.find(f => f.label === "Purpose")?.value,
          timeline: corrFormFields.find(f => f.label === "Timeline")?.value,
        };
      }
    } catch { /* best effort */ }

    const corrected = await handleConfusionReply({
      leadId: lead!.id,
      contactId,
      channel,
      confusionMessage: messageBody,
      formData: corrFormData,
    });
    if (corrected) {
      console.log(`[Webhook] Auto-correction sent for lead ${lead!.id}`);
      // Continue processing — don't return, the lead may also need a real response
    }
  }

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

  // MANDATORY CONTEXT: For contacts older than 3 days, ALWAYS pull GHL history
  // This ensures the AI has full conversation context before engaging older leads
  const leadCreated = lead!.createdAt ? new Date(lead!.createdAt).getTime() : Date.now();
  const leadAgeDays = (Date.now() - leadCreated) / (1000 * 60 * 60 * 24);
  const needsGhlSync = leadAgeDays >= 3 || convHistory.length < 3;

  if (needsGhlSync) {
    try {
      const ghlHistory = await fetchGhlConversationHistory(contactId);
      if (ghlHistory.length > 0) {
        // Store GHL messages locally if we don't have them yet
        if (convHistory.length === 0) {
          for (const m of ghlHistory) {
            if (!m.body?.trim()) continue;
            const isFormData = m.body.toLowerCase().includes("full name:") && m.body.toLowerCase().includes("phone number:");
            if (isFormData) continue; // Skip form data pseudo-messages
            await addConversation({
              leadId: lead!.id,
              channel: normalizeChannel(m.type || "SMS"),
              direction: m.direction === "outbound" ? "outbound" : "inbound",
              messageBody: m.body,
              senderType: m.direction === "outbound" ? "human" : "lead",
            });
          }
          console.log(`[Webhook] Synced ${ghlHistory.filter(m => m.body?.trim()).length} GHL messages for lead ${lead!.id} (${leadAgeDays.toFixed(0)} days old)`);
        }

        const ghlHistoryStr = ghlHistory
          .filter(m => m.body && m.body.trim())
          .map(m => `[${m.direction === "outbound" ? "agent" : "lead"}/${String(m.type || "msg")}] ${m.body}`)
          .join("\n");
        if (ghlHistoryStr) {
          historyStr = `--- Full GHL conversation history (${ghlHistory.length} messages) ---\n${ghlHistoryStr}\n--- Recent local messages ---\n${historyStr}`;
        }
      } else if (leadAgeDays >= 3) {
        // No GHL history for a 3+ day old contact — flag it
        historyStr = `--- WARNING: No conversation history found in GHL for this ${leadAgeDays.toFixed(0)}-day-old contact ---\n${historyStr}`;
      }
    } catch (err) {
      console.error(`[Webhook] Failed to fetch GHL history for lead ${lead!.id}:`, err);
      if (leadAgeDays >= 3) {
        historyStr = `--- WARNING: Could not fetch GHL history for this ${leadAgeDays.toFixed(0)}-day-old contact ---\n${historyStr}`;
      }
    }
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

  // --- GLOBAL RATE LIMIT CHECK ---
  const msgRateCheck = await checkRateLimits();
  if (!msgRateCheck.allowed) {
    console.log(`[Webhook] Rate limit hit for lead ${lead!.id}: ${msgRateCheck.reason}`);
    // Schedule for later instead of dropping
    const laterSchedule = await calculateNextFollowUp({ leadId: lead!.id, triggerEvent: "ai_response" });
    await updateLeadFields(lead!.id, { nextFollowUpAt: laterSchedule.nextFollowUpAt });
    res.json({ success: true, action: "rate_limited" });
    return;
  }

  // --- DEDUP GUARD: Don't respond if we already sent an AI message in the last 5 minutes ---
  const recentAiMsgCount = await getRecentAiOutboundCount(lead!.id, 5);
  if (recentAiMsgCount > 0) {
    console.log(`[Webhook] Skipping AI response for lead ${lead!.id} — ${recentAiMsgCount} AI message(s) sent in last 5 min`);
    res.json({ success: true, action: "dedup_cooldown" });
    return;
  }

  // --- CADENCE BACKOFF: Count consecutive unanswered outbound messages ---
  // If we've sent multiple messages without a reply, increase the gap
  const recentConvs = convHistory.slice().reverse(); // oldest first
  let consecutiveUnanswered = 0;
  for (let i = recentConvs.length - 1; i >= 0; i--) {
    if (recentConvs[i].direction === "outbound" && recentConvs[i].senderType === "ai") {
      consecutiveUnanswered++;
    } else if (recentConvs[i].direction === "inbound") {
      break; // found a reply, stop counting
    }
  }
  // If 2+ unanswered AI messages, enforce minimum gap before next outbound
  if (consecutiveUnanswered >= 2) {
    const minGapMinutes = consecutiveUnanswered >= 4 ? 1440 : consecutiveUnanswered >= 3 ? 240 : 60; // 4+: 24h, 3: 4h, 2: 1h
    const lastAiOutbound = recentConvs.filter(c => c.direction === "outbound" && c.senderType === "ai").pop();
    if (lastAiOutbound) {
      const lastSentAt = new Date(lastAiOutbound.timestamp).getTime();
      const minutesSinceLastSend = (Date.now() - lastSentAt) / (1000 * 60);
      if (minutesSinceLastSend < minGapMinutes) {
        console.log(`[Webhook] Cadence backoff for lead ${lead!.id} — ${consecutiveUnanswered} unanswered msgs, need ${minGapMinutes}min gap, only ${Math.round(minutesSinceLastSend)}min elapsed`);
        // Schedule the follow-up for later instead of responding now
        const backoffFollowUp = new Date(Date.now() + (minGapMinutes - minutesSinceLastSend) * 60 * 1000);
        await updateLeadFields(lead!.id, { nextFollowUpAt: backoffFollowUp });
        res.json({ success: true, action: "cadence_backoff" });
        return;
      }
    }
  }

  // --- AI RESPONSE via BRAIN COUNCIL (Strategist → Researcher → Composer → QC) ---
  const aiResponse = await runBrainCouncil({
    leadId: lead!.id,
    incomingMessage: messageBody,
    channel,
    externalHistory: historyStr,
  });
  console.log(`[Webhook] Brain Council for lead ${lead!.id}: QC=${aiResponse.qcScore}, blocked=${aiResponse.blocked}, strategy=${aiResponse.strategyReasoning.substring(0, 80)}`);

  // --- ACCOUNTABILITY: Handle blocked messages ---
  if (aiResponse.blocked && aiResponse.fallbackUsed && aiResponse.fallbackMessage) {
    console.log(`[Webhook] \u26a0\ufe0f BLOCKED message for lead ${lead!.id}: ${aiResponse.blockReason}. Sending fallback.`);
    // Send the safe fallback instead
    const fallbackOpts: Parameters<typeof sendMessage>[1] = channel === "Email"
      ? { type: "Email", subject: "Adorb Custom Tees", html: aiResponse.fallbackMessage, fromName: aiResponse.fromName }
      : { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.fallbackMessage };
    const sendResult = await sendMessageWithRetry(resolvedContactId, fallbackOpts, { email: lead!.email, phone: lead!.phone, id: lead!.id });
    if (!sendResult.success) console.error(`[Webhook/Msg] Fallback send failed for lead ${lead!.id}: ${sendResult.error}`);
    
    await addConversation({
      leadId: lead!.id, channel, direction: "outbound", messageBody: `[FALLBACK] ${aiResponse.fallbackMessage}`,
      senderType: "ai", senderName: aiResponse.fromName,
    });
    
    res.json({ success: true, action: "blocked_fallback_sent", violation: aiResponse.violationCategory, blockReason: aiResponse.blockReason });
    return;
  }

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

    // Send handoff message (with retry on wrong contact ID)
    {
      const handoffOpts: Parameters<typeof sendMessage>[1] = channel === "Email"
        ? { type: "Email", subject: aiResponse.fromName, html: aiResponse.message, fromName: aiResponse.fromName }
        : { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message };
      const sendResult = await sendMessageWithRetry(resolvedContactId, handoffOpts, { email: lead!.email, phone: lead!.phone, id: lead!.id });
      if (sendResult.resolvedContactId !== resolvedContactId) resolvedContactId = sendResult.resolvedContactId;
      if (!sendResult.success) console.error(`[Webhook/Msg] Handoff send failed for lead ${lead!.id}: ${sendResult.error}`);
    }

    await addConversation({
      leadId: lead!.id, channel, direction: "outbound", messageBody: aiResponse.message,
      senderType: "ai", senderName: aiResponse.fromName,
    });

    res.json({ success: true, action: "ai_responded_and_handed_off" });
    return;
  }

  // --- NORMAL AI RESPONSE (with retry on wrong contact ID) ---
  {
    const normalOpts: Parameters<typeof sendMessage>[1] = channel === "Email"
      ? { type: "Email", subject: aiResponse.fromName, html: aiResponse.message, fromName: aiResponse.fromName }
      : { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message };
    const sendResult = await sendMessageWithRetry(resolvedContactId, normalOpts, { email: lead!.email, phone: lead!.phone, id: lead!.id });
    if (sendResult.resolvedContactId !== resolvedContactId) resolvedContactId = sendResult.resolvedContactId;
    if (!sendResult.success) console.error(`[Webhook/Msg] Normal send failed for lead ${lead!.id}: ${sendResult.error}`);
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

  // Estimate order value after EVERY AI response when pricing context exists
  try {
    const fullConvForValue = historyStr + `\n[ai/${channel}] ${aiResponse.message}`;
    const leadInfo = `${lead!.name || "Unknown"} - ${lead!.businessName || "Unknown"} - Stage: ${lead!.pipelineStage}`;
    const valueEstimate = await estimateOrderValue(fullConvForValue, leadInfo);
    if (valueEstimate.estimatedValue > 0) {
      await updateLeadFields(lead!.id, { pipelineValue: valueEstimate.estimatedValue });
      // Also update GHL opportunity value if we have an opportunity ID
      if (payload.opportunityId) {
        try { await updateOpportunityValue(payload.opportunityId as string, valueEstimate.estimatedValue); } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }

  // Calculate next follow-up using the Context-Aware Scheduling Engine
  const scheduleResult = await calculateNextFollowUp({
    leadId: lead!.id,
    aiSuggestedHours: aiResponse.nextEngagementHours,
    triggerEvent: "ai_response",
  });
  await updateLeadFields(lead!.id, {
    nextFollowUpAt: scheduleResult.nextFollowUpAt,
    cadencePosition: scheduleResult.cadencePosition,
    preferredChannel: scheduleResult.channel,
    lastOutboundChannel: channel,
  });
  console.log(`[Webhook] Scheduling engine for lead ${lead!.id}: ${scheduleResult.reason}`);

  // --- POST-SEND VALIDATION: Check if the just-sent message needs correction ---
  if (aiResponse.violationCategory) {
    try {
      // Get the most recent audit entry for this lead (the one we just created)
      const recentAudits = await getBrainCouncilAuditForLead(lead!.id, 1);
      if (recentAudits.length > 0) {
        let corrFormData: { productType?: string; purpose?: string; timeline?: string } | undefined;
        try {
          const ghlContact = await getContact(resolvedContactId);
          if (ghlContact?.customFields) {
            const corrFormFields = extractFormData({ customFields: ghlContact.customFields });
            corrFormData = {
              productType: corrFormFields.find(f => f.label === "Product Type")?.value,
              purpose: corrFormFields.find(f => f.label === "Purpose")?.value,
              timeline: corrFormFields.find(f => f.label === "Timeline")?.value,
            };
          }
        } catch { /* best effort */ }

        await postSendValidation({
          auditId: recentAudits[0].id,
          leadId: lead!.id,
          contactId: resolvedContactId,
          channel,
          sentMessage: aiResponse.message,
          violationCategory: aiResponse.violationCategory,
          qcScore: aiResponse.qcScore,
          formData: corrFormData,
        });
      }
    } catch (corrErr) {
      console.error('[Webhook] Post-send validation error (non-fatal):', corrErr);
    }
  }

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

  // Use scheduling engine for pipeline stage transitions
  const pipelineSchedule = await calculateNextFollowUp({
    leadId: lead.id,
    triggerEvent: "stage_change",
    stageTransition: toStage,
  });
  await updateLeadFields(lead.id, {
    nextFollowUpAt: pipelineSchedule.nextFollowUpAt,
    cadencePosition: pipelineSchedule.cadencePosition,
    preferredChannel: pipelineSchedule.channel,
  });
  console.log(`[Webhook] Pipeline schedule for lead ${lead.id} → ${toStage}: ${pipelineSchedule.reason}`);

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

  // --- SEND CUSTOMER NOTIFICATION (with retry on wrong contact ID) ---
  const notification = getStageNotification(toStage, lead.name || "");
  if (notification) {
    try {
      const notifOpts: Parameters<typeof sendMessage>[1] = lead.phone
        ? { type: "SMS", message: notification.message }
        : { type: "Email", subject: notification.fromName, html: notification.message, fromName: notification.fromName };
      if (lead.phone || lead.email) {
        await sendMessageWithRetry(contactId, notifOpts, { email: lead.email, phone: lead.phone, id: lead.id });
      }
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
        await sendMessageWithRetry(contactId, { type: "SMS", message: notification.message }, { email: lead.email, phone: lead.phone, id: lead.id });
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
        await sendMessageWithRetry(contactId, { type: "SMS", message: notification.message }, { email: lead.email, phone: lead.phone, id: lead.id });
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
