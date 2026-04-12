/**
 * LAYER 5: ACTION DISPATCHER — Translates ConversationState changes into GHL actions
 *
 * This module is the SINGLE place where state transitions trigger side effects.
 * It replaces scattered pipeline update calls across 6+ files.
 *
 * State → Action mapping:
 *   committed     → Create sales follow-up task for agent + appointment + move to Qualified + auto-create opportunity
 *   dnc_channel   → Block channel + escalate to next (via channel-fallback.ts)
 *   dnc_all       → Move to Not Qualified
 *   fulfilled     → Schedule post-delivery follow-up
 *   human_active  → Add GHL note, ensure humanTakeover=1
 *   interested    → Create quote task if not already created
 *   stale         → Trigger disposition check
 *
 * Design principles:
 *   - All actions are best-effort (GHL API failures don't crash the system)
 *   - Actions are idempotent (safe to call multiple times for the same transition)
 *   - Logs every action for observability
 *   - Does NOT send customer messages (that's the Brain Council's job)
 */

import { updateLeadFields, addConversation, getLeadById, getConversationHistory } from "./db";
import { createTask, addNote, updateOpportunityStage, getOpportunitiesByContact } from "./ghl";
import { handleChannelDnc, allChannelsExhausted, detectDncChannel } from "./channel-fallback";
import { calculateNextFollowUp } from "./scheduling-engine";
import { STAGES, SALES_AGENTS, DESIGNER } from "./webhook-helpers";
import { getNqStageId, getQualifiedStageId, getDeliveredStageId } from "../shared/ghl-stages";
import type { ConversationState, StateTransitionResult } from "./conversation-state";
import type { IntentResult } from "./intent-classifier";
import { getStagePlaybook, getStageNote, getStageFollowUpDelay, getStageTaskContext } from "./stage-playbook";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DispatchContext {
  leadId: number;
  ghlContactId: string;
  leadName: string | null;
  businessName: string | null;
  email: string | null;
  phone: string | null;
  assignedAgent: string | null;
  pipelineValue: number | null;
  ghlOpportunityId: string | null;
  ghlPipelineId: string | null;
  channel: string;  // The channel the inbound message arrived on
  pipelineStage: string | null;  // Current pipeline stage for Stage Playbook lookups
}

export interface DispatchResult {
  actionsExecuted: string[];
  errors: string[];
  skipped: boolean;
  reason?: string;
}

// ─── Action Handlers ────────────────────────────────────────────────────────

/**
 * Handle transition TO "committed" state.
 * Customer expressed commitment ("sounds good", "let's do it") — this is a SALES
 * commitment, NOT a payment confirmation. The designer (César) task only happens
 * when the pipeline reaches "Paid - Proof Needed" (handled by webhook-pipeline.ts).
 *
 * Actions:
 * 1. Auto-create GHL opportunity if one doesn't exist
 * 2. Create a sales follow-up task for the ASSIGNED AGENT (not designer)
 * 3. Add a GHL note with conversation summary
 * 4. Create an appointment for the agent to follow up
 * 5. Move pipeline to Qualified stage
 * 6. Schedule follow-up
 */
