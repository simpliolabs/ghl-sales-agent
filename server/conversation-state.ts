/**
 * LAYER 2: CONVERSATION STATE MACHINE — Single source of truth for lead's sales journey position
 *
 * Replaces scattered isFirstResponse, humanTakeover, pipelineStage, and convHistory.length
 * checks that currently exist across 8+ files.
 *
 * Phase A: Observation mode — computes and persists state, but does NOT change routing behavior.
 * The state is logged and stored for analysis. Future phases will use it for routing decisions.
 */

import { classifyIntent, fallbackIntent, type IntentResult, type MessageIntent } from "./intent-classifier";
import { updateLeadFields } from "./db";
import { getStagePlaybook, isTerminalStage as isPlaybookTerminal, isAiProactiveAtStage } from "./stage-playbook";

// ─── Conversation States ────────────────────────────────────────────────────

export type ConversationState =
  | "new_lead"        // First contact, no prior messages
  | "exploring"       // Engaged but no commitment signal
  | "interested"      // Gave design details, asking price/timeline
  | "committed"       // Said "yes", "sounds good", "thank you" after confirmation
  | "objecting"       // Raised price/timing/competitor objection
  | "dnc_channel"     // Said "Stop" on one channel
  | "dnc_all"         // All channels blocked
  | "human_active"    // Human agent sent message within 2hr
  | "fulfilled"       // Order placed, proof sent, paid
  | "stale";          // No response in 7+ days

export interface StateTransitionResult {
  previousState: ConversationState;
  newState: ConversationState;
  intent: IntentResult;
  transitionReason: string;
  changed: boolean;
}

// ─── State Transition Logic ─────────────────────────────────────────────────

/**
 * Compute the next conversation state based on:
 * - Current state (from DB)
 * - Classified intent of the latest message
 * - Pipeline stage (from GHL)
 * - Human takeover status
 * - Days since last response
 */
