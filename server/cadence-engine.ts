/**
 * CADENCE ENGINE — Deterministic Timing Controller
 * 
 * This module owns ALL timing decisions for lead engagement.
 * No LLM should ever decide when to send a message.
 * 
 * Rules:
 * 1. Max 1 proactive outbound per lead per calendar day (ET)
 * 2. Inbound replies bypass the daily cap (but still respect minimum spacing)
 * 3. Minimum spacing between any two messages: 2 hours
 * 4. Cadence varies by pipeline stage and lead age
 * 5. Business hours only: 9 AM - 7 PM ET (Mon-Sat)
 */

// ─── CADENCE TABLE ───────────────────────────────────────────────
// Stage → { minHours, maxHours, businessHoursOnly }
// minHours: absolute minimum before next proactive outreach
// maxHours: maximum — if exceeded, lead is "overdue"
// These are HARD rules. The Strategist's nextEngagementHours is IGNORED
// if it falls outside this range.

interface CadenceRule {
  minHours: number;
  maxHours: number;
  businessHoursOnly: boolean;
}

const CADENCE_TABLE: Record<string, CadenceRule> = {
  // New Lead: first 48h are critical — follow up within 24-48h
  "new_lead":       { minHours: 24, maxHours: 48,  businessHoursOnly: true },
  // Contacted: they've been reached, wait for response
  "contacted":      { minHours: 48, maxHours: 96,  businessHoursOnly: true },
  // Qualified: active conversation — more frequent is OK
  "qualified":      { minHours: 24, maxHours: 72,  businessHoursOnly: true },
  // Quote Sent: waiting for decision — don't pressure too fast
  "quote_sent":     { minHours: 48, maxHours: 120, businessHoursOnly: true },
  // Won: post-sale — gentle follow-up
  "won":            { minHours: 168, maxHours: 336, businessHoursOnly: true },
  // Stale/Reactivation: long dormant — space it out
  "stale":          { minHours: 72, maxHours: 168, businessHoursOnly: true },
  // Default fallback
  "default":        { minHours: 24, maxHours: 72,  businessHoursOnly: true },
};

// ─── BUSINESS HOURS ──────────────────────────────────────────────
const BUSINESS_START_HOUR = 9;  // 9 AM ET
const BUSINESS_END_HOUR = 19;   // 7 PM ET
const BUSINESS_DAYS = [1, 2, 3, 4, 5, 6]; // Mon-Sat (0=Sun)

function isBusinessHoursET(date: Date): boolean {
  const etStr = date.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etStr);
  const hour = etDate.getHours();
  const day = etDate.getDay();
  return BUSINESS_DAYS.includes(day) && hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

function nextBusinessHourET(fromDate: Date): Date {
  const result = new Date(fromDate);
  // Move forward in 30-minute increments until we hit business hours
  for (let i = 0; i < 200; i++) { // safety limit: ~4 days
    if (isBusinessHoursET(result)) return result;
    result.setMinutes(result.getMinutes() + 30);
  }
  // Fallback: return 24h from now
  return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
}

// ─── MAIN FUNCTION ───────────────────────────────────────────────

export interface CadenceInput {
  /** Pipeline stage slug (e.g., "new_lead", "contacted", "qualified") */
  pipelineStage: string;
  /** When the last AI outbound was sent (null if never) */
  lastAiSendAt: Date | null;
  /** When the lead was created */
  leadCreatedAt: Date;
  /** How many unanswered outbound messages exist */
  unansweredCount: number;
  /** Whether this is an inbound reply (bypasses daily cap but respects spacing) */
  isInboundReply: boolean;
  /** The Strategist's suggested nextEngagementHours (will be clamped to cadence table) */
  strategistSuggestedHours?: number;
}

export interface CadenceDecision {
  /** When to send the next message */
  nextSendAt: Date;
  /** Hours from now until next send */
  hoursUntilSend: number;
  /** Whether the cadence engine overrode the Strategist's suggestion */
  wasOverridden: boolean;
  /** Human-readable reason for the decision */
  reason: string;
  /** Whether the lead is currently in a "send now" window */
  canSendNow: boolean;
}