async function handleCommitted(ctx: DispatchContext, intent: IntentResult): Promise<DispatchResult> {
  const actions: string[] = [];
  const errors: string[] = [];
  const leadLabel = ctx.leadName || ctx.businessName || "Lead";
  const agent = ctx.assignedAgent || SALES_AGENTS[0];

  // 0. Auto-create GHL opportunity if missing
  let opportunityId = ctx.ghlOpportunityId;
  let pipelineId = ctx.ghlPipelineId;
  if (!opportunityId) {
    try {
      const { createOpportunity } = await import("./ghl");
      const { GHL_PIPELINES, CONTACTED_STAGE_IDS } = await import("../shared/ghl-stages");
      const defaultPipeline = pipelineId || GHL_PIPELINES.BULK_PRINTING;
      const defaultStage = CONTACTED_STAGE_IDS[defaultPipeline] || Object.values(CONTACTED_STAGE_IDS)[0];
      const opp = await createOpportunity({
        contactId: ctx.ghlContactId,
        name: `${leadLabel} — AI Committed`,
        pipelineId: defaultPipeline,
        stageId: defaultStage,
        monetaryValue: ctx.pipelineValue || undefined,
      });
      opportunityId = opp.id;
      pipelineId = opp.pipelineId;
      await updateLeadFields(ctx.leadId, {
        ghlOpportunityId: opp.id,
        ghlPipelineId: opp.pipelineId,
      });
      actions.push(`Auto-created GHL opportunity: ${opp.id}`);
      console.log(`[ActionDispatcher] Lead ${ctx.leadId}: Auto-created opportunity ${opp.id}`);
    } catch (err: any) {
      errors.push(`Failed to auto-create opportunity: ${err?.message}`);
      console.error(`[ActionDispatcher] Lead ${ctx.leadId}: Failed to create opportunity:`, err);
    }
  }

  // 1. Build conversation summary for the agent
  let conversationSummary = "";
  try {
    const history = await getConversationHistory(ctx.leadId, 20);
    if (history.length > 0) {
      const recent = history.slice(0, 10).reverse();
      conversationSummary = recent.map((m: any) => {
        const who = m.direction === "inbound" ? (ctx.leadName || "Customer") : "AI (Abby)";
        const time = m.timestamp ? new Date(m.timestamp).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
        return `[${time}] ${who}: ${(m.messageBody || "").slice(0, 200)}`;
      }).join("\n");
    }
  } catch { /* best effort */ }

  // 2. Create sales follow-up task for the ASSIGNED AGENT (NOT the designer)
  try {
    await createTask(ctx.ghlContactId, {
      title: `📋 Close deal with ${leadLabel} — Customer is committed`,
      body: [
        `Customer has expressed commitment and is ready to move forward.`,
        ``,
        `Business: ${ctx.businessName || "N/A"}`,
        `Contact: ${ctx.leadName || "N/A"}`,
        `Phone: ${ctx.phone || "N/A"} | Email: ${ctx.email || "N/A"}`,
        `Estimated Value: $${ctx.pipelineValue || "TBD"}`,
        ``,
        `Next steps:`,
        `- Review conversation below and confirm order details`,
        `- Collect payment or send invoice`,
        `- Once paid, move pipeline to "Paid - Proof Needed" (this triggers the design team)`,
        ``,
        `Intent: ${intent.intent} (${intent.confidence}% confidence)`,
        `Reason: ${intent.reasoning}`,
        ...(conversationSummary ? [``, `--- Recent Conversation ---`, conversationSummary] : []),
      ].join("\n"),
      assignedTo: agent,
    });
    actions.push(`Created sales follow-up task for ${agent}`);
    console.log(`[ActionDispatcher] Lead ${ctx.leadId}: Created sales task for ${agent}`);
  } catch (err: any) {
    errors.push(`Failed to create sales task: ${err?.message}`);
    console.error(`[ActionDispatcher] Lead ${ctx.leadId}: Failed to create sales task:`, err);
  }

  // 3. Add GHL note with full context
  try {
    const playbook = getStagePlaybook(ctx.pipelineStage || "Qualified");
    const noteText = playbook?.noteTemplate || getStageNote(ctx.pipelineStage);
    await addNote(ctx.ghlContactId,
      `🤖 AI State Machine: Customer COMMITTED\n` +
      `Stage: ${ctx.pipelineStage || "Unknown"} → Qualified\n` +
      `Intent: ${intent.intent} — "${intent.reasoning}"\n` +
      `Action: Sales follow-up task created for ${agent}.\n` +
      `Next: Agent to close deal and collect payment. Design team activates ONLY after payment (Paid - Proof Needed stage).\n` +
      `Stage Note: ${noteText}`
    );
    actions.push("Added commitment note to GHL");
  } catch { /* best effort */ }

  // 4. Create appointment for the agent to follow up during next business hours
  try {
    const { createAppointment, getNextBusinessHoursSlot, AGENT_CALENDAR_IDS, AGENT_GHL_USER_IDS } = await import("./ghl");
    const slot = getNextBusinessHoursSlot();
    const calendarId = AGENT_CALENDAR_IDS[agent] || AGENT_CALENDAR_IDS["Abby Bouwer"];
    const userId = AGENT_GHL_USER_IDS[agent];
    const endTime = new Date(slot.start.getTime() + 30 * 60 * 1000); // 30 min appointment
    await createAppointment({
      calendarId,
      contactId: ctx.ghlContactId,
      title: `📞 Follow up with ${leadLabel} — Close deal`,
      description: [
        `Customer committed via AI conversation.`,
        `Intent: ${intent.intent} — ${intent.reasoning}`,
        `Value: $${ctx.pipelineValue || "TBD"}`,
        ``,
        `Review conversation and close the deal.`,
        ...(conversationSummary ? [``, `--- Conversation Summary ---`, conversationSummary] : []),
      ].join("\n"),
      startTime: slot.start.toISOString(),
      endTime: endTime.toISOString(),
      assignedUserId: userId,
    });
    actions.push(`Created appointment for ${agent} at ${slot.start.toISOString()}`);
  } catch (err: any) {
    errors.push(`Failed to create appointment: ${err?.message}`);
  }

  // 5. Move pipeline to Qualified stage
  if (opportunityId && pipelineId) {
    const qualifiedStageId = getQualifiedStageId(pipelineId);
    if (qualifiedStageId) {
      try {
        await updateOpportunityStage(opportunityId, qualifiedStageId);
        actions.push(`Moved pipeline to Qualified stage`);
        console.log(`[ActionDispatcher] Lead ${ctx.leadId}: Moved to Qualified (${qualifiedStageId})`);
      } catch (err: any) {
        errors.push(`Failed to move to Qualified: ${err?.message}`);
      }
    }
  }

  // 6. Push pipeline value to GHL opportunity if we have one
  if (opportunityId && ctx.pipelineValue) {
    try {
      const { updateOpportunityValue } = await import("./ghl");
      await updateOpportunityValue(opportunityId, ctx.pipelineValue);
      actions.push(`Pushed pipeline value $${ctx.pipelineValue} to GHL opportunity`);
    } catch (err: any) {
      errors.push(`Failed to push pipeline value: ${err?.message}`);
    }
  }

  // 7. Schedule follow-up
  try {
    const schedule = await calculateNextFollowUp({
      leadId: ctx.leadId,
      triggerEvent: "stage_change",
      stageTransition: "Committed",
    });
    await updateLeadFields(ctx.leadId, {
      nextFollowUpAt: schedule.nextFollowUpAt,
      cadencePosition: schedule.cadencePosition,
    });
    actions.push(`Scheduled follow-up: ${schedule.reason}`);
  } catch (err: any) {
    errors.push(`Failed to schedule follow-up: ${err?.message}`);
  }

  return { actionsExecuted: actions, errors, skipped: false };
}

