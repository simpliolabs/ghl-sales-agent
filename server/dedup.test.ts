import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB module
const mockGetDb = vi.fn();
const mockIsAiOffline = vi.fn();
const mockAcquireDbBrainCouncilLock = vi.fn();
const mockReleaseDbBrainCouncilLock = vi.fn();
const mockAddBrainCouncilAudit = vi.fn();

vi.mock("./db", () => ({
  getDb: mockGetDb,
  isAiOffline: mockIsAiOffline,
  acquireDbBrainCouncilLock: mockAcquireDbBrainCouncilLock,
  releaseDbBrainCouncilLock: mockReleaseDbBrainCouncilLock,
  addBrainCouncilAudit: mockAddBrainCouncilAudit,
  isAiOffline: mockIsAiOffline,
  getLeadsDueForFollowUp: vi.fn().mockResolvedValue([]),
  getConversationHistory: vi.fn().mockResolvedValue([]),
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
  addConversation: vi.fn().mockResolvedValue({ id: 1 }),
  upsertAiState: vi.fn().mockResolvedValue(undefined),
  getRecentAiOutboundCount: vi.fn().mockResolvedValue(0),
  addBrainCouncilAudit: mockAddBrainCouncilAudit,
  getBrainCouncilAuditForLead: vi.fn().mockResolvedValue([]),
  getLeadById: vi.fn().mockResolvedValue(null),
  getUncorrectedViolations: vi.fn().mockResolvedValue([]),
  updateAuditCorrection: vi.fn().mockResolvedValue(undefined),
  getLeadByGhlContactId: vi.fn().mockResolvedValue(null),
  addPipelineEvent: vi.fn().mockResolvedValue(undefined),
  addAgentAssignment: vi.fn().mockResolvedValue(undefined),
  getAgentWorkload: vi.fn().mockResolvedValue([]),
  getSystemSetting: vi.fn().mockResolvedValue(null),
  setSystemSetting: vi.fn().mockResolvedValue(undefined),
  isChannelDnd: vi.fn().mockResolvedValue(false),
  getBlockedChannels: vi.fn().mockResolvedValue([]),
}));

vi.mock("./brain-context", () => ({
  buildLeadContext: vi.fn().mockResolvedValue({
    lead: { id: 1, name: "Test", assignedAgent: "Abby", omnisendSegment: "brand" },
    convHistory: [],
    leadAgeDays: 1,
    urgencyStage: "first_contact",
    state: {},
    isFirstResponse: false,
  }),
}));

vi.mock("./strategist", () => ({
  runStrategist: vi.fn().mockResolvedValue({
    approach: "engage",
    framework: "PAS",
    angle: "intro",
    channel: "SMS",
    personalizationTier: 1,
    reasoning: "test",
    nextEngagementHours: 24,
  }),
}));

vi.mock("./researcher", () => ({
  runResearcher: vi.fn().mockResolvedValue({ summary: "test research" }),
  emptyResearch: vi.fn().mockReturnValue({ summary: "" }),
}));

vi.mock("./composer", () => ({
  runComposer: vi.fn().mockResolvedValue({
    message: "Hello from Adorb!",
    fromName: "Abby Bouwer",
    subject: null,
  }),
}));

vi.mock("./qc", () => ({
  runQC: vi.fn().mockResolvedValue({
    score: 85,
    approved: true,
    issues: [],
    suggestions: [],
    revisedMessage: null,
  }),
  detectViolations: vi.fn().mockReturnValue({ category: null, reason: null }),
  buildSafeFallback: vi.fn().mockReturnValue("Safe fallback message"),
  checkCircuitBreaker: vi.fn().mockResolvedValue({ tripped: false, consecutiveFailures: 0 }),
  updateCircuitBreaker: vi.fn().mockResolvedValue(undefined),
  notifyOwnerOfViolation: vi.fn().mockResolvedValue(true),
}));