export function computeCadence(input: CadenceInput): CadenceDecision {
  const now = new Date();
  const stage = input.pipelineStage.toLowerCase().replace(/\s+/g, "_");
  const rule = CADENCE_TABLE[stage] || CADENCE_TABLE["default"];

  // ─── INBOUND REPLY: minimum 2h spacing, no daily cap ───
  if (input.isInboundReply) {
    const minSpacing = 2 * 60 * 60 * 1000; // 2 hours
    if (input.lastAiSendAt) {
      const elapsed = now.getTime() - input.lastAiSendAt.getTime();
      if (elapsed < minSpacing) {
        const nextSendAt = new Date(input.lastAiSendAt.getTime() + minSpacing);
        const adjusted = rule.businessHoursOnly ? nextBusinessHourET(nextSendAt) : nextSendAt;
        return {
          nextSendAt: adjusted,
          hoursUntilSend: (adjusted.getTime() - now.getTime()) / (1000 * 60 * 60),
          wasOverridden: false,
          reason: `Inbound reply — minimum 2h spacing. Last send was ${Math.round(elapsed / 60000)}min ago.`,
          canSendNow: false,
        };
      }
    }
    // Inbound reply with no recent send — can send now (if business hours)
    if (rule.businessHoursOnly && !isBusinessHoursET(now)) {
      const nextBH = nextBusinessHourET(now);
      return {
        nextSendAt: nextBH,
        hoursUntilSend: (nextBH.getTime() - now.getTime()) / (1000 * 60 * 60),
        wasOverridden: false,
        reason: "Inbound reply — outside business hours, queued for next business hour.",
        canSendNow: false,
      };
    }
    return {
      nextSendAt: now,
      hoursUntilSend: 0,
      wasOverridden: false,
      reason: "Inbound reply — can respond immediately.",
      canSendNow: true,
    };
  }

  // ─── PROACTIVE OUTREACH: enforce cadence table ───

  // If never sent, use minHours from lead creation
  if (!input.lastAiSendAt) {
    // For brand new leads, first message can go out sooner (within 1-4 hours)
    const leadAgeMs = now.getTime() - input.leadCreatedAt.getTime();
    const leadAgeHours = leadAgeMs / (1000 * 60 * 60);
    
    if (leadAgeHours < 4) {
      // Brand new lead — can send first message now if in business hours
      if (rule.businessHoursOnly && !isBusinessHoursET(now)) {
        const nextBH = nextBusinessHourET(now);
        return {
          nextSendAt: nextBH,
          hoursUntilSend: (nextBH.getTime() - now.getTime()) / (1000 * 60 * 60),
          wasOverridden: false,
          reason: "New lead, first message — queued for next business hour.",
          canSendNow: false,
        };
      }
      return {
        nextSendAt: now,
        hoursUntilSend: 0,
        wasOverridden: false,
        reason: "New lead, first message — can send now.",
        canSendNow: true,
      };
    }

    // Older lead that was never messaged — use minHours from creation
    const nextSendAt = new Date(input.leadCreatedAt.getTime() + rule.minHours * 60 * 60 * 1000);
    const adjusted = rule.businessHoursOnly ? nextBusinessHourET(nextSendAt) : nextSendAt;
    const canSendNow = adjusted.getTime() <= now.getTime();
    return {
      nextSendAt: canSendNow ? now : adjusted,
      hoursUntilSend: canSendNow ? 0 : (adjusted.getTime() - now.getTime()) / (1000 * 60 * 60),
      wasOverridden: false,
      reason: canSendNow
        ? `Lead created ${leadAgeHours.toFixed(0)}h ago, never messaged — can send now.`
        : `Lead created ${leadAgeHours.toFixed(0)}h ago — next send in ${((adjusted.getTime() - now.getTime()) / (1000 * 60 * 60)).toFixed(1)}h.`,
      canSendNow,
    };
  }

  // ─── ENFORCE MINIMUM HOURS ───
  const elapsedMs = now.getTime() - input.lastAiSendAt.getTime();
  const elapsedHours = elapsedMs / (1000 * 60 * 60);

  // Clamp the Strategist's suggestion to the cadence table range
  let targetHours = input.strategistSuggestedHours || rule.minHours;
  let wasOverridden = false;

  if (targetHours < rule.minHours) {
    targetHours = rule.minHours;
    wasOverridden = true;
  }
  if (targetHours > rule.maxHours) {
    targetHours = rule.maxHours;
    wasOverridden = true;
  }

  // Progressive backoff: increase spacing with unanswered count
  // After 3+ unanswered messages, add 24h per additional message
  if (input.unansweredCount >= 3) {
    const extraHours = (input.unansweredCount - 2) * 24;
    targetHours = Math.min(targetHours + extraHours, rule.maxHours * 2);
    wasOverridden = true;
  }

  const nextSendAt = new Date(input.lastAiSendAt.getTime() + targetHours * 60 * 60 * 1000);
  const adjusted = rule.businessHoursOnly ? nextBusinessHourET(nextSendAt) : nextSendAt;
  const canSendNow = adjusted.getTime() <= now.getTime();

  return {
    nextSendAt: canSendNow ? now : adjusted,
    hoursUntilSend: canSendNow ? 0 : (adjusted.getTime() - now.getTime()) / (1000 * 60 * 60),
    wasOverridden,
    reason: canSendNow
      ? `${elapsedHours.toFixed(1)}h since last send (min: ${rule.minHours}h) — can send now.`
      : `${elapsedHours.toFixed(1)}h since last send, target: ${targetHours}h (stage: ${stage}, unanswered: ${input.unansweredCount}).`,
    canSendNow,
  };
}

/**
 * Convert a pipeline stage name to a cadence table key.
 * Handles various formats from GHL.
 */
export function normalizeStageName(stageName: string | null | undefined): string {
  if (!stageName) return "default";
  const normalized = stageName.toLowerCase().trim().replace(/\s+/g, "_");
  if (normalized.includes("new")) return "new_lead";
  if (normalized.includes("contact")) return "contacted";
  if (normalized.includes("qualif")) return "qualified";
  if (normalized.includes("quote")) return "quote_sent";
  if (normalized.includes("won") || normalized.includes("closed")) return "won";
  if (normalized.includes("stale") || normalized.includes("dormant") || normalized.includes("reactivat")) return "stale";
  return "default";
}
