/**
 * PR#3.10 Tests: userId filter in first-contact delay window
 *
 * Verifies that sendDelayedFirstContact correctly distinguishes between:
 * - GHL workflow/automation messages (no userId) → should NOT trigger humanTakeover
 * - Human agent messages (with userId) → should trigger humanTakeover
 *
 * Bug context: Gabriela received a GHL workflow message ("WAIT! You're not done yet...")
 * during the 45s first-contact delay window. The old code had `return true` for all
 * outbound messages without userId, misclassifying the workflow message as human agent
 * activity, setting humanTakeover=1 and blocking AI first-contact.
 *
 * The fix (line 344): `return Boolean(m.userId || (m as any).user?.id)`
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
import { sendDelayedFirstContact, _setFirstContactDelay } from "./webhook-contact";

// ─── Helpers ───────────────────────────────────────────────────────────────
function makeLead(overrides: Record<string, any> = {}) {
  return {
    id: 100,
    name: "Gabriela Test",
    ghlContactId: "contact_gabriela_test",
    phone: "+15551234567",
    email: "gabriela@test.com",
    preferredChannel: "SMS",
    assignedAgent: "Abby Bouwer",
    humanTakeover: 0,
    pipelineStage: "new_lead",
    aiOffline: 0,
    lastAgentNote: null,
    lastAgentActivityAt: null,
    lastOutboundChannel: null,
    businessName: null,
    source: "facebook",
    ...overrides,
  };
}

/**
 * Build a GHL conversation history message.
 * @param ageMs How many ms ago the message was sent (relative to "now" in fake time)
 * @param opts Override fields — userId, body, direction, etc.
 */
function makeGhlMsg(ageMs: number, opts: Record<string, any> = {}) {
  // "now" is 2026-05-19T14:00:00.000Z (set by vi.setSystemTime)
  const now = new Date("2026-05-19T14:00:00.000Z").getTime();
  return {
    direction: "outbound",
    body: opts.body ?? "Hey! Just wanted to follow up on your order.",
    dateAdded: new Date(now - ageMs).toISOString(),
    userId: opts.userId ?? undefined,
    ...opts,
  };
}