/**
 * Handle transition TO "interested" state.
 * Customer provided design details or asked about pricing.
 *
 * Actions:
 * 1. If no quote task exists yet, create one for the assigned agent
 * 2. Add a GHL note
 */
async function handleInterested(ctx: DispatchContext, intent: IntentResult): Promise<DispatchResult> {
  const actions: string[] = [];
  const errors: string[] = [];
  const leadLabel = ctx.leadName || ctx.businessName || "Lead";
  const agent = ctx.assignedAgent || SALES_AGENTS[0];

  // 0. Auto-create GHL opportunity if missing — interested leads deserve a pipeline entry
  let opportunityId = ctx.ghlOpportunityId;
  if (!opportunityId) {
    try {
      const { createOpportunity } = await import("./ghl");
      const { GHL_PIPELINES, CONTACTED_STAGE_IDS } = await import("../shared/ghl-stages");
      const defaultPipeline = ctx.ghlPipelineId || GHL_PIPELINES.BULK_PRINTING;
      const defaultStage = CONTACTED_STAGE_IDS[defaultPipeline] || Object.values(CONTACTED_STAGE_IDS)[0];
      const opp = await createOpportunity({
        contactId: ctx.ghlContactId,
        name: `${leadLabel} \u2014 ${intent.intent}`,
        pipelineId: defaultPipeline,
        stageId: defaultStage,
        monetaryValue: ctx.pipelineValue || undefined,
      });
      opportunityId = opp.id;
      await updateLeadFields(ctx.leadId, {
        ghlOpportunityId: opp.id,
        ghlPipelineId: opp.pipelineId,
      });
      actions.push(`Auto-created GHL opportunity: ${opp.id}`);
    } catch (err: any) {
      errors.push(`Failed to auto-create opportunity: ${err?.message}`);
    }
  }

  // 1. Push pipeline value to GHL opportunity
  if (opportunityId && ctx.pipelineValue) {
    try {
      const { updateOpportunityValue } = await import("./ghl");
      await updateOpportunityValue(opportunityId, ctx.pipelineValue);
      actions.push(`Pushed pipeline value $${ctx.pipelineValue} to GHL`);
    } catch (err: any) {
      errors.push(`Failed to push pipeline value: ${err?.message}`);
    }
  }

  // 2. Create quote task for price inquiries or design requests
  if (intent.intent === "price_inquiry" || intent.intent === "design_request") {
    try {
      const estValue = ctx.pipelineValue ? ` \u2014 Est. $${ctx.pipelineValue}` : "";
      await createTask(ctx.ghlContactId, {
        title: `\ud83d\udccb Review & quote for ${leadLabel}${estValue}`,
        body: [
          `Customer is showing strong interest (${intent.intent}).`,
          ``,
          `Business: ${ctx.businessName || "N/A"}`,
          `Contact: ${ctx.leadName || "N/A"}`,
          `Phone: ${ctx.phone || "N/A"} | Email: ${ctx.email || "N/A"}`,
          ``,
          `Review the conversation and prepare a quote if needed.`,
          `Intent: ${intent.reasoning}`,
        ].join("\n"),
        assignedTo: agent,
      });
      actions.push(`Created quote review task for ${agent}`);
    } catch (err: any) {
      errors.push(`Failed to create quote task: ${err?.message}`);
    }
  }

  // 3. Add note
  try {
    await addNote(ctx.ghlContactId,
      `\ud83e\udd16 AI State Machine: Lead moved to INTERESTED\n` +
      `Intent: ${intent.intent} \u2014 "${intent.reasoning}"` +
      (opportunityId ? `\nOpportunity: ${opportunityId}` : "") +
      (ctx.pipelineValue ? `\nEstimated Value: $${ctx.pipelineValue}` : "")
    );
    actions.push("Added interest note to GHL");
  } catch { /* best effort */ }

  return { actionsExecuted: actions, errors, skipped: false };
}

