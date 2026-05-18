import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock variables (required for vi.mock factories to reference them) ─
const {
  mockIsAiOffline,
  mockGetLeadById,
  mockGetConversationHistory,
  mockGetRecentAiOutboundCount,
  mockGetLeadsDueForFollowUp,
  mockAddConversation,
  mockUpdateLeadFields,
  mockGetDb,
  mockDbExecute,
  mockDbInsert,
  mockDbSelect,
  mockSendMessageWithRetry,
  mockRunSingleBrain,
} = vi.hoisted(() => ({
  mockIsAiOffline: vi.fn(),
  mockGetLeadById: vi.fn(),
  mockGetConversationHistory: vi.fn(),
  mockGetRecentAiOutboundCount: vi.fn(),
  mockGetLeadsDueForFollowUp: vi.fn(),
  mockAddConversation: vi.fn(),
  mockUpdateLeadFields: vi.fn(),
  mockGetDb: vi.fn(),
  mockDbExecute: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbSelect: vi.fn(),
  mockSendMessageWithRetry: vi.fn(),
  mockRunSingleBrain: vi.fn(),
}));

const mockDb = {
  execute: (...a: any[]) => mockDbExecute(...a),
  insert: (...a: any[]) => mockDbInsert(...a),
  select: (...a: any[]) => mockDbSelect(...a),
  update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
};

vi.mock("./db", () => ({
  getDb: (...a: any[]) => mockGetDb(...a),
  isAiOffline: (...a: any[]) => mockIsAiOffline(...a),
  getLeadById: (...a: any[]) => mockGetLeadById(...a),
  updateLeadFields: (...a: any[]) => mockUpdateLeadFields(...a),
  addConversation: (...a: any[]) => mockAddConversation(...a),
  getConversationHistory: (...a: any[]) => mockGetConversationHistory(...a),
  getRecentAiOutboundCount: (...a: any[]) => mockGetRecentAiOutboundCount(...a),
  getLeadsDueForFollowUp: (...a: any[]) => mockGetLeadsDueForFollowUp(...a),
  upsertAiState: vi.fn().mockResolvedValue(undefined),
  addBrainCouncilAudit: vi.fn().mockResolvedValue(undefined),
  getBrainCouncilAuditForLead: vi.fn().mockResolvedValue([]),
  acquireDbBrainCouncilLock: vi.fn().mockResolvedValue(true),
  releaseDbBrainCouncilLock: vi.fn().mockResolvedValue(undefined),
  getAiState: vi.fn().mockResolvedValue(null),
  getLeadByGhlContactId: vi.fn().mockResolvedValue(null),
  addPipelineEvent: vi.fn().mockResolvedValue(undefined),
  addAgentAssignment: vi.fn().mockResolvedValue(undefined),
  getAgentWorkload: vi.fn().mockResolvedValue([]),
  getSystemSetting: vi.fn().mockResolvedValue(null),
  setSystemSetting: vi.fn().mockResolvedValue(undefined),
  isChannelDnd: vi.fn().mockResolvedValue(false),
  getBlockedChannels: vi.fn().mockResolvedValue([]),
  getBestChannelForLead: vi.fn().mockResolvedValue(null),
  getLastEmailThreadId: vi.fn().mockResolvedValue(null),
  getLastEmailThreadInfo: vi.fn().mockResolvedValue(null),
  findExistingLeadByIdentity: vi.fn().mockResolvedValue(null),
  syncGhlDnd: vi.fn().mockResolvedValue(undefined),
  insertDeferredResponse: vi.fn().mockResolvedValue(undefined),
  hasPendingDeferredResponse: vi.fn().mockResolvedValue(false),
  upsertLead: vi.fn().mockResolvedValue({ id: 1 }),
  getUncorrectedViolations: vi.fn().mockResolvedValue([]),
  updateAuditCorrection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./ghl", () => ({
  sendMessage: vi.fn().mockResolvedValue({ messageId: "msg_test" }),
  createTask: vi.fn().mockResolvedValue({}),
  addNote: vi.fn().mockResolvedValue({}),
  fetchGhlConversationHistory: vi.fn().mockResolvedValue([]),
  getContact: vi.fn().mockResolvedValue(null),
  searchContacts: vi.fn().mockResolvedValue([]),
  updateContactCustomField: vi.fn().mockResolvedValue({}),
  updateOpportunityValue: vi.fn().mockResolvedValue({}),
  updateOpportunityStage: vi.fn().mockResolvedValue({}),
  updateContactAssignment: vi.fn().mockResolvedValue({}),
  AGENT_GHL_USER_IDS: {},
}));

