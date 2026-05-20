/**
 * BRAIN COUNCIL — Shared types for the multi-brain architecture
 */

export interface BrainCouncilInput {
  leadId: number;
  incomingMessage: string;
  channel: string;
  externalHistory?: string;
  formData?: Array<{ label: string; value: string }>;
  overrideReason?: string;
  /** When true, this is a response to an inbound message from the lead.
   *  Bypasses cadence backoff and relaxes dedup cooldown in the orchestrator. */
  isInboundReply?: boolean;
}

/**
 * APPROACH TAXONOMY — aligned with Lookback Engine's recommendedApproach.
 *
 * The Strategist picks one of these based on conversation context:
 *
 * OUTREACH (no prior meaningful interaction):
 *   first_contact    — Brand new lead, first message ever
 *   new_pitch        — No meaningful interaction yet, needs intro
 *
 * RESPONSIVE (lead asked something or provided info):
 *   answer_question  — Lead asked a question → ANSWER IT directly
 *   provide_quote    — Lead requested pricing/quote → provide ballpark or range
 *   acknowledge_info — Lead shared info (design, timeline, details) → confirm receipt + next step
 *   confirm_details  — Clarify specifics before proceeding (size, color, quantity)
 *
 * FOLLOW-UP (continuing an existing thread):
 *   follow_up        — Standard follow-up on an open conversation
 *   quote_follow_up  — Was quoted but never closed → nudge
 *   order_follow_up  — Had an order → check satisfaction or offer reorder
 *
 * RE-ENGAGEMENT (dormant or lapsed):
 *   reactivation     — Dormant lead, needs fresh value proposition (= win-back)
 *   win_back         — Alias for reactivation, used by lookback engine
 *
 * NURTURE (relationship maintenance):
 *   post_delivery    — After order delivered → satisfaction check
 *   relationship_nurture — Good relationship, stay in touch
 *   seasonal         — Seasonal/event-based outreach
 *   value_add        — Proactive value (tip, case study, portfolio)
 *
 * RECOVERY:
 *   recovery         — After a failed/blocked message, gentle re-approach
 */
export type Approach =
  | "first_contact" | "new_pitch"
  | "answer_question" | "provide_quote" | "acknowledge_info" | "confirm_details"
  | "follow_up" | "quote_follow_up" | "order_follow_up"
  | "reactivation" | "win_back"
  | "post_delivery" | "relationship_nurture" | "seasonal" | "value_add"
  | "recovery"
  | "graceful_exit";

export interface StrategyDecision {
  approach: Approach;
  channel: string;
  angle: string;
  framework: "PAS" | "BAB" | "AIDA" | "HORMOZI_ACA" | "HORMOZI_INDIRECT" | "SOCIAL_PROOF" | "CASE_STUDY" | "SOAP_OPERA" | "EMB_WELCOME" | "EMB_WINBACK" | "EMB_POST_PURCHASE" | "EMB_COLD" | "DIRECT_RESPONSE" | "VALUE_FIRST" | "CURIOSITY_HOOK" | "DAN_MARTELL";
  personalizationTier: 1 | 2 | 3;
  toneDirective: string;
  maxLength: number;
  keyPoints: string[];
  avoidPoints: string[];
  nextEngagementHours: number;
  reasoning: string;
  conversationStage?: "introduction" | "qualification" | "value_proposition" | "objection_handling" | "negotiation" | "closing" | "post_sale" | "reactivation" | "lost";
}

export interface ResearchResult {
  companyInfo: string;
  recentActivity: string;
  likelyPainPoints: string[];
  connectionPoints: string[];
  competitorInsights: string;
  seasonalRelevance: string;
  summary: string;
  /** Questions already asked in prior outbound messages — Composer must NOT repeat these */
  alreadyAsked: string[];
  /** Lead contact status: WARM, COLD, RESPONSIVE, or DORMANT */
  leadStatus: string;
  /** Confidence level for this research output.
   * - "verified": all facts sourced from form data or conversation history (ground truth)
   * - "inferred": some facts are LLM inferences from business name/segment (may be wrong)
   * - "insufficient": not enough data to produce reliable research
   * Downstream brains (Composer, QC) use this to calibrate how much to rely on research details.
   */
  dataConfidence: "verified" | "inferred" | "insufficient";
}