/**
 * Handle transition TO "dnc_channel" state.
 * Customer opted out on one channel — block it and escalate to next.
 * Delegates to the existing channel-fallback.ts module.
 */
async function handleDncChannel(ctx: DispatchContext): Promise<DispatchResult> {
  const actions: string[] = [];
  const errors: string[] = [];

  const dncChannel = detectDncChannel(ctx.channel);

  try {
    // Fetch fresh lead data for channel checking
    const lead = await getLeadById(ctx.leadId);
    if (!lead) {
      return { actionsExecuted: [], errors: ["Lead not found"], skipped: true, reason: "Lead not found" };
    }

    const result = await handleChannelDnc(ctx.leadId, lead, dncChannel, ctx.ghlContactId);
    actions.push(`Channel DNC: blocked ${result.blockedChannel}, next=${result.nextChannel || "NONE"}`);

    if (result.allChannelsExhausted) {
      // All channels exhausted — move to Not Qualified
      const nqStageId = getNqStageId(ctx.ghlPipelineId);
      await updateLeadFields(ctx.leadId, {
        pipelineStage: "not_qualified",
        humanTakeover: 1,
        ...(nqStageId ? { ghlStageId: nqStageId } : {}),
      });

      if (ctx.ghlOpportunityId && nqStageId) {
        try {
          await updateOpportunityStage(ctx.ghlOpportunityId, nqStageId);
          actions.push("Moved to Not Qualified in GHL pipeline");
        } catch { actions.push("Moved to Not Qualified (local only — GHL API failed)"); }
      }
    }
  } catch (err: any) {
    errors.push(`Channel DNC handling failed: ${err?.message}`);
  }

  return { actionsExecuted: actions, errors, skipped: false };
}

/**
 * Handle transition TO "dnc_all" state.
 * All channels are blocked — move to Not Qualified.
 */
async function handleDncAll(ctx: DispatchContext): Promise<DispatchResult> {
  const actions: string[] = [];
  const errors: string[] = [];

  const nqStageId = getNqStageId(ctx.ghlPipelineId);

  try {
    await updateLeadFields(ctx.leadId, {
      pipelineStage: "not_qualified",
      humanTakeover: 1,
      ...(nqStageId ? { ghlStageId: nqStageId } : {}),
    });
    actions.push("Set lead to Not Qualified (local DB)");

    if (ctx.ghlOpportunityId && nqStageId) {
      try {
        await updateOpportunityStage(ctx.ghlOpportunityId, nqStageId);
        actions.push("Moved to Not Qualified in GHL pipeline");
      } catch {
        actions.push("GHL pipeline update failed (local DB already updated)");
      }
    }

    try {
      await addNote(ctx.ghlContactId,
        `🤖 AI State Machine: ALL channels blocked (DNC)\n` +
        `Lead moved to Not Qualified. No further AI outreach.`
      );
    } catch { /* best effort */ }
  } catch (err: any) {
    errors.push(`DNC-all handling failed: ${err?.message}`);
  }

  return { actionsExecuted: actions, errors, skipped: false };
}