export function computeNextState(
  currentState: ConversationState,
  intent: IntentResult,
  context: {
    pipelineStage?: string;
    humanTakeover?: boolean;
    daysSinceLastResponse?: number;
    allChannelsBlocked?: boolean;
    hasDesignDetails?: boolean;
  },
): { state: ConversationState; reason: string } {

  // ── Hard overrides (these take priority regardless of intent) ──

  // Human agent active → human_active
  if (context.humanTakeover) {
    return { state: "human_active", reason: "Human agent is actively managing this conversation" };
  }

  // DNC on all channels → dnc_all
  if (context.allChannelsBlocked) {
    return { state: "dnc_all", reason: "All communication channels are blocked" };
  }

  // Stale check: 7+ days no response and not already in a terminal state
  if (
    context.daysSinceLastResponse !== undefined &&
    context.daysSinceLastResponse >= 7 &&
    !["committed", "fulfilled", "dnc_all", "dnc_channel"].includes(currentState)
  ) {
    return { state: "stale", reason: `No response in ${context.daysSinceLastResponse} days` };
  }

  // Pipeline-driven states (fulfilled stages)
  const fulfilledStages = ["delivered", "won", "completed"];
  if (context.pipelineStage && fulfilledStages.some(s => context.pipelineStage!.toLowerCase().includes(s))) {
    return { state: "fulfilled", reason: `Pipeline stage "${context.pipelineStage}" indicates fulfillment` };
  }

  // ── Intent-driven transitions ──

  switch (intent.intent) {
    case "dnc":
      return { state: "dnc_channel", reason: "Customer requested to stop messages on this channel" };

    case "complaint":
      // Complaints escalate to human_active
      return { state: "human_active", reason: "Customer complaint detected — escalating to human agent" };

    case "objection":
      return { state: "objecting", reason: `Customer raised objection: ${intent.reasoning}` };

    case "thank_you_close":
      // This is the key Paulette fix: "thank you" after confirmation = committed
      if (intent.closingSignal) {
        return { state: "committed", reason: "Closing signal: customer said thank you after confirming details" };
      }
      // Non-closing thank you — stay in current state or move to exploring
      return { state: currentState === "new_lead" ? "exploring" : currentState, reason: "Generic thank you — no closing signal" };

    case "confirmation":
      if (intent.closingSignal) {
        return { state: "committed", reason: "Customer confirmed order details with closing signal" };
      }
      // Confirmation without closing signal: they're interested
      if (["new_lead", "exploring"].includes(currentState)) {
        return { state: "interested", reason: "Customer confirmed details — showing interest" };
      }
      return { state: currentState, reason: "Confirmation received, maintaining current state" };

    case "design_request":
      // Providing design details = interested (or stays interested/committed)
      if (["new_lead", "exploring", "stale"].includes(currentState)) {
        return { state: "interested", reason: "Customer provided design details" };
      }
      return { state: currentState, reason: "Design details received, maintaining current state" };

    case "soft_decline":
      // Soft decline = polite no. Back off but don't close the door.
      // Move to stale so the scheduling engine uses longer cadence.
      return { state: "stale", reason: "Customer politely declined — backing off to longer cadence" };

    case "competitor_won":
      // Customer explicitly hired someone else / placed order elsewhere. This is a LOST deal.
      // Move to dnc_all so the system stops all outreach and marks Not Qualified.
      return { state: "dnc_all", reason: "Customer hired a competitor / placed order elsewhere — marking as lost" };

    case "price_inquiry":
      if (["new_lead", "exploring"].includes(currentState)) {
        return { state: "interested", reason: "Customer asking about pricing — showing buying intent" };
      }
      return { state: currentState, reason: "Price inquiry received, maintaining current state" };

    case "reorder":
      return { state: "interested", reason: "Customer wants to reorder — active buying intent" };

    case "referral":
      return { state: currentState, reason: "Referral mention — maintaining current state" };

    case "question":
      if (currentState === "new_lead") {
        return { state: "exploring", reason: "Customer asking questions — engaged and exploring" };
      }
      return { state: currentState, reason: "Question received, maintaining current state" };

    case "general_chat":
      if (currentState === "new_lead") {
        return { state: "exploring", reason: "Customer engaged in conversation" };
      }
      return { state: currentState, reason: "General chat, maintaining current state" };

    case "attachment_only":
      // Attachments (logos, designs) = interested
      if (["new_lead", "exploring"].includes(currentState)) {
        return { state: "interested", reason: "Customer sent attachment (likely design/logo)" };
      }
      return { state: currentState, reason: "Attachment received, maintaining current state" };

    case "unclear":
    default:
      return { state: currentState, reason: "Intent unclear, maintaining current state" };
  }
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Classify intent and compute state transition for an inbound message.
 * Persists the new state and intent history to the database.
 *
 * Phase A: This is called in observation mode — it classifies and stores,
 * but the returned state does NOT yet drive routing decisions.
 */
export async function processInboundState(params: {
  leadId: number;
  message: string;
  conversationHistory: string;
  currentState: ConversationState;
  pipelineStage?: string;
  humanTakeover?: boolean;
  daysSinceLastResponse?: number;
  allChannelsBlocked?: boolean;
  existingIntentHistory?: IntentResult[];
}): Promise<StateTransitionResult> {
  const {
    leadId,
    message,
    conversationHistory,
    currentState,
    pipelineStage,
    humanTakeover,
    daysSinceLastResponse,
    allChannelsBlocked,
    existingIntentHistory = [],
  } = params;

  // Step 1: Classify intent
  const intent = await classifyIntent(message, conversationHistory, pipelineStage);

  console.log(`[ConvState] Lead ${leadId}: intent=${intent.intent} (${intent.confidence}%), closing=${intent.closingSignal}, reason="${intent.reasoning}"`);

  // Step 2: Compute next state
  const { state: newState, reason } = computeNextState(currentState, intent, {
    pipelineStage,
    humanTakeover,
    daysSinceLastResponse,
    allChannelsBlocked,
  });

  const changed = newState !== currentState;
  if (changed) {
    console.log(`[ConvState] Lead ${leadId}: STATE TRANSITION ${currentState} → ${newState} (${reason})`);
  }

  // Step 3: Persist to DB
  // Keep last 10 intents in history
  const updatedHistory = [intent, ...existingIntentHistory].slice(0, 10);

  try {
    await updateLeadFields(leadId, {
      convState: newState,
      convStateUpdatedAt: Date.now(),
      intentHistory: updatedHistory,
    });
  } catch (err) {
    console.error(`[ConvState] Failed to persist state for lead ${leadId}:`, err);
  }

  return {
    previousState: currentState,
    newState,
    intent,
    transitionReason: reason,
    changed,
  };
}

/**
 * Compute state from pipeline stage changes (no LLM needed).
 * Called by webhook-pipeline.ts when a stage change occurs.
 */
export function stateFromPipelineStage(stage: string): ConversationState | null {
  const lower = stage.toLowerCase();
  // Terminal stages
  if (lower.includes("delivered") || lower.includes("won") || lower.includes("completed")) return "fulfilled";
  // Check "not qualified" / "lost" BEFORE "qualified" to avoid false match
  if (lower.includes("not qualified") || lower.includes("lost")) return "dnc_all";
  // Post-payment stages → committed (order is in progress)
  if (lower.includes("paid") || lower.includes("approved") || lower.includes("deposit") || lower.includes("production") || lower.includes("ready")) return "committed";
  // Proof stages → committed (proof is in progress)
  if (lower.includes("proof sent")) return "committed";
  // Quote sent → interested (waiting for acceptance)
  if (lower.includes("quote")) return "interested";
  // Qualified → interested (details confirmed, quote coming)
  if (lower.includes("qualified")) return "interested";
  // Contacted → exploring (conversation started)
  if (lower.includes("contacted")) return "exploring";
  // New Lead → new_lead
  if (lower.includes("new lead")) return "new_lead";
  return null; // No state change implied by this stage
}

/**
 * Check if the AI should proactively reach out at the current pipeline stage.
 * Uses the Stage Playbook to determine proactivity.
 */
export function shouldAiBeProactive(pipelineStage: string | null | undefined): boolean {
  return isAiProactiveAtStage(pipelineStage);
}

/**
 * Check if the current pipeline stage is terminal (no further progression).
 */
export function isPipelineTerminal(pipelineStage: string | null | undefined): boolean {
  return isPlaybookTerminal(pipelineStage);
}