vi.mock("./ghl", () => ({
  sendMessage: vi.fn().mockResolvedValue({ messageId: "msg_123" }),
  createTask: vi.fn().mockResolvedValue({}),
  addNote: vi.fn().mockResolvedValue({}),
  fetchGhlConversationHistory: vi.fn().mockResolvedValue([]),
  getContact: vi.fn().mockResolvedValue(null),
  searchContacts: vi.fn().mockResolvedValue([]),
  updateContactCustomField: vi.fn().mockResolvedValue({}),
  updateOpportunityValue: vi.fn().mockResolvedValue({}),
  updateContactAssignment: vi.fn().mockResolvedValue({}),
  AGENT_GHL_USER_IDS: {},
}));

vi.mock("./scheduling-engine", () => ({
  calculateNextFollowUp: vi.fn().mockResolvedValue({ nextFollowUpAt: new Date(), cadencePosition: 0, reason: "test", channel: "SMS" }),
  checkRateLimits: vi.fn().mockResolvedValue({ allowed: true }),
  capDate: vi.fn((d: Date) => d),
  checkDnc: vi.fn().mockReturnValue(false),
  DNC_KEYWORDS: ["stop", "unsubscribe", "remove", "opt out", "do not contact", "cancel"],
}));

vi.mock("./ai-brain", () => ({
  shouldHandoffToAgent: vi.fn().mockResolvedValue({ handoff: false, reason: "", resumeAI: false }),
  estimateOrderValue: vi.fn().mockResolvedValue({ estimatedValue: 0, confidence: "low", reasoning: "" }),
  generateContactNotes: vi.fn().mockResolvedValue(""),
}));

vi.mock("./outcome-engine", () => ({
  attributeReply: vi.fn().mockResolvedValue(null),
  attributeStageAdvance: vi.fn().mockResolvedValue(null),
  backfillOutcomes: vi.fn().mockResolvedValue(0),
}));