/**
 * Handle transition TO "fulfilled" state.
 * Order delivered/won — schedule post-delivery follow-up.
 */
async function handleFulfilled(ctx: DispatchContext): Promise<DispatchResult> {
  const actions: string[] = [];
  const errors: string[] = [];

  try {
    const schedule = await calculateNextFollowUp({
      leadId: ctx.leadId,
      triggerEvent: "stage_change",
      stageTransition: "Delivered",
    });
    await updateLeadFields(ctx.leadId, {
      nextFollowUpAt: schedule.nextFollowUpAt,
      cadencePosition: schedule.cadencePosition,
    });
    actions.push(`Scheduled post-delivery follow-up: ${schedule.reason}`);
  } catch (err: any) {
    errors.push(`Failed to schedule post-delivery follow-up: ${err?.message}`);
  }

  // 2. Move pipeline to Delivered/Won stage
  if (ctx.ghlOpportunityId && ctx.ghlPipelineId) {
    const deliveredStageId = getDeliveredStageId(ctx.ghlPipelineId);
    if (deliveredStageId) {
      try {
        await updateOpportunityStage(ctx.ghlOpportunityId, deliveredStageId);
        actions.push(`Moved pipeline to Delivered/Won stage`);
        console.log(`[ActionDispatcher] Lead ${ctx.leadId}: Moved to Delivered (${deliveredStageId})`);
      } catch (err: any) {
        errors.push(`Failed to move to Delivered: ${err?.message}`);
      }
    }
  }

  try {
    await addNote(ctx.ghlContactId,
      `🤖 AI State Machine: Lead FULFILLED\n` +
      `Order delivered/completed. Post-delivery follow-up scheduled.`
    );
  } catch { /* best effort */ }

  // 3. Create multi-step post-delivery sequence (satisfaction → review → upsell)
  try {
    const { createPostDeliverySequence } = await import("./db");
    const channel = ctx.email ? "Email" : "SMS";
    await createPostDeliverySequence(ctx.leadId, channel);
    actions.push(`Created post-delivery sequence (3 steps over 21 days via ${channel})`);
    console.log(`[ActionDispatcher] Lead ${ctx.leadId}: Post-delivery sequence created`);
  } catch (err: any) {
    errors.push(`Failed to create post-delivery sequence: ${err?.message}`);
  }

  return { actionsExecuted: actions, errors, skipped: false };
}

/**
 * Handle transition TO "human_active" state.
 * Human agent is managing — ensure humanTakeover is set and add note.
 */