vi.mock("./webhook-helpers", () => ({
  sendMessageWithRetry: (...a: any[]) => mockSendMessageWithRetry(...a),
  normalizeChannel: vi.fn((c: string) => c || "SMS"),
  extractFormData: vi.fn().mockReturnValue([]),
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

vi.mock("./single-brain", () => ({
  runSingleBrain: (...a: any[]) => mockRunSingleBrain(...a),
}));
vi.mock("./brain-adapter", () => ({
  runBrainCouncil: vi.fn().mockResolvedValue({ blocked: true, blockReason: "test_mock" }),
}));
vi.mock("./scheduling-engine", () => ({
  calculateNextFollowUp: vi.fn().mockResolvedValue({ nextFollowUpAt: new Date(), cadencePosition: 0, reason: "test", channel: "SMS" }),
  checkRateLimits: vi.fn().mockResolvedValue({ allowed: true }),
  capDate: vi.fn((d: Date) => d),
  checkDnc: vi.fn().mockReturnValue(false),
  DNC_KEYWORDS: [],
}));
vi.mock("./_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));
vi.mock("./learning-loop", () => ({
  buildJourneyFromLead: vi.fn().mockResolvedValue(null),
  recordConversationOutcome: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./channel-fallback", () => ({
  handleChannelDnc: vi.fn().mockResolvedValue({ action: "escalated", nextChannel: "Email" }),
  detectDncChannel: vi.fn().mockReturnValue("SMS"),
}));
vi.mock("./ai-brain", () => ({
  shouldHandoffToAgent: vi.fn().mockResolvedValue({ handoff: false, reason: "", resumeAI: false }),
  estimateOrderValue: vi.fn().mockResolvedValue({ estimatedValue: 0, confidence: "low", reasoning: "" }),
  generateContactNotes: vi.fn().mockResolvedValue(""),
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
vi.mock("./omnisend", () => ({
  pushContactToOmnisend: vi.fn().mockResolvedValue({}),
}));
vi.mock("./lookback-engine", () => ({
  runLookback: vi.fn().mockResolvedValue({ processed: 0, engage: 0, skip: 0, caution: 0, humanNeeded: 0, errors: 0 }),
}));
vi.mock("./brain-council-review", () => ({
  runBrainCouncilSelfReview: vi.fn().mockResolvedValue({ reviewed: 0, recovered: 0, skipped: 0, errors: 0 }),
  runFastMissedReplyScanner: vi.fn().mockResolvedValue(0),
}));

// Imports — after all vi.mock() calls
import { processOutboxRow } from "./outbox-worker";
import { processOverdueFollowUps } from "./follow-up-trigger";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeLead(overrides: Record<string, any> = {}) {
  return {
    id: 42,
    name: "Test Lead",
    ghlContactId: "contact_test_123",
    phone: "+15551234567",
    email: "test@example.com",
    preferredChannel: "SMS",
    assignedAgent: "Abby Bouwer",
    humanTakeover: 0,
    pipelineStage: "new_lead",
    aiOffline: 0,
    ...overrides,
  };
}

function makeOutboxRow(payloadOverrides: Record<string, any> = {}, rowOverrides: Record<string, any> = {}) {
  return {
    id: 1,
    leadId: 42,
    source: "follow_up" as const,
    outbox_status: "claimed" as const,
    retryCount: 0,
    payload: JSON.stringify({
      trigger: "follow_up",
      channelHint: "SMS",
      ...payloadOverrides,
    }),
    scheduledAt: new Date(),
    createdAt: new Date(),
    ...rowOverrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────
describe("PR#3.9 — Conversations Write + lastMessageAt + Dedup", () => {
  beforeEach(() => {
    // Pin system time to 10am ET (14:00 UTC) so TCPA quiet-hours guard (8pm-8am ET) passes
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T14:00:00.000Z"));
    vi.clearAllMocks();
    mockIsAiOffline.mockResolvedValue(false);
    mockGetConversationHistory.mockResolvedValue([]);
    mockGetRecentAiOutboundCount.mockResolvedValue(0);
    mockAddConversation.mockResolvedValue({ id: 999 });
    mockUpdateLeadFields.mockResolvedValue(undefined);
    mockSendMessageWithRetry.mockResolvedValue({ success: true, resolvedContactId: "contact_test_123" });
    mockGetDb.mockResolvedValue(mockDb);
    mockDbExecute.mockResolvedValue([[]]);
    mockDbInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ abTrafficPercent: 100 }]) }),
          limit: vi.fn().mockResolvedValue([{ abTrafficPercent: 100 }]),
        }),
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Test 1: Path A (pre-composed draft) ────────────────────────────────────
  it("Path A: addConversation is called with correct args after successful draft send", async () => {
    mockGetLeadById.mockResolvedValue(makeLead());
    const row = makeOutboxRow({ draftMessage: "Hey! Ready to order your church shirts?" });
    await processOutboxRow(row as any);
    expect(mockAddConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: 42,
        direction: "outbound",
        senderType: "ai",
        messageBody: "Hey! Ready to order your church shirts?",
      })
    );
    expect(mockUpdateLeadFields).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ lastMessageAt: expect.any(Date) })
    );
  });

  // ── Test 2: Path B Single Brain ────────────────────────────────────────────
  it("Path B Single Brain: addConversation is called with brain message + lastMessageAt updated", async () => {
    mockGetLeadById.mockResolvedValue(makeLead());
    mockRunSingleBrain.mockResolvedValue({
      decision: {
        action: "send",
        message: "Hi! Following up on your bulk tee order.",
        channel: "SMS",
        nextFollowUpHours: 24,
        confidence: 90,
        subject: null,
        routeToHuman: false,
        pipelineAction: null,
      },
      guardResult: { passed: true, action: "pass", reason: null, correctedDecision: null },
      model: "gpt-4o",
      promptVersion: "v3.0",
      llmCalls: 2,
      durationMs: 1200,
      toolLog: [],
    });
    const row = makeOutboxRow();
    await processOutboxRow(row as any);
    expect(mockAddConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: 42,
        direction: "outbound",
        senderType: "ai",
        messageBody: "Hi! Following up on your bulk tee order.",
      })
    );
    expect(mockUpdateLeadFields).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ lastMessageAt: expect.any(Date) })
    );
  });

  // ── Test 3: nextFollowUpHours floor (1h → clamped to 4h) ──────────────────
  it("nextFollowUpHours floor: brain suggests 1h => clamped to 4h (MIN_NEXT_FOLLOW_UP_HOURS)", async () => {
    mockGetLeadById.mockResolvedValue(makeLead());
    mockRunSingleBrain.mockResolvedValue({
      decision: {
        action: "send",
        message: "Quick follow-up!",
        channel: "SMS",
        nextFollowUpHours: 1,
        confidence: 80,
        subject: null,
        routeToHuman: false,
        pipelineAction: null,
      },
      guardResult: { passed: true, action: "pass", reason: null, correctedDecision: null },
      model: "gpt-4o",
      promptVersion: "v3.0",
      llmCalls: 1,
      durationMs: 800,
      toolLog: [],
    });
    const row = makeOutboxRow();
    const before = Date.now();
    await processOutboxRow(row as any);
    const calls = mockUpdateLeadFields.mock.calls;
    const nextFollowUpCall = calls.find((call: any[]) => call[1]?.nextFollowUpAt instanceof Date);
    expect(nextFollowUpCall).toBeDefined();
    const nextAt = (nextFollowUpCall as any)[1].nextFollowUpAt as Date;
    const minExpected = before + 4 * 60 * 60 * 1000;
    expect(nextAt.getTime()).toBeGreaterThanOrEqual(minExpected - 100);
  });

  // ── Test 4: nextFollowUpHours floor (24h → NOT clamped) ───────────────────
  it("nextFollowUpHours floor: brain suggests 24h => NOT clamped (value respected)", async () => {
    mockGetLeadById.mockResolvedValue(makeLead());
    mockRunSingleBrain.mockResolvedValue({
      decision: {
        action: "send",
        message: "Check back tomorrow!",
        channel: "SMS",
        nextFollowUpHours: 24,
        confidence: 85,
        subject: null,
        routeToHuman: false,
        pipelineAction: null,
      },
      guardResult: { passed: true, action: "pass", reason: null, correctedDecision: null },
      model: "gpt-4o",
      promptVersion: "v3.0",
      llmCalls: 2,
      durationMs: 1000,
      toolLog: [],
    });
    const row = makeOutboxRow();
    const before = Date.now();
    await processOutboxRow(row as any);
    const calls = mockUpdateLeadFields.mock.calls;
    const nextFollowUpCall = calls.find((call: any[]) => call[1]?.nextFollowUpAt instanceof Date);
    expect(nextFollowUpCall).toBeDefined();
    const nextAt = (nextFollowUpCall as any)[1].nextFollowUpAt as Date;
    const expected24h = before + 24 * 60 * 60 * 1000;
    expect(nextAt.getTime()).toBeGreaterThanOrEqual(expected24h - 1000);
    expect(nextAt.getTime()).toBeLessThanOrEqual(expected24h + 5000);
  });

  // ── Test 5: Follow-up trigger dedup window = 240 minutes ──────────────────
  it("Follow-up trigger dedup: getRecentAiOutboundCount called with 240 minutes (4h window)", async () => {
    const mockLead = {
      id: 99,
      name: "Dedup Test Lead",
      ghlContactId: "cont_dedup",
      phone: "+15559998888",
      email: "dedup@example.com",
      preferredChannel: "SMS",
      assignedAgent: "Abby Bouwer",
      humanTakeover: 0,
      pipelineStage: "new_lead",
      aiOffline: 0,
      nextFollowUpAt: new Date(Date.now() - 60000), // overdue by 1 min
    };
    mockGetLeadsDueForFollowUp.mockResolvedValue([mockLead]);
    mockGetRecentAiOutboundCount.mockResolvedValue(1); // AI sent recently → should skip
    mockGetConversationHistory.mockResolvedValue([]);

    await processOverdueFollowUps();

    expect(mockGetRecentAiOutboundCount).toHaveBeenCalledWith(99, 240);
  });
});