// ─── Test Suite ────────────────────────────────────────────────────────────
describe("PR#3.10 — userId filter in first-contact delay window", () => {
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
      finalMessage: "Hi Gabriela! Thanks for your interest in custom tees!",
      channel: "SMS",
    });
    mockSendMessageWithRetry.mockResolvedValue({
      success: true,
      resolvedContactId: "contact_gabriela_test",
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

  // ─── Test 1: Workflow message (no userId) → AI proceeds ─────────────────
  it("allows first-contact when GHL history has workflow message without userId", async () => {
    // GHL returns 1 outbound message WITHOUT userId during delay window (10s ago)
    mockFetchGhlConversationHistory.mockResolvedValue([
      makeGhlMsg(10_000, {
        body: "WAIT! You're not done yet... Check out our latest deals!",
        userId: undefined,
      }),
    ]);

    await sendDelayedFirstContact(
      100,
      makeLead(),
      { trigger: "new_contact" },
      "contact_gabriela_test",
    );

    // humanTakeover should NOT have been set to 1 by the GHL history check
    // (the only updateLeadFields(100, { humanTakeover: 1, ... }) call would be from the filter)
    const htCalls = mockUpdateLeadFields.mock.calls.filter(
      (c: any[]) => c[0] === 100 && c[1]?.humanTakeover === 1,
    );
    expect(htCalls.length).toBe(0);

    // Brain council should have been called (AI proceeds with first-contact)
    expect(mockRunBrainCouncil).toHaveBeenCalled();
  });

  // ─── Test 2: Human agent message (with userId) → humanTakeover ──────────
  it("sets humanTakeover when GHL history has message WITH userId", async () => {
    // GHL returns 1 outbound message WITH userId during delay window (10s ago)
    mockFetchGhlConversationHistory.mockResolvedValue([
      makeGhlMsg(10_000, {
        body: "Hi Gabriela, this is Abby! Let me help you with your order.",
        userId: "user_abby_123",
      }),
    ]);

    await sendDelayedFirstContact(
      100,
      makeLead(),
      { trigger: "new_contact" },
      "contact_gabriela_test",
    );

    // humanTakeover should have been set to 1
    const htCalls = mockUpdateLeadFields.mock.calls.filter(
      (c: any[]) => c[0] === 100 && c[1]?.humanTakeover === 1,
    );
    expect(htCalls.length).toBe(1);

    // Brain council should NOT have been called (agent took over)
    expect(mockRunBrainCouncil).not.toHaveBeenCalled();
  });

  // ─── Test 3: Both workflow + human messages → humanTakeover ─────────────
  it("sets humanTakeover when mix of workflow and human messages (userId one counts)", async () => {
    // GHL returns 2 messages: 1 workflow (no userId) + 1 human (with userId)
    mockFetchGhlConversationHistory.mockResolvedValue([
      makeGhlMsg(20_000, {
        body: "WAIT! You're not done yet... Check out our latest deals!",
        userId: undefined,
      }),
      makeGhlMsg(10_000, {
        body: "Hey Gabriela, Abby here. I saw your inquiry!",
        userId: "user_abby_123",
      }),
    ]);

    await sendDelayedFirstContact(
      100,
      makeLead(),
      { trigger: "new_contact" },
      "contact_gabriela_test",
    );

    // humanTakeover should be set because the userId message counts
    const htCalls = mockUpdateLeadFields.mock.calls.filter(
      (c: any[]) => c[0] === 100 && c[1]?.humanTakeover === 1,
    );
    expect(htCalls.length).toBe(1);

    // Brain council should NOT have been called
    expect(mockRunBrainCouncil).not.toHaveBeenCalled();
  });

  // ─── Test 4: Workflow message outside delay window → AI proceeds ────────
  it("ignores outbound messages older than DELAY_WINDOW_MS", async () => {
    // DELAY_WINDOW_MS = FIRST_CONTACT_DELAY_MS + 30_000
    // With _setFirstContactDelay(0), DELAY_WINDOW_MS = 0 + 30_000 = 30s
    // Message is 60s old — outside the 30s window
    mockFetchGhlConversationHistory.mockResolvedValue([
      makeGhlMsg(60_000, {
        body: "Hi Gabriela, this is Abby! Let me help you with your order.",
        userId: "user_abby_123",
      }),
    ]);

    await sendDelayedFirstContact(
      100,
      makeLead(),
      { trigger: "new_contact" },
      "contact_gabriela_test",
    );

    // humanTakeover should NOT be set — message is too old
    const htCalls = mockUpdateLeadFields.mock.calls.filter(
      (c: any[]) => c[0] === 100 && c[1]?.humanTakeover === 1,
    );
    expect(htCalls.length).toBe(0);

    // Brain council should have been called (AI proceeds)
    expect(mockRunBrainCouncil).toHaveBeenCalled();
  });

  // ─── Test 5: Diagnostic log fires when workflow message ignored ─────────
  it("fires diagnostic log when non-userId outbound messages are ignored", async () => {
    const consoleSpy = vi.spyOn(console, "log");

    // GHL returns 1 workflow message (no userId) during delay window
    mockFetchGhlConversationHistory.mockResolvedValue([
      makeGhlMsg(10_000, {
        body: "WAIT! You're not done yet... Check out our latest deals!",
        userId: undefined,
      }),
    ]);

    await sendDelayedFirstContact(
      100,
      makeLead(),
      { trigger: "new_contact" },
      "contact_gabriela_test",
    );

    // The diagnostic log should have fired
    const diagLog = consoleSpy.mock.calls.find(
      (c: any[]) =>
        typeof c[0] === "string" &&
        c[0].includes("PR#3.10") &&
        c[0].includes("Ignored") &&
        c[0].includes("non-user GHL outbound"),
    );
    expect(diagLog).toBeDefined();

    // Verify the log mentions the correct count
    expect(diagLog![0]).toContain("1 non-user GHL outbound message");

    consoleSpy.mockRestore();
  });
});