async function handleHumanActive(ctx: DispatchContext, reason: string): Promise<DispatchResult> {
  const actions: string[] = [];
  const errors: string[] = [];
  const leadLabel = ctx.leadName || ctx.businessName || `Lead #${ctx.leadId}`;
  const agent = ctx.assignedAgent || SALES_AGENTS[0];

  try {
    await updateLeadFields(ctx.leadId, {
      humanTakeover: 1,
      lastAgentActivityAt: new Date(),
    });
    actions.push("Set humanTakeover=1");
  } catch (err: any) {
    errors.push(`Failed to set humanTakeover: ${err?.message}`);
  }

  // Build conversation summary for the agent
  let conversationSummary = "";
  try {
    const history = await getConversationHistory(ctx.leadId, 20);
    if (history.length > 0) {
      const recent = history.slice(0, 10).reverse();
      conversationSummary = recent.map((m: any) => {
        const who = m.direction === "inbound" ? (ctx.leadName || "Customer") : "AI (Abby)";
        const time = m.timestamp ? new Date(m.timestamp).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
        return `[${time}] ${who}: ${(m.messageBody || "").slice(0, 200)}`;
      }).join("\n");
    }
  } catch { /* best effort */ }

  // Add GHL note with conversation summary
  try {
    await addNote(ctx.ghlContactId,
      [
        `\ud83e\udd16 AI State Machine: HUMAN ACTIVE`,
        `Reason: ${reason}`,
        `Assigned to: ${agent}`,
        `AI will stand down until agent activity expires (2hr window).`,
        `A task and appointment have been created for the assigned agent.`,
        ...(conversationSummary ? [``, `--- Recent Conversation ---`, conversationSummary] : []),
      ].join("\n")
    );
  } catch { /* best effort */ }

  // CREATE TASK for assigned agent with full conversation context
  try {
    const { getNextBusinessHoursSlot } = await import("./ghl");
    const slot = getNextBusinessHoursSlot();

    await createTask(ctx.ghlContactId, {
      title: `\ud83d\udcde Call ${leadLabel} \u2014 Human Handoff Required`,
      body: [
        `Reason for handoff: ${reason}`,
        `Lead: ${leadLabel}${ctx.businessName ? ` (${ctx.businessName})` : ""}`,
        `Phone: ${ctx.phone || "N/A"} | Email: ${ctx.email || "N/A"}`,
        `Estimated Value: $${ctx.pipelineValue || "TBD"}`,
        ``,
        `The AI has stepped back from this conversation. Please review the`,
        `conversation summary below and reach out during business hours (M-F 9am-5pm ET).`,
        ``,
        `After your interaction, the AI will auto-resume if no agent activity is detected for 2 hours.`,
        ...(conversationSummary ? [``, `--- Recent Conversation ---`, conversationSummary] : []),
      ].join("\n"),
      dueDate: slot.start.toISOString(),
      assignedTo: agent,
    });
    actions.push(`Created handoff task for ${agent} due ${slot.start.toISOString()}`);
  } catch (err: any) {
    errors.push(`Failed to create handoff task: ${err?.message}`);
  }

  // CREATE APPOINTMENT for the agent to follow up
  try {
    const { createAppointment, getNextBusinessHoursSlot, AGENT_CALENDAR_IDS, AGENT_GHL_USER_IDS } = await import("./ghl");
    const slot = getNextBusinessHoursSlot();
    const calendarId = AGENT_CALENDAR_IDS[agent] || AGENT_CALENDAR_IDS["Abby Bouwer"];
    const userId = AGENT_GHL_USER_IDS[agent];
    const endTime = new Date(slot.start.getTime() + 30 * 60 * 1000);
    await createAppointment({
      calendarId,
      contactId: ctx.ghlContactId,
      title: `\ud83d\udcde Follow up with ${leadLabel} \u2014 Handoff`,
      description: [
        `Human handoff from AI.`,
        `Reason: ${reason}`,
        `Value: $${ctx.pipelineValue || "TBD"}`,
        ...(conversationSummary ? [``, `--- Conversation ---`, conversationSummary] : []),
      ].join("\n"),
      startTime: slot.start.toISOString(),
      endTime: endTime.toISOString(),
      assignedUserId: userId,
    });
    actions.push(`Created appointment for ${agent} at ${slot.start.toISOString()}`);
  } catch (err: any) {
    errors.push(`Failed to create appointment: ${err?.message}`);
  }

  // Auto-create GHL opportunity if missing
  if (!ctx.ghlOpportunityId) {
    try {
      const { createOpportunity } = await import("./ghl");
      const { GHL_PIPELINES, CONTACTED_STAGE_IDS } = await import("../shared/ghl-stages");
      const defaultPipeline = ctx.ghlPipelineId || GHL_PIPELINES.BULK_PRINTING;
      const defaultStage = CONTACTED_STAGE_IDS[defaultPipeline] || Object.values(CONTACTED_STAGE_IDS)[0];
      const opp = await createOpportunity({
        contactId: ctx.ghlContactId,
        name: `${leadLabel} \u2014 Human Handoff`,
        pipelineId: defaultPipeline,
        stageId: defaultStage,
        monetaryValue: ctx.pipelineValue || undefined,
      });
      await updateLeadFields(ctx.leadId, {
        ghlOpportunityId: opp.id,
        ghlPipelineId: opp.pipelineId,
      });
      actions.push(`Auto-created GHL opportunity: ${opp.id}`);
    } catch (err: any) {
      errors.push(`Failed to auto-create opportunity: ${err?.message}`);
    }
  }

  // Notify owner about the handoff
  try {
    const { notifyOwner } = await import("./_core/notification");
    await notifyOwner({
      title: `\ud83d\udcde Human Handoff: ${leadLabel}`,
      content: [
        `Lead: ${leadLabel}${ctx.businessName ? ` (${ctx.businessName})` : ""}`,
        `Reason: ${reason}`,
        `Assigned to: ${agent}`,
        `AI has stepped back. Task + appointment created in GHL.`,
        ...(conversationSummary ? [``, `--- Summary ---`, conversationSummary.slice(0, 500)] : []),
      ].join("\n"),
    });
    actions.push("Sent owner notification");
  } catch { /* best effort */ }

  return { actionsExecuted: actions, errors, skipped: false };
}

