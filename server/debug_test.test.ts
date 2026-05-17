import { describe, it, expect, vi } from "vitest";
vi.mock("./db", () => ({ getDb: vi.fn().mockResolvedValue(null), isAiOffline: vi.fn().mockResolvedValue(false), getLeadById: vi.fn(), updateLeadFields: vi.fn(), addConversation: vi.fn(), getConversationHistory: vi.fn().mockResolvedValue([]), getRecentAiOutboundCount: vi.fn().mockResolvedValue(0), getLeadsDueForFollowUp: vi.fn().mockResolvedValue([]), upsertAiState: vi.fn(), addBrainCouncilAudit: vi.fn(), getBrainCouncilAuditForLead: vi.fn().mockResolvedValue([]), acquireDbBrainCouncilLock: vi.fn().mockResolvedValue(true), releaseDbBrainCouncilLock: vi.fn(), getAiState: vi.fn().mockResolvedValue(null), getLeadByGhlContactId: vi.fn().mockResolvedValue(null), addPipelineEvent: vi.fn(), addAgentAssignment: vi.fn(), getAgentWorkload: vi.fn().mockResolvedValue([]), getSystemSetting: vi.fn().mockResolvedValue(null), setSystemSetting: vi.fn(), isChannelDnd: vi.fn().mockResolvedValue(false), getBlockedChannels: vi.fn().mockResolvedValue([]), getBestChannelForLead: vi.fn().mockResolvedValue(null), getLastEmailThreadId: vi.fn().mockResolvedValue(null), getLastEmailThreadInfo: vi.fn().mockResolvedValue(null), findExistingLeadByIdentity: vi.fn().mockResolvedValue(null), syncGhlDnd: vi.fn(), insertDeferredResponse: vi.fn(), hasPendingDeferredResponse: vi.fn().mockResolvedValue(false), upsertLead: vi.fn().mockResolvedValue({ id: 1 }), getUncorrectedViolations: vi.fn().mockResolvedValue([]), updateAuditCorrection: vi.fn() }));
vi.mock("./ghl", () => ({ sendMessage: vi.fn(), createTask: vi.fn(), addNote: vi.fn(), fetchGhlConversationHistory: vi.fn().mockResolvedValue([]), getContact: vi.fn(), searchContacts: vi.fn(), updateContactCustomField: vi.fn(), updateOpportunityValue: vi.fn(), updateOpportunityStage: vi.fn(), updateContactAssignment: vi.fn(), AGENT_GHL_USER_IDS: {} }));
vi.mock("./webhook-helpers", () => ({ sendMessageWithRetry: vi.fn().mockResolvedValue({ success: true }), normalizeChannel: vi.fn((c: string) => c || "SMS"), extractFormData: vi.fn().mockReturnValue([]), isLlmExhausted: vi.fn().mockReturnValue(false), LLM_RETRY_DELAY_MS: 900000, MAX_LLM_RETRIES: 5, SALES_AGENTS: ["Abby Bouwer"], DESIGNER: "Designer", PRODUCTION_MANAGER: "Production Manager", STAGES: {}, buildSendOpts: vi.fn().mockReturnValue({ type: "SMS", message: "test" }), ensureEmailSignature: vi.fn((msg: string) => msg), formatEmailHtml: vi.fn((msg: string) => msg), buildContextSubject: vi.fn().mockReturnValue("Re: Your Order"), sourceToChannel: vi.fn().mockReturnValue("SMS"), detectEventType: vi.fn().mockReturnValue("message"), normalizeWorkflowPayload: vi.fn((p: any) => p), resolveGhlContactId: vi.fn().mockResolvedValue(null), extractContactData: vi.fn().mockReturnValue({}) }));
vi.mock("./single-brain", () => ({ runSingleBrain: vi.fn() }));
vi.mock("./brain-adapter", () => ({ runBrainCouncil: vi.fn() }));
vi.mock("./scheduling-engine", () => ({ calculateNextFollowUp: vi.fn(), checkRateLimits: vi.fn(), capDate: vi.fn((d: Date) => d), checkDnc: vi.fn().mockReturnValue(false), DNC_KEYWORDS: [] }));
vi.mock("./_core/notification", () => ({ notifyOwner: vi.fn() }));
vi.mock("./learning-loop", () => ({ buildJourneyFromLead: vi.fn(), recordConversationOutcome: vi.fn() }));
vi.mock("./channel-fallback", () => ({ handleChannelDnc: vi.fn(), detectDncChannel: vi.fn() }));
vi.mock("./ai-brain", () => ({ shouldHandoffToAgent: vi.fn(), estimateOrderValue: vi.fn(), generateContactNotes: vi.fn() }));
vi.mock("./fb-window-manager", () => ({ isFbWindowOpen: vi.fn().mockReturnValue(true), isFbChannel: vi.fn().mockReturnValue(false) }));
vi.mock("./lead-memory", () => ({ getLeadMemory: vi.fn(), updateLeadMemoryAfterRun: vi.fn() }));
vi.mock("./auto-correction", () => ({ detectConfusion: vi.fn().mockReturnValue(false), handleConfusionReply: vi.fn(), postSendValidation: vi.fn(), retroactiveCorrectionScan: vi.fn(), sendAutoCorrection: vi.fn() }));
vi.mock("./outcome-engine", () => ({ attributeReply: vi.fn(), attributeStageAdvance: vi.fn(), backfillOutcomes: vi.fn() }));
vi.mock("./omnisend", () => ({ pushContactToOmnisend: vi.fn() }));
vi.mock("./lookback-engine", () => ({ runLookback: vi.fn() }));
vi.mock("./brain-council-review", () => ({ runBrainCouncilSelfReview: vi.fn(), runFastMissedReplyScanner: vi.fn() }));
import * as outboxWorker from "./outbox-worker";
describe("debug", () => {
  it("shows all exports from outbox-worker", () => {
    console.log("outboxWorker keys:", Object.keys(outboxWorker));
    console.log("processOutboxRow type:", typeof outboxWorker.processOutboxRow);
    expect(typeof outboxWorker.processOutboxRow).toBe("function");
  });
});
