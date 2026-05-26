/**
 * OUTPUT GUARDS — Safety net between brain output and send.
 * 
 * Runs AFTER the single brain returns a decision, BEFORE the message is sent.
 * Each guard can BLOCK (reject the message) or FORCE-CORRECT (fix and pass).
 * 
 * Guards:
 * 1. System leak detection (mentions of internal systems)
 * 2. Channel mismatch (inbound reply must stay on inbound channel)
 * 3. Price validation ($ in message must match getQuote tool result)
 * 4. DNC keyword in outbound message
 * 5. Null message with advance action (strip the action)
 * 6. Message length sanity check
 * 7. Content guard — banned phrases (Rule 15 filler, Rule 17 sign-offs, Rule 18 fabricated infrastructure)
 */

import type { SingleBrainInput } from "./single-brain";

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
  subject?: string | null;
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

// ── Guard 7: Content guard — banned phrases ─────────────────────────────
// Full union of Rule 15 (filler phrases), Rule 17 (sign-offs), Rule 18 (fabricated infrastructure).
// Sign-off entries are SMS/IG-only; all others apply to every channel.
//
// reasonCode format: <category>:<slug>
//   filler_*          — Rule 15 banned filler phrases
//   banned_signoff_*  — Rule 17 banned sign-offs (SMS/IG only)
//   fabricated_*      — Rule 18 fabricated infrastructure
//
// Entry types:
//   exact  — case-insensitive substring match via toLowerCase().includes()
//   regex  — compiled RegExp with provided flags
export type ContentGuardEntry =
  | { type: "exact"; token: string; reasonCode: string; smsIgOnly?: boolean }
  | { type: "regex"; pattern: string; flags: string; reasonCode: string; smsIgOnly?: boolean };

export const CONTENT_GUARD_TOKENS: ContentGuardEntry[] = [
  // Rule 18 — fabricated infrastructure
  { type: "exact", token: "calendar invite",       reasonCode: "fabricated_calendar_invite" },
  { type: "exact", token: "confirming you got",     reasonCode: "fabricated_confirmation" },
  { type: "exact", token: "from our call",          reasonCode: "fabricated_meeting_history" },
  { type: "exact", token: "as we discussed",        reasonCode: "fabricated_discussion" },
  { type: "exact", token: "tracking number",        reasonCode: "fabricated_tracking" },
  { type: "exact", token: "customer portal",        reasonCode: "fabricated_portal" },
  { type: "exact", token: "account dashboard",      reasonCode: "fabricated_dashboard" },

  // Rule 15 — banned filler phrases
  { type: "exact", token: "just thinking about",    reasonCode: "filler_just_thinking" },
  { type: "exact", token: "just checking in",       reasonCode: "filler_checking_in" },
  { type: "exact", token: "circle back",            reasonCode: "filler_circle_back" },
  { type: "exact", token: "circling back",          reasonCode: "filler_circling_back" },
  { type: "exact", token: "touching base",          reasonCode: "filler_touching_base" },
  { type: "exact", token: "i wanted to reach out",  reasonCode: "filler_wanted_to_reach_out" },
  { type: "exact", token: "just wanted to",         reasonCode: "filler_just_wanted_to" },
  { type: "exact", token: "make your brand pop",    reasonCode: "filler_make_pop" },
  { type: "exact", token: "elevate your brand",     reasonCode: "filler_elevate" },

  // Rule 17 — banned sign-offs (SMS/IG only)
  { type: "exact", token: "thanks, adorb custom printing", reasonCode: "banned_signoff_caps",  smsIgOnly: true },
  { type: "exact", token: "thanks, adorb",                 reasonCode: "banned_signoff_short", smsIgOnly: true },
  { type: "exact", token: "best regards",                  reasonCode: "banned_signoff_formal", smsIgOnly: true },
  { type: "exact", token: "warm regards",                  reasonCode: "banned_signoff_warm",  smsIgOnly: true },

  // Rule 15 — additional regex patterns (spec §3.1)
  { type: "regex", pattern: "\\bmake your [\\w ]{1,30} pop\\b",                    flags: "i", reasonCode: "filler_make_X_pop" },
  { type: "regex", pattern: "\\btake your [\\w ]{1,30} to the next level\\b",     flags: "i", reasonCode: "filler_take_to_next_level" },
];

/**
 * Check a composed message against the banned-phrase list.
 * Returns blocked:true + reasonCode + matchedToken if any token is found.
 * Sign-off rules only apply when channel is SMS or IG.
 *
 * Supports two entry types:
 *   exact — case-insensitive substring match via toLowerCase().includes()
 *   regex — compiled RegExp with provided flags
 */
export function checkContentGuard(
  message: string,
  channel: string
): { blocked: boolean; reasonCode?: string; matchedToken?: string } {
  const lower = message.toLowerCase();
  const isSmsOrIg = channel === "SMS" || channel === "IG";

  for (const entry of CONTENT_GUARD_TOKENS) {
    if (entry.smsIgOnly && !isSmsOrIg) continue;

    if (entry.type === "exact") {
      if (lower.includes(entry.token)) {
        return { blocked: true, reasonCode: entry.reasonCode, matchedToken: entry.token };
      }
    } else if (entry.type === "regex") {
      const re = new RegExp(entry.pattern, entry.flags);
      const match = re.exec(message);
      if (match) {
        return { blocked: true, reasonCode: entry.reasonCode, matchedToken: match[0] };
      }
    }
  }
  return { blocked: false };
}

// ── Main guard runner ───────────────────────────────────────────────────

export function runOutputGuards(
  decision: BrainDecision,
  lead: LeadLike,
  input: SingleBrainInput,
  toolLog: ToolCallRecord[] = []
): GuardResult {
  // Guard 1: System leak — block if message mentions internal system names
  if (decision.message && SYSTEM_LEAK_PATTERNS.test(decision.message)) {
    return block("system_leak", "Message contains internal system references");
  }

  // Guard 2: Channel mismatch — inbound replies must match inbound channel
  // Fires whenever we're responding to an inbound message and the brain
  // picked a different channel. Independent of messageCount and
  // preferredChannel (both were wrong proxies in the original guard).
  if (
    input.inboundMessage &&
    input.channel &&
    decision.channel &&
    decision.channel !== input.channel
  ) {
    return {
      passed: true,
      action: "corrected",
      reason: `Channel forced from ${decision.channel} to ${input.channel} (inbound reply must match inbound channel)`,
      correctedDecision: {
        ...decision,
        channel: input.channel as BrainDecision["channel"],
      },
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

  // Guard 7: Content guard — banned phrases (Rule 15 filler, Rule 17 sign-offs, Rule 18 fabricated infrastructure)
  if (decision.message) {
    const contentCheck = checkContentGuard(decision.message, decision.channel);
    if (contentCheck.blocked) {
      return block(
        `output_guard:content:${contentCheck.reasonCode}`,
        `Banned phrase detected: "${contentCheck.matchedToken}" (${contentCheck.reasonCode})`
      );
    }
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
