/**
 * LAYER 5: ACTION DISPATCHER — Translates ConversationState changes into GHL actions
 *
 * This module is the SINGLE place where state transitions trigger side effects.
 * It replaces scattered pipeline update calls across 6+ files.
 *
 * State → Action mapping:
 *   committed     → Create mockup task for designer + move pipeline to "Paid - Proof Needed"
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

import { updateLeadFields, addConversation, getLeadById } from "./db";
import { createTask, addNote, updateOpportunityStage, getOpportunitiesByContact } from "./ghl";
import { handleChannelDnc, allChannelsExhausted, detectDncChannel } from "./channel-fallback";
import { calculateNextFollowUp } from "./scheduling-engine";
import { STAGES, SALES_AGENTS, DESIGNER } from "./webhook-helpers";
import { getNqStageId } from "../shared/ghl-stages";
import type { ConversationState, StateTransitionResult } from "./conversation-state";
import type { IntentResult } from "./intent-classifier";

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
 * Paulette's case: customer confirmed details → create mockup task + notify team.
 *
 * Actions:
 * 1. Create a GHL task for the designer to build the mockup
 * 2. Add a GHL note documenting the commitment
 * 3. Schedule a follow-up for proof delivery
 */
async function handleCommitted(ctx: DispatchContext, intent: IntentResult): Promise<DispatchResult> {
  const actions: string[] = [];
  const errors: string[] = [];
  const leadLabel = ctx.leadName || ctx.businessName || "Lead";

  // 1. Create mockup/design task for the designer
  try {
    await createTask(ctx.ghlContactId, {
      title: `🎨 Build mockup for ${leadLabel} — Customer confirmed details`,
      body: [
        `Customer has confirmed their order details and is ready to proceed.`,
        ``,
        `Business: ${ctx.businessName || "N/A"}`,
        `Contact: ${ctx.leadName || "N/A"}`,
        `Email: ${ctx.email || "N/A"}`,
        `Estimated Value: $${ctx.pipelineValue || "TBD"}`,
        ``,
        `Check the conversation history and contact notes for:`,
        `- Product type, quantity, sizes`,
        `- Design details (text, logos, colors)`,
        `- Timeline/event date`,
        ``,
        `Intent: ${intent.intent} (${intent.confidence}% confidence)`,
        `Reason: ${intent.reasoning}`,
      ].join("\n"),
      assignedTo: DESIGNER,
    });
    actions.push(`Created mockup task for ${DESIGNER}`);
    console.log(`[ActionDispatcher] Lead ${ctx.leadId}: Created mockup task for ${DESIGNER}`);
  } catch (err: any) {
    errors.push(`Failed to create mockup task: ${err?.message}`);
    console.error(`[ActionDispatcher] Lead ${ctx.leadId}: Failed to create mockup task:`, err);
  }

  // 2. Add GHL note
  try {
    await addNote(ctx.ghlContactId,
      `🤖 AI State Machine: Customer COMMITTED\n` +
      `Intent: ${intent.intent} — "${intent.reasoning}"\n` +
      `Action: Mockup task created for ${DESIGNER}.\n` +
      `Next: Designer builds proof → send to customer for approval.`
    );
    actions.push("Added commitment note to GHL");
  } catch { /* best effort */ }

  // 3. Schedule follow-up for proof delivery (check in 2 days if no proof sent)
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

  // Only create quote task for price inquiries or design requests with value
  if (intent.intent === "price_inquiry" || intent.intent === "design_request") {
    try {
      const estValue = ctx.pipelineValue ? ` — Est. $${ctx.pipelineValue}` : "";
      await createTask(ctx.ghlContactId, {
        title: `📋 Review & quote for ${leadLabel}${estValue}`,
        body: [
          `Customer is showing strong interest (${intent.intent}).`,
          ``,
          `Business: ${ctx.businessName || "N/A"}`,
          `Contact: ${ctx.leadName || "N/A"}`,
          `Email: ${ctx.email || "N/A"}`,
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

  // Add note
  try {
    await addNote(ctx.ghlContactId,
      `🤖 AI State Machine: Lead moved to INTERESTED\n` +
      `Intent: ${intent.intent} — "${intent.reasoning}"`
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

  try {
    await addNote(ctx.ghlContactId,
      `🤖 AI State Machine: Lead FULFILLED\n` +
      `Order delivered/completed. Post-delivery follow-up scheduled.`
    );
  } catch { /* best effort */ }

  return { actionsExecuted: actions, errors, skipped: false };
}

/**
 * Handle transition TO "human_active" state.
 * Human agent is managing — ensure humanTakeover is set and add note.
 */
async function handleHumanActive(ctx: DispatchContext, reason: string): Promise<DispatchResult> {
  const actions: string[] = [];
  const errors: string[] = [];

  try {
    await updateLeadFields(ctx.leadId, {
      humanTakeover: 1,
      lastAgentActivityAt: new Date(),
    });
    actions.push("Set humanTakeover=1");
  } catch (err: any) {
    errors.push(`Failed to set humanTakeover: ${err?.message}`);
  }

  try {
    await addNote(ctx.ghlContactId,
      `🤖 AI State Machine: HUMAN ACTIVE\n` +
      `Reason: ${reason}\n` +
      `AI will stand down until agent activity expires (2hr window).`
    );
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
  };
}