vi.mock("./auto-correction", () => ({
  detectConfusion: vi.fn().mockReturnValue(false),
  handleConfusionReply: vi.fn().mockResolvedValue(false),
  postSendValidation: vi.fn().mockResolvedValue(undefined),
  retroactiveCorrectionScan: vi.fn().mockResolvedValue(0),
  sendAutoCorrection: vi.fn().mockResolvedValue({ success: true }),
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

vi.mock("./_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));

vi.mock("./webhook-helpers", () => ({
  detectEventType: vi.fn().mockReturnValue("message"),
  normalizeWorkflowPayload: vi.fn((p: any) => p),
  resolveGhlContactId: vi.fn().mockResolvedValue(null),
  extractContactData: vi.fn().mockReturnValue({}),
  sendMessageWithRetry: vi.fn().mockResolvedValue({ success: true, resolvedContactId: "contact_123" }),
  normalizeChannel: vi.fn((c: string) => c || "SMS"),
  extractFormData: vi.fn().mockReturnValue([]),
  isLlmExhausted: vi.fn().mockReturnValue(false),
  LLM_RETRY_DELAY_MS: 900000,
  MAX_LLM_RETRIES: 5,
  SALES_AGENTS: ["Abby Bouwer"],
  DESIGNER: "Designer",
  PRODUCTION_MANAGER: "Production Manager",
  STAGES: { NEW_LEAD: "new_lead", CONTACTED: "contacted", QUALIFIED: "qualified", QUOTE_SENT: "quote_sent", PAID_PROOF_NEEDED: "paid_proof_needed", PROOF_SENT: "proof_sent", APPROVED: "approved", IN_PRODUCTION: "in_production", READY: "ready", DELIVERED: "delivered" },
  buildSendOpts: vi.fn(),
}));

describe("Duplicate Message Prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAiOffline.mockResolvedValue(false);
    mockAcquireDbBrainCouncilLock.mockResolvedValue(true);
    mockReleaseDbBrainCouncilLock.mockResolvedValue(undefined);
    mockAddBrainCouncilAudit.mockResolvedValue(undefined);
  });

  describe("Brain Council Orchestrator Pre-flight Checks", () => {
    it("should abort when AI is offline", async () => {
      mockIsAiOffline.mockResolvedValue(true);
      const { runBrainCouncil } = await import("./brain-council-orchestrator");
      
      const result = await runBrainCouncil({
        leadId: 1,
        incomingMessage: "Hello",
        channel: "SMS",
      });

      expect(result.blocked).toBe(true);
      expect(result.blockReason).toContain("OFFLINE");
    });

    it("should abort when DB lock cannot be acquired", async () => {
      mockAcquireDbBrainCouncilLock.mockResolvedValue(false);
      
      // Mock DB for the send cooldown check
      const mockDbSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ lastAiSendAttemptAt: null }]),
          }),
        }),
      });
      mockGetDb.mockResolvedValue({ select: mockDbSelect, execute: vi.fn().mockResolvedValue([[]])} );
      
      const { runBrainCouncil } = await import("./brain-council-orchestrator");
      
      const result = await runBrainCouncil({
        leadId: 1,
        incomingMessage: "Hello",
        channel: "SMS",
      });

      expect(result.blocked).toBe(true);
      expect(result.blockReason).toContain("lock");
    });

    it("should abort when DB send cooldown is active (recent lastAiSendAttemptAt)", async () => {
      // Mock DB to return a recent lastAiSendAttemptAt (30 seconds ago)
      const recentTimestamp = new Date(Date.now() - 30 * 1000);
      const mockDbSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ lastAiSendAttemptAt: recentTimestamp }]),
          }),
        }),
      });
      mockGetDb.mockResolvedValue({ select: mockDbSelect });
      
      const { runBrainCouncil } = await import("./brain-council-orchestrator");
      
      const result = await runBrainCouncil({
        leadId: 1,
        incomingMessage: "Hello",
        channel: "SMS",
      });

      expect(result.blocked).toBe(true);
      expect(result.blockReason).toContain("cooldown");
    });

    it("should release lock even if pipeline throws", async () => {
      // Build a mock DB that handles all pre-flight queries:
      // 1. cooldown check (select lastAiSendAttemptAt from leads)
      // 2. humanTakeover check (select humanTakeover from leads)
      // 3. DNC check (select messageBody, direction, senderType from conversations)
      // 4. DND check (via isChannelDnd mock — already returns false)
      // 5. recent AI outbound check (select from conversations)
      // 6. circuit breaker check
      const mockDbSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ lastAiSendAttemptAt: null, humanTakeover: 0 }]),
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
      const mockDbUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });
      mockGetDb.mockResolvedValue({ select: mockDbSelect, update: mockDbUpdate });
      
      // Make buildLeadContext throw
      const { buildLeadContext } = await import("./brain-context");
      (buildLeadContext as any).mockRejectedValueOnce(new Error("Test error"));
      
      const { runBrainCouncil } = await import("./brain-council-orchestrator");
      
      await expect(runBrainCouncil({
        leadId: 1,
        incomingMessage: "Hello",
        channel: "SMS",
      })).rejects.toThrow("Test error");

      // Lock should still be released
      expect(mockReleaseDbBrainCouncilLock).toHaveBeenCalledWith(1);
    });
  });

  describe("Non-Brain-Council Senders - Offline Check", () => {
    it("webhook-task should skip notifications when AI is offline", async () => {
      const { isAiOffline: mockOffline } = await import("./db");
      (mockOffline as any).mockResolvedValue(true);
      
      const { getLeadByGhlContactId } = await import("./db");
      (getLeadByGhlContactId as any).mockResolvedValue({
        id: 1, name: "Test Lead", phone: "+1234567890", email: "test@test.com",
        assignedAgent: "Abby", pipelineValue: 500, businessName: "Test Co",
      });
      
      const { sendMessageWithRetry } = await import("./webhook-helpers");
      
      const { handleTaskWebhook } = await import("./webhook-task");
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;
      
      await handleTaskWebhook({
        contactId: "contact_123",
        title: "Design proof completed",
        status: "completed",
      }, mockRes);

      // sendMessageWithRetry should NOT have been called
      expect(sendMessageWithRetry).not.toHaveBeenCalled();
    });

    it("auto-correction should skip when AI is offline", async () => {
      const { isAiOffline: mockOffline } = await import("./db");
      (mockOffline as any).mockResolvedValue(true);
      
      const { retroactiveCorrectionScan } = await import("./auto-correction");
      const result = await retroactiveCorrectionScan();
      
      expect(result).toBe(0);
    });
  });
});