// ─── Main Dispatch Entry Point ──────────────────────────────────────────────

/**
 * Dispatch GHL actions based on a conversation state transition.
 *
 * Called by webhook-message.ts after processInboundState() detects a state change.
 * Only fires when the state actually changed (stateResult.changed === true).
 *
 * This is the CENTRALIZED action point — no other file should directly
 * create tasks or move pipelines in response to conversation state changes.
 */
export async function dispatchStateActions(
  stateResult: StateTransitionResult,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  // Only dispatch on actual state changes
  if (!stateResult.changed) {
    return { actionsExecuted: [], errors: [], skipped: true, reason: "No state change" };
  }

  const { newState, previousState, intent, transitionReason } = stateResult;

  console.log(`[ActionDispatcher] Lead ${ctx.leadId}: ${previousState} → ${newState} | Dispatching actions...`);

  try {
    switch (newState) {
      case "committed":
        return await handleCommitted(ctx, intent);

      case "interested":
        // Only dispatch if transitioning FROM a lower state (avoid re-creating tasks)
        if (["new_lead", "exploring", "stale"].includes(previousState)) {
          return await handleInterested(ctx, intent);
        }
        return { actionsExecuted: [], errors: [], skipped: true, reason: `Already past interested (was ${previousState})` };

      case "dnc_channel":
        return await handleDncChannel(ctx);

      case "dnc_all":
        return await handleDncAll(ctx);

      case "fulfilled":
        return await handleFulfilled(ctx);

      case "human_active":
        return await handleHumanActive(ctx, transitionReason);

      case "objecting":
        // Objections don't trigger GHL actions — they change Brain Council behavior
        try {
          await addNote(ctx.ghlContactId,
            `🤖 AI State Machine: Customer OBJECTING\n` +
            `Intent: ${intent.intent} — "${intent.reasoning}"\n` +
            `AI will use objection-handling approach for next response.`
          );
        } catch { /* best effort */ }
        return { actionsExecuted: ["Added objection note"], errors: [], skipped: false };

      case "exploring":
        // No GHL actions needed — just a state update
        return { actionsExecuted: [], errors: [], skipped: true, reason: "Exploring state needs no GHL actions" };

      case "stale":
        // Stale leads are handled by the disposition engine sweep, not inline
        return { actionsExecuted: [], errors: [], skipped: true, reason: "Stale leads handled by disposition sweep" };

      case "new_lead":
        // Should not transition TO new_lead (it's the initial state)
        return { actionsExecuted: [], errors: [], skipped: true, reason: "Cannot transition to new_lead" };

      default:
        console.warn(`[ActionDispatcher] Unknown state: ${newState}`);
        return { actionsExecuted: [], errors: [], skipped: true, reason: `Unknown state: ${newState}` };
    }
  } catch (err: any) {
    console.error(`[ActionDispatcher] Lead ${ctx.leadId}: Unhandled error:`, err);
    return { actionsExecuted: [], errors: [`Unhandled error: ${err?.message}`], skipped: false };
  }
}

/**
 * Build a DispatchContext from a lead row (convenience helper).
 * Used by webhook-message.ts and other callers.
 */
export function buildDispatchContext(lead: any, channel: string): DispatchContext {
  return {
    leadId: lead.id,
    ghlContactId: lead.ghlContactId,
    leadName: lead.name,
    businessName: lead.businessName,
    email: lead.email,
    phone: lead.phone,
    assignedAgent: lead.assignedAgent,
    pipelineValue: lead.pipelineValue ?? null,
    ghlOpportunityId: lead.ghlOpportunityId || null,
    ghlPipelineId: lead.ghlPipelineId || null,
    channel,
    pipelineStage: lead.pipelineStage || null,
  };
}