export interface ComposedMessage {
  message: string;
  fromName: string;
  subject?: string;
  internalNotes: string;
  _modelMeta?: {
    model: string;
    isFineTuned: boolean;
    jobId: number | null;
  };
}

export interface QCVerdict {
  approved: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
  revisedMessage?: string;
  /** Category of the violation for circuit breaker logic.
   * HARD_VIOLATION: immediately set humanTakeover=1 after 1 occurrence
   * SOFT_VIOLATION: circuit breaker trips after 5 consecutive occurrences */
  violationCategory?: string;
}

export interface BrainCouncilOutput {
  message: string;
  fromName: string;
  subject?: string;
  framework: string;
  angle: string;
  channel: string; // Strategist's chosen channel — callers should use this for sending
  extractedDates: string[];
  score: number;
  segment: string;
  nextEngagementHours: number;
  qcScore: number;
  strategyReasoning: string;
  researchSummary: string;
  blocked: boolean;
  blockReason?: string;
  violationCategory?: string;
  fallbackUsed: boolean;
  fallbackMessage?: string;
  // Phase 4: Self-Learning Loop metadata
  experimentId?: string;  // A/B experiment this message belongs to
  variant?: "A" | "B";   // Which variant was assigned
  persona?: string;       // Normalized persona (church, corporate, etc.)
  // Module 1: Conversation Stage Detection (SalesGPT pattern)
  conversationStage?: "introduction" | "qualification" | "value_proposition" | "objection_handling" | "negotiation" | "closing" | "post_sale" | "reactivation" | "lost";
  // Module 4: Multi-Agent Deliberation
  deliberationUsed?: boolean;
  deliberationNote?: string;
  // Foundation A.5: audit row ID so callers can update messageSent/sendOutcomeKind post-send
  auditId?: number;
}

export type ViolationCategory = "irrelevant_research" | "form_data_ignored" | "wrong_business" | "generic_opener" | "missing_framework" | "safety_violation" | "unanswered_question" | "info_not_acknowledged" | "repeated_question" | "repeated_opener" | "ignored_request" | "channel_mismatch" | "unverified_claim" | "context_free_subject" | "passive_reactivation" | "email_formatting" | "channel_switch_unacknowledged" | "referral_ask_in_inquiry" | "fresh_outreach_on_aged_lead" | "wrong_hours" | "sms_too_long";

export type LeadContext = {
  lead: any;
  convHistory: any[];
  state: any;
  tweakInstructions: string;
  kbContent: string;
  historyStr: string;
  isFirstResponse: boolean;
  priorOutbound: any[];
  leadAgeDays: number;
  urgencyStage: string;
  unansweredCount: number;
  lookbackContext: string;  // Lookback engine analysis: keyContext, recommendedApproach, status, sentiment
  lastInteractionSummary: string; // Cross-session memory: 1-sentence summary of last Brain Council interaction
  // Phase A: Conversation State Machine (observation mode — read-only context)
  convState?: string;  // Current conversation state (new_lead, exploring, interested, committed, etc.)
  intentHistory?: Array<{ intent: string; confidence: number; reasoning: string; closingSignal: boolean; timestamp: number }>;
  // Framework diversity: last 5 outreach frameworks used (excludes DIRECT_RESPONSE/VALUE_FIRST)
  recentOutreachFrameworks?: string[];
  // Original inbound channel — the channel the lead FIRST contacted us on (FB, SMS, Email, etc.)
  // Used for channel-switch context awareness in Composer and QC
  originalInboundChannel?: string | null;
  // Module 2A: ICP Cadence Multiplier
  icpTier?: "high" | "medium" | "low" | "unknown";
  // Module 5B: Private Memory
  privateMemory?: string;  // Formatted LEAD MEMORY block for prompt injection
};
