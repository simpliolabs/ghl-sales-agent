/**
 * OUTPUT GUARDS — Safety net between brain output and send.
 * 
 * Runs AFTER the single brain returns a decision, BEFORE the message is sent.
 * Each guard can BLOCK (reject the message) or FORCE-CORRECT (fix and pass).
 * 
 * Guards:
 * 1. System leak detection (mentions of internal systems)
 * 2. Channel mismatch (first response must match inbound channel)
 * 3. Price validation ($ in message must match getQuote tool result)
 * 4. DNC keyword in outbound message
 * 5. Null message with advance action (strip the action)
 * 6. Message length sanity check
 */

export interface ToolCallRecord {
  name: string;
  args: string;
  result: any;
}

export interface BrainDecision {
  message: string | null;
  channel: "SMS" | "Email" | "FB" | "IG" | "WA";
  nextFollowUpHours: number;
  pipelineAction: "advance" | "mark_won" | "mark_lost" | "dnc" | null;
  routeToHuman: boolean;
  routeReason: string | null;
  confidence: number;
  toolLog?: ToolCallRecord[];
  promptVersion?: string;
}

export interface GuardResult {
  passed: boolean;
  action: "pass" | "block" | "corrected";
  reason: string | null;
  correctedDecision?: BrainDecision;
}

interface LeadLike {
  preferredChannel?: string | null;
  messageCount?: number;
}

// ── Guard patterns ──────────────────────────────────────────────────────

const SYSTEM_LEAK_PATTERNS = /brain\s*council|strategist|composer|qc\s*brain|expert\s*panel|deliberation|json\s*\{.*"message"|"channel"\s*:\s*"|outbox|drain\s*worker|single\s*brain|output\s*guard/i;

const DNC_KEYWORDS = ["stop", "unsubscribe", "opt out", "do not contact", "remove me", "take me off", "opt-out"];

// ── Main guard runner ───────────────────────────────────────────────────

export function runOutputGuards(
  decision: BrainDecision,
  lead: LeadLike,
  toolLog: ToolCallRecord[] = []
): GuardResult {
  // Guard 1: System leak — block if message mentions internal system names
  if (decision.message && SYSTEM_LEAK_PATTERNS.test(decision.message)) {
    return block("system_leak", "Message contains internal system references");
  }

  // Guard 2: Channel mismatch — force correct on first contact
  if (
    lead.preferredChannel &&
    (lead.messageCount === 0 || lead.messageCount === undefined) &&
    decision.channel !== lead.preferredChannel
  ) {
    const corrected = { ...decision, channel: lead.preferredChannel as BrainDecision["channel"] };
    return {
      passed: true,
      action: "corrected",
      reason: `Channel forced from ${decision.channel} to ${lead.preferredChannel} (first contact must match inbound)`,
      correctedDecision: corrected,
    };
  }

  // Guard 3: Price validation — if message mentions $, verify getQuote was called
  if (decision.message && /\$\d+/.test(decision.message)) {
    const quoteCall = toolLog.find((t) => t.name === "getQuote");
    if (!quoteCall) {
      return block("unverified_price", "Message contains $ amount but getQuote tool was not called");
    }
    // If getQuote returned an exact total, verify it appears in the message
    const quotedTotal = quoteCall.result?.total;
    if (quotedTotal && typeof quotedTotal === "number") {
      const totalStr = quotedTotal.toFixed(2);
      if (!decision.message.includes(totalStr)) {
        return block("price_mismatch", `Message price doesn't match getQuote result ($${totalStr})`);
      }
    }
  }

  // Guard 4: DNC keyword in outbound message (we should never send DNC phrases)
  if (decision.message) {
    const msgLower = decision.message.toLowerCase();
    const hasDnc = DNC_KEYWORDS.some((kw) => msgLower.includes(kw));
    if (hasDnc) {
      return block("outbound_dnc_phrase", "Outbound message contains DNC-like language");
    }
  }

  // Guard 5: Null message with advance action — strip the action
  if (!decision.message && decision.pipelineAction === "advance") {
    const corrected = { ...decision, pipelineAction: null as BrainDecision["pipelineAction"] };
    return {
      passed: true,
      action: "corrected",
      reason: "Stripped advance action from null-message decision",
      correctedDecision: corrected,
    };
  }

  // Guard 6: Message length sanity — block absurdly long messages
  if (decision.message && decision.message.length > 2000) {
    return block("message_too_long", `Message is ${decision.message.length} chars (max 2000)`);
  }

  return pass();
}

// ── Helpers ──────────────────────────────────────────────────────────────

function block(reason: string, detail: string): GuardResult {
  return { passed: false, action: "block", reason: `${reason}: ${detail}` };
}

function pass(): GuardResult {
  return { passed: true, action: "pass", reason: null };
}
