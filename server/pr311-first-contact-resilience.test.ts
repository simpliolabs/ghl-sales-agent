/**
 * PR#3.11 Tests: First-contact resilience — defensive crash fix + preliminary channel
 *
 * Test 1: fetchGhlConversationHistory throws on second call → function continues,
 *          channel detection falls through to payload-based detection, Brain Council still runs
 * Test 2: fetchGhlConversationHistory returns empty array → channel detection still works
 *          for IG via Layer 0B (form data + empty history)
 * Test 3: detectPreliminaryChannel returns "IG" for payload.source = "instagram"
 * Test 4: detectPreliminaryChannel returns "FB" for payload.contact.attributionSource.medium = "facebook"
 * Test 5: detectPreliminaryChannel returns null for ambiguous payloads (only SMS/Email/no signal)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock variables ────────────────────────────────────────────────
const {
  mockGetLeadById,
  mockUpdateLeadFields,
  mockFetchGhlConversationHistory,
  mockCheckRateLimits,
  mockCheckLeadRateLimit,
  mockGetRecentAiOutboundCount,
  mockGetConversationHistory,
  mockCheckDnc,
  mockRunBrainCouncil,
  mockSendMessageWithRetry,
  mockResearchLead,
  mockCalculateNextFollowUp,
} = vi.hoisted(() => ({
  mockGetLeadById: vi.fn(),
  mockUpdateLeadFields: vi.fn(),
  mockFetchGhlConversationHistory: vi.fn(),
  mockCheckRateLimits: vi.fn(),
  mockCheckLeadRateLimit: vi.fn(),
  mockGetRecentAiOutboundCount: vi.fn(),
  mockGetConversationHistory: vi.fn(),
  mockCheckDnc: vi.fn(),
  mockRunBrainCouncil: vi.fn(),
  mockSendMessageWithRetry: vi.fn(),
  mockResearchLead: vi.fn(),
  mockCalculateNextFollowUp: vi.fn(),
}));

// ─── Module mocks ──────────────────────────────────────────────────────────
vi.mock("./db", () => ({
  getLeadById: (...a: any[]) => mockGetLeadById(...a),
  updateLeadFields: (...a: any[]) => mockUpdateLeadFields(...a),
  getRecentAiOutboundCount: (...a: any[]) => mockGetRecentAiOutboundCount(...a),
  getConversationHistory: (...a: any[]) => mockGetConversationHistory(...a),
  upsertLead: vi.fn().mockResolvedValue({ id: 1 }),
  getLeadByGhlContactId: vi.fn().mockResolvedValue(null),
  addConversation: vi.fn().mockResolvedValue({ id: 999 }),
  upsertAiState: vi.fn().mockResolvedValue(undefined),
  addAgentAssignment: vi.fn().mockResolvedValue(undefined),
  getAgentWorkload: vi.fn().mockResolvedValue([]),
  syncGhlDnd: vi.fn().mockResolvedValue(undefined),
  insertDeferredResponse: vi.fn().mockResolvedValue(undefined),
  hasPendingDeferredResponse: vi.fn().mockResolvedValue(false),
  findExistingLeadByIdentity: vi.fn().mockResolvedValue(null),
  isAiOffline: vi.fn().mockResolvedValue(false),
  getAiState: vi.fn().mockResolvedValue(null),
  addPipelineEvent: vi.fn().mockResolvedValue(undefined),
  getSystemSetting: vi.fn().mockResolvedValue(null),
  setSystemSetting: vi.fn().mockResolvedValue(undefined),
  isChannelDnd: vi.fn().mockResolvedValue(false),
  getBlockedChannels: vi.fn().mockResolvedValue([]),
  getBestChannelForLead: vi.fn().mockResolvedValue(null),
  getLastEmailThreadId: vi.fn().mockResolvedValue(null),
  getLastEmailThreadInfo: vi.fn().mockResolvedValue(null),
  getDb: vi.fn().mockResolvedValue(null),
  getUncorrectedViolations: vi.fn().mockResolvedValue([]),
  updateAuditCorrection: vi.fn().mockResolvedValue(undefined),
  addBrainCouncilAudit: vi.fn().mockResolvedValue(undefined),
  getBrainCouncilAuditForLead: vi.fn().mockResolvedValue([]),
  acquireDbBrainCouncilLock: vi.fn().mockResolvedValue(true),
  releaseDbBrainCouncilLock: vi.fn().mockResolvedValue(undefined),
  getLeadsDueForFollowUp: vi.fn().mockResolvedValue([]),
  recordSendAttempt: vi.fn().mockResolvedValue(undefined),
  updateBrainCouncilAuditSendOutcome: vi.fn().mockResolvedValue(undefined),
  logDecision: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./ghl", () => ({
  fetchGhlConversationHistory: (...a: any[]) => mockFetchGhlConversationHistory(...a),
  getContact: vi.fn().mockResolvedValue(null),
  updateOpportunityStage: vi.fn().mockResolvedValue({}),
  addNote: vi.fn().mockResolvedValue({}),
  searchContacts: vi.fn().mockResolvedValue([]),
  updateContactCustomField: vi.fn().mockResolvedValue({}),
  updateOpportunityValue: vi.fn().mockResolvedValue({}),
  updateContactAssignment: vi.fn().mockResolvedValue({}),
  sendMessage: vi.fn().mockResolvedValue({ messageId: "msg_test" }),
  AGENT_GHL_USER_IDS: {},
}));

vi.mock("./scheduling-engine", () => ({
  checkRateLimits: (...a: any[]) => mockCheckRateLimits(...a),
  checkLeadRateLimit: (...a: any[]) => mockCheckLeadRateLimit(...a),
  calculateNextFollowUp: (...a: any[]) => mockCalculateNextFollowUp(...a),
  checkDnc: (...a: any[]) => mockCheckDnc(...a),
  capDate: vi.fn((d: Date) => d),
  DNC_KEYWORDS: [],
  isSmsQuietHours: vi.fn().mockReturnValue(false),
  nextSmsWindowStart: vi.fn().mockReturnValue(new Date()),
}));

vi.mock("./webhook-helpers", () => ({
  sendMessageWithRetry: (...a: any[]) => mockSendMessageWithRetry(...a),
  normalizeChannel: vi.fn((c: string) => c || "SMS"),
  extractFormData: vi.fn().mockReturnValue([]),
  parseFormDataFromMessageBody: vi.fn().mockReturnValue([]),
  extractContactFieldsFromFormData: vi.fn().mockReturnValue({}),
  isLlmExhausted: vi.fn().mockReturnValue(false),
  LLM_RETRY_DELAY_MS: 900000,
  MAX_LLM_RETRIES: 5,
  SALES_AGENTS: ["Abby Bouwer"],
  DESIGNER: "Designer",
  PRODUCTION_MANAGER: "Production Manager",
  STAGES: {},
  buildSendOpts: vi.fn().mockReturnValue({ type: "SMS", message: "test" }),
  ensureEmailSignature: vi.fn((msg: string) => msg),
  formatEmailHtml: vi.fn((msg: string) => msg),
  buildContextSubject: vi.fn().mockReturnValue("Re: Your Order"),
  sourceToChannel: vi.fn().mockReturnValue("SMS"),
  detectEventType: vi.fn().mockReturnValue("message"),
  normalizeWorkflowPayload: vi.fn((p: any) => p),
  resolveGhlContactId: vi.fn().mockResolvedValue(null),
  extractContactData: vi.fn().mockReturnValue({}),
}));

vi.mock("./brain-adapter", () => ({
  runBrainCouncil: (...a: any[]) => mockRunBrainCouncil(...a),
}));

vi.mock("./ai-brain", () => ({
  classifySegment: vi.fn().mockResolvedValue("new_lead"),
  shouldHandoffToAgent: vi.fn().mockResolvedValue({ handoff: false, reason: "", resumeAI: false }),
  estimateOrderValue: vi.fn().mockResolvedValue({ estimatedValue: 0, confidence: "low", reasoning: "" }),
  generateContactNotes: vi.fn().mockResolvedValue(""),
}));

vi.mock("./lead-researcher", () => ({
  researchLead: (...a: any[]) => mockResearchLead(...a),
}));

vi.mock("./agent-notifications", () => ({
  createHeadsUpNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./omnisend", () => ({
  pushContactToOmnisend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./webhook-pipeline", () => ({
  handleStageAutomation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./deferred-response-processor", () => ({
  shouldDeferResponse: vi.fn().mockReturnValue(false),
  getDeferredSendAt: vi.fn().mockReturnValue(new Date()),
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));

vi.mock("./channel-fallback", () => ({
  handleChannelDnc: vi.fn().mockResolvedValue({ action: "escalated", nextChannel: "Email" }),
  detectDncChannel: vi.fn().mockReturnValue("SMS"),
}));

vi.mock("./learning-loop", () => ({
  buildJourneyFromLead: vi.fn().mockResolvedValue(null),
  recordConversationOutcome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./fb-window-manager", () => ({
  isFbWindowOpen: vi.fn().mockReturnValue(true),
  isFbChannel: vi.fn().mockReturnValue(false),
}));

vi.mock("./lead-memory", () => ({
  getLeadMemory: vi.fn().mockResolvedValue(null),
  updateLeadMemoryAfterRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./auto-correction", () => ({
  detectConfusion: vi.fn().mockReturnValue(false),
  handleConfusionReply: vi.fn().mockResolvedValue(false),
  postSendValidation: vi.fn().mockResolvedValue(undefined),
  retroactiveCorrectionScan: vi.fn().mockResolvedValue(0),
  sendAutoCorrection: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("./outcome-engine", () => ({
  attributeReply: vi.fn().mockResolvedValue(null),
  attributeStageAdvance: vi.fn().mockResolvedValue(null),
  backfillOutcomes: vi.fn().mockResolvedValue(0),
}));

vi.mock("./missed-reply-scanner", () => ({
  runFastMissedReplyScanner: vi.fn().mockResolvedValue(0),
}));

vi.mock("./single-brain", () => ({
  runSingleBrain: vi.fn().mockResolvedValue({ blocked: true, blockReason: "test_mock" }),
}));

vi.mock("../shared/ghl-stages", () => ({
  getNqStageId: vi.fn().mockReturnValue("stage_nq"),
  NEW_LEAD_STAGE_IDS: [],
  CONTACTED_STAGE_IDS: [],
}));

// ─── Import under test ────────────────────────────────────────────────────
import { sendDelayedFirstContact, _setFirstContactDelay, detectPreliminaryChannel } from "./webhook-contact";

// ─── Helpers ───────────────────────────────────────────────────────────────
function makeLead(overrides: Record<string, any> = {}) {
  return {
    id: 200,
    name: "IG Test Lead",
    ghlContactId: "contact_ig_test",
    phone: "+15559876543",
    email: "ig_test@example.com",
    preferredChannel: "SMS",
    assignedAgent: "Abby Bouwer",
    humanTakeover: 0,
    pipelineStage: "new_lead",
    aiOffline: 0,
    lastAgentNote: null,
    lastAgentActivityAt: null,
    lastOutboundChannel: null,
    businessName: null,
    source: "ghl",
    ...overrides,
  };
}

// ─── Test Suite ────────────────────────────────────────────────────────────
describe("PR#3.11 — First-contact resilience: defensive crash fix + preliminary channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use fake timers set to 10am ET (14:00 UTC) — safely inside business hours
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T14:00:00.000Z"));
    // Set delay to 0 so we don't actually wait 45s
    _setFirstContactDelay(0);
    // Default mock returns — lead exists, no blockers
    mockGetLeadById.mockResolvedValue(makeLead());
    mockUpdateLeadFields.mockResolvedValue(undefined);
    mockFetchGhlConversationHistory.mockResolvedValue([]);
    mockCheckRateLimits.mockResolvedValue({ allowed: true });
    mockCheckLeadRateLimit.mockResolvedValue(true);
    mockGetRecentAiOutboundCount.mockResolvedValue(0);
    mockGetConversationHistory.mockResolvedValue([]);
    mockCheckDnc.mockReturnValue(false);
    mockRunBrainCouncil.mockResolvedValue({
      blocked: false,
      finalMessage: "Hey! Thanks for reaching out about custom printing!",
      channel: "SMS",
    });
    mockSendMessageWithRetry.mockResolvedValue({
      success: true,
      resolvedContactId: "contact_ig_test",
    });
    mockResearchLead.mockResolvedValue(undefined);
    mockCalculateNextFollowUp.mockResolvedValue({
      nextFollowUpAt: new Date(),
      cadencePosition: 0,
      reason: "test",
      channel: "SMS",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Test 1: GHL history fetch throws → Brain Council still runs ────────
  it("continues when fetchGhlConversationHistory throws, Brain Council still runs", async () => {
    const consoleSpy = vi.spyOn(console, "error");

    // First call (line 320, inside existing try/catch) — not relevant here
    // Second call (line 427, the one we wrapped) — THROWS
    mockFetchGhlConversationHistory.mockRejectedValue(
      new Error("GHL API 500: Internal Server Error")
    );

    await sendDelayedFirstContact(
      200,
      makeLead(),
      { trigger: "new_contact", source: "instagram" },
      "contact_ig_test",
    );

    // The PR#3.11 error log should have fired
    const pr311Log = consoleSpy.mock.calls.find(
      (c: any[]) =>
        typeof c[0] === "string" &&
        c[0].includes("PR#3.11") &&
        c[0].includes("GHL history fetch failed") &&
        c[0].includes("non-fatal"),
    );
    expect(pr311Log).toBeDefined();

    // Brain Council should STILL have been called (function continued with empty history)
    expect(mockRunBrainCouncil).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // ─── Test 2: Empty GHL history → channel detection still works for IG ───
  it("detects IG channel via payload source when GHL history is empty", async () => {
    // GHL returns empty array (either from the try/catch or genuinely empty)
    mockFetchGhlConversationHistory.mockResolvedValue([]);

    await sendDelayedFirstContact(
      200,
      makeLead({ source: "instagram" }),
      { trigger: "new_contact", source: "instagram" },
      "contact_ig_test",
    );

    // Brain Council should have been called
    expect(mockRunBrainCouncil).toHaveBeenCalled();

    // The Brain Council call should have received IG as the channel
    // (via Layer 3 or Layer 4 of the 8-layer detection: payload.source or lead.source)
    const bcCall = mockRunBrainCouncil.mock.calls[0];
    // Brain Council input is the first argument — check the channel passed
    // The channel is set after detection and passed to runBrainCouncil
    // We verify by checking that updateLeadFields was called with preferredChannel=IG
    const channelUpdates = mockUpdateLeadFields.mock.calls.filter(
      (c: any[]) => c[1]?.preferredChannel === "IG",
    );
    expect(channelUpdates.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Test 3: detectPreliminaryChannel returns "IG" for source=instagram ─
  it('detectPreliminaryChannel returns "IG" for payload.source = "instagram"', () => {
    const result = detectPreliminaryChannel(
      { source: "instagram" },
      { source: "ghl", phone: "+15551234567", email: null },
    );
    expect(result).toBe("IG");
  });

  // ─── Test 4: detectPreliminaryChannel returns "FB" for attribution ──────
  it('detectPreliminaryChannel returns "FB" for attributionSource.medium = "facebook"', () => {
    const result = detectPreliminaryChannel(
      {
        source: "ghl",
        contact: {
          attributionSource: { medium: "facebook" },
        },
      },
      { source: "ghl", phone: "+15551234567", email: null },
    );
    expect(result).toBe("FB");
  });

  // ─── Test 5: detectPreliminaryChannel returns null for ambiguous ────────
  it("detectPreliminaryChannel returns null for ambiguous payloads (no social signal)", () => {
    // Payload with source="ghl" and no social indicators
    const result1 = detectPreliminaryChannel(
      { source: "ghl" },
      { source: "ghl", phone: "+15551234567", email: "test@example.com" },
    );
    expect(result1).toBeNull();

    // Empty payload
    const result2 = detectPreliminaryChannel(
      {},
      { source: null, phone: "+15551234567", email: null },
    );
    expect(result2).toBeNull();

    // Payload with only SMS/Email signals (no social)
    const result3 = detectPreliminaryChannel(
      { type: "2", source: "direct" },
      { source: "website", phone: "+15551234567", email: "test@example.com" },
    );
    expect(result3).toBeNull();
  });
});
