/**
 * Tests for the Lost Lead Long-Term Nurture Engine (v3 — channel-aware, TCPA, shared send pipeline)
 *
 * Validates:
 * 1. Channel resolution — respects preferredChannel from lead record
 * 2. TCPA quiet hours enforcement for SMS sends
 * 3. Shared send pipeline (buildSendOpts + sendMessageWithRetry)
 * 4. Brain Council integration with correct channel
 * 5. NOT-INTERESTED fast-path detection
 * 6. Brain Council blocking / graceful_exit
 * 7. Imported contact nurture path
 * 8. DND fallback logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── MOCK DEPENDENCIES ───────────────────────────────────────────────────────
vi.mock("./db", () => ({
  getLostLeadsForNurture: vi.fn(),
  getImportedContactsDueForNurture: vi.fn(),
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
  addConversation: vi.fn().mockResolvedValue({ id: 999 }),
  isAiOffline: vi.fn().mockResolvedValue(false),
  getConversationHistory: vi.fn().mockResolvedValue([]),
  addBrainCouncilAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./ghl", () => ({
  fetchGhlConversationHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock("./webhook-helpers", () => ({
  buildSendOpts: vi.fn().mockReturnValue({ type: "Email", subject: "Test", html: "<p>Test</p>", fromName: "Abby Bouwer" }),
  sendMessageWithRetry: vi.fn().mockResolvedValue({ success: true, resolvedContactId: "ghl-contact-001", emailMessageId: "msg-123" }),
  formatEmailHtml: vi.fn((text: string) => `<p>${text}</p>`),
  ensureEmailSignature: vi.fn((text: string) => text),
}));

vi.mock("./area-code-timezone", () => ({
  isTcpaQuietHoursForRecipient: vi.fn().mockReturnValue(false),
}));

vi.mock("./brain-adapter", () => ({
  runBrainCouncil: vi.fn().mockResolvedValue({
    message: "Hey there, just checking in — it's been a while!",
    fromName: "Abby Bouwer",
    subject: "Quick check-in",
    framework: "DIRECT_RESPONSE",
    angle: "reactivation",
    channel: "Email",
    extractedDates: [],
    score: 75,
    segment: "general",
    nextEngagementHours: 2160,
    qcScore: 85,
    strategyReasoning: "Quarterly reactivation",
    researchSummary: "",
    blocked: false,
    fallbackUsed: false,
    conversationStage: "reactivation",
  }),
}));

vi.mock("../shared/brand-assets", () => ({
  BRAND: {
    companyName: "ADORB CUSTOM PRINTING",
    defaultAgentName: "Abby Bouwer",
    city: "South Florida",
    website: "https://adorbcustomtees.com",
    phone: "(954) 932-8543",
    reviewStars: "4.9",
    reviewCount: "867+",
    signatureBlock: "— {agentName}, ADORB CUSTOM PRINTING",
  },
}));

import { processLostLeadNurture, processImportedContactNurture } from "./lost-lead-nurture";
import * as db from "./db";
import * as ghl from "./ghl";
import * as brain from "./brain-adapter";
import * as helpers from "./webhook-helpers";
import * as tcpa from "./area-code-timezone";

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function makeLostLead(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    ghlContactId: "ghl-contact-001",
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "+19545551234",
    businessName: "Jane's Boutique",
    pipelineStage: "lost",
    reactivationCount: 0,
    emailUnsubscribed: 0,
    dndEmail: null,
    dndSms: null,
    preferredChannel: "EMAIL",
    lastLostNurtureAt: null,
    ...overrides,
  };
}

function resetMocks() {
  vi.clearAllMocks();
  (db.isAiOffline as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  (db.getConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (db.getImportedContactsDueForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (ghl.fetchGhlConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (helpers.buildSendOpts as ReturnType<typeof vi.fn>).mockReturnValue({ type: "Email", subject: "Test", html: "<p>Test</p>", fromName: "Abby Bouwer" });
  (helpers.sendMessageWithRetry as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, resolvedContactId: "ghl-contact-001", emailMessageId: "msg-123" });
  (tcpa.isTcpaQuietHoursForRecipient as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (brain.runBrainCouncil as ReturnType<typeof vi.fn>).mockResolvedValue({
    message: "Hey there, just checking in!",
    fromName: "Abby Bouwer",
    subject: "Quick check-in",
    framework: "DIRECT_RESPONSE",
    angle: "reactivation",
    channel: "Email",
    extractedDates: [],
    score: 75,
    segment: "general",
    nextEngagementHours: 2160,
    qcScore: 85,
    strategyReasoning: "Quarterly reactivation",
    researchSummary: "",
    blocked: false,
    fallbackUsed: false,
  });
}

// ─── HELPERS: Business hours fake timer ─────────────────────────────────────
// Tests that send SMS need to run during business hours (Mon-Fri 9am-5pm ET).
// We use a fixed Wednesday 10am ET timestamp to guarantee isBusinessHoursET() returns true.
// Wednesday May 14, 2025 10:00 AM ET = 14:00 UTC
const BUSINESS_HOURS_UTC = new Date("2025-05-14T14:00:00.000Z");

// ─── TESTS ───────────────────────────────────────────────────────────────────
describe("Lost Lead Nurture Engine v3 (channel-aware, TCPA, shared send pipeline)", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    vi.setSystemTime(BUSINESS_HOURS_UTC);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("AI offline guard", () => {
    it("skips entire cycle when AI is offline", async () => {
      (db.isAiOffline as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const result = await processLostLeadNurture();
      expect(result.processed).toBe(0);
      expect(result.sent).toBe(0);
      expect(brain.runBrainCouncil).not.toHaveBeenCalled();
    });
  });

  describe("empty queue", () => {
    it("returns zero stats when no lost leads are due", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const result = await processLostLeadNurture();
      expect(result.processed).toBe(0);
      expect(result.sent).toBe(0);
    });
  });

  describe("channel resolution — respects preferredChannel", () => {
    it("sends via Email when preferredChannel is EMAIL and email is available", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead({ preferredChannel: "EMAIL" })]);
      await processLostLeadNurture();
      // Brain Council should receive channel: "Email"
      expect(brain.runBrainCouncil).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "Email" })
      );
      // buildSendOpts should be called with "Email"
      expect(helpers.buildSendOpts).toHaveBeenCalledWith(
        "Email",
        expect.any(String),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it("sends via SMS when preferredChannel is SMS and phone is available", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeLostLead({ preferredChannel: "SMS", phone: "+19545551234" }),
      ]);
      (helpers.buildSendOpts as ReturnType<typeof vi.fn>).mockReturnValue({ type: "SMS", message: "Hey!" });
      await processLostLeadNurture();
      // Brain Council should receive channel: "SMS"
      expect(brain.runBrainCouncil).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "SMS" })
      );
      // buildSendOpts should be called with "SMS"
      expect(helpers.buildSendOpts).toHaveBeenCalledWith(
        "SMS",
        expect.any(String),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it("falls back to Email when preferredChannel is SMS but phone is missing", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeLostLead({ preferredChannel: "SMS", phone: null }),
      ]);
      await processLostLeadNurture();
      expect(brain.runBrainCouncil).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "Email" })
      );
    });

    it("falls back to SMS when preferredChannel is EMAIL but email is missing", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeLostLead({ preferredChannel: "EMAIL", email: null, phone: "+19545551234" }),
      ]);
      (helpers.buildSendOpts as ReturnType<typeof vi.fn>).mockReturnValue({ type: "SMS", message: "Hey!" });
      await processLostLeadNurture();
      expect(brain.runBrainCouncil).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "SMS" })
      );
    });

    it("skips lead when no viable channel exists (no email, no phone)", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeLostLead({ email: null, phone: null }),
      ]);
      const result = await processLostLeadNurture();
      expect(result.skipped).toBe(1);
      expect(brain.runBrainCouncil).not.toHaveBeenCalled();
    });

    it("skips lead when preferred channel is SMS but dndSms=1 and no email", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeLostLead({ preferredChannel: "SMS", dndSms: 1, email: null }),
      ]);
      const result = await processLostLeadNurture();
      expect(result.skipped).toBe(1);
      expect(brain.runBrainCouncil).not.toHaveBeenCalled();
    });

    it("falls back to SMS when preferredChannel is EMAIL but dndEmail=1", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeLostLead({ preferredChannel: "EMAIL", dndEmail: 1, phone: "+19545551234" }),
      ]);
      (helpers.buildSendOpts as ReturnType<typeof vi.fn>).mockReturnValue({ type: "SMS", message: "Hey!" });
      await processLostLeadNurture();
      expect(brain.runBrainCouncil).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "SMS" })
      );
    });
  });

  describe("TCPA quiet hours enforcement", () => {
    it("skips SMS send during TCPA quiet hours", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeLostLead({ preferredChannel: "SMS", phone: "+19545551234" }),
      ]);
      (tcpa.isTcpaQuietHoursForRecipient as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const result = await processLostLeadNurture();
      expect(result.skipped).toBe(1);
      expect(brain.runBrainCouncil).not.toHaveBeenCalled();
    });

    it("does NOT check TCPA for Email sends", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeLostLead({ preferredChannel: "EMAIL" }),
      ]);
      await processLostLeadNurture();
      expect(tcpa.isTcpaQuietHoursForRecipient).not.toHaveBeenCalled();
      expect(brain.runBrainCouncil).toHaveBeenCalled();
    });
  });

  describe("shared send pipeline (buildSendOpts + sendMessageWithRetry)", () => {
    it("uses buildSendOpts and sendMessageWithRetry — NOT ghl.sendMessage directly", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      await processLostLeadNurture();
      expect(helpers.buildSendOpts).toHaveBeenCalled();
      expect(helpers.sendMessageWithRetry).toHaveBeenCalled();
    });

    it("skips when buildSendOpts returns null", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (helpers.buildSendOpts as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const result = await processLostLeadNurture();
      expect(result.skipped).toBe(1);
      expect(helpers.sendMessageWithRetry).not.toHaveBeenCalled();
    });

    it("counts error when sendMessageWithRetry returns success=false", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (helpers.sendMessageWithRetry as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        resolvedContactId: "ghl-contact-001",
        error: "GHL rate limit",
        correctionTaken: "none",
      });
      const result = await processLostLeadNurture();
      expect(result.errors).toBe(1);
      expect(result.sent).toBe(0);
    });
  });

  describe("Brain Council integration", () => {
    it("passes SMS channel instruction to Brain Council for SMS leads", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeLostLead({ preferredChannel: "SMS", phone: "+19545551234" }),
      ]);
      (helpers.buildSendOpts as ReturnType<typeof vi.fn>).mockReturnValue({ type: "SMS", message: "Hey!" });
      await processLostLeadNurture();
      expect(brain.runBrainCouncil).toHaveBeenCalledWith(
        expect.objectContaining({
          incomingMessage: expect.stringContaining("Channel: SMS"),
        })
      );
    });

    it("passes Email channel instruction to Brain Council for Email leads", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      await processLostLeadNurture();
      expect(brain.runBrainCouncil).toHaveBeenCalledWith(
        expect.objectContaining({
          incomingMessage: expect.stringContaining("Channel: Email"),
        })
      );
    });

    it("runs Brain Council with full conversation history", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (db.getConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
        { senderType: "ai", direction: "outbound", channel: "Email", messageBody: "Hi there!" },
        { senderType: "lead", direction: "inbound", channel: "Email", messageBody: "Maybe later" },
      ]);
      await processLostLeadNurture();
      expect(brain.runBrainCouncil).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: 1,
          externalHistory: expect.stringContaining("Hi there!"),
        })
      );
    });
  });

  describe("NOT-INTERESTED fast-path detection", () => {
    it("blocks and moves to not_qualified when decline detected in local history", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (db.getConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
        { senderType: "lead", direction: "inbound", channel: "SMS", messageBody: "I am no longer interested. Thanks" },
      ]);
      const result = await processLostLeadNurture();
      expect(result.blocked).toBe(1);
      expect(result.sent).toBe(0);
      expect(db.updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        pipelineStage: "not_qualified",
      }));
      expect(brain.runBrainCouncil).not.toHaveBeenCalled();
    });

    it("blocks when decline detected in GHL history", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (ghl.fetchGhlConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
        { direction: "inbound", type: "SMS", body: "Please stop contacting me" },
      ]);
      const result = await processLostLeadNurture();
      expect(result.blocked).toBe(1);
      expect(brain.runBrainCouncil).not.toHaveBeenCalled();
    });
  });

  describe("Brain Council blocking", () => {
    it("blocks when Brain Council returns blocked=true", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (brain.runBrainCouncil as ReturnType<typeof vi.fn>).mockResolvedValue({
        message: "",
        blocked: true,
        blockReason: "QC rejected: stale context",
        fallbackUsed: false,
      });
      const result = await processLostLeadNurture();
      expect(result.blocked).toBe(1);
      expect(result.sent).toBe(0);
      expect(helpers.sendMessageWithRetry).not.toHaveBeenCalled();
    });

    it("blocks and moves to not_qualified on graceful_exit violation", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (brain.runBrainCouncil as ReturnType<typeof vi.fn>).mockResolvedValue({
        message: "",
        blocked: true,
        blockReason: "graceful_exit — lead declined",
        violationCategory: "graceful_exit_retired",
        fallbackUsed: false,
      });
      const result = await processLostLeadNurture();
      expect(result.blocked).toBe(1);
      expect(db.updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        pipelineStage: "not_qualified",
      }));
    });
  });

  describe("successful send", () => {
    it("sends and updates lead on successful Brain Council run", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      const result = await processLostLeadNurture();
      expect(result.sent).toBe(1);
      expect(helpers.sendMessageWithRetry).toHaveBeenCalled();
      expect(db.updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        lastLostNurtureAt: expect.any(Date),
        reactivationCount: 1,
        lastOutboundChannel: "Email",
      }));
      expect(db.addConversation).toHaveBeenCalledWith(expect.objectContaining({
        leadId: 1,
        channel: "Email",
        direction: "outbound",
        senderType: "ai",
      }));
    });
  });

  describe("error handling", () => {
    it("counts errors and continues processing remaining leads", async () => {
      const lead1 = makeLostLead({ id: 1, ghlContactId: "ghl-001" });
      const lead2 = makeLostLead({ id: 2, ghlContactId: "ghl-002", name: "Bob Smith" });
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([lead1, lead2]);
      (brain.runBrainCouncil as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("LLM timeout"))
        .mockResolvedValueOnce({
          message: "Hey Bob!",
          blocked: false,
          fallbackUsed: false,
          subject: "Check-in",
        });
      const result = await processLostLeadNurture();
      expect(result.errors).toBe(1);
      expect(result.sent).toBe(1);
      expect(result.processed).toBe(2);
    });

    it("returns empty stats when DB query fails", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB connection lost"));
      const result = await processLostLeadNurture();
      expect(result.processed).toBe(0);
      expect(result.sent).toBe(0);
      expect(result.errors).toBe(0);
    });
  });
});

describe("Imported Contact Nurture (monthly)", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    vi.setSystemTime(BUSINESS_HOURS_UTC);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips when AI is offline", async () => {
    (db.isAiOffline as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const result = await processImportedContactNurture();
    expect(result.processed).toBe(0);
    expect(brain.runBrainCouncil).not.toHaveBeenCalled();
  });

  it("processes imported contacts through Brain Council", async () => {
    (db.getImportedContactsDueForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeLostLead({ id: 10, ghlContactId: "ghl-import-001" }),
    ]);
    const result = await processImportedContactNurture();
    expect(result.sent).toBe(1);
    expect(brain.runBrainCouncil).toHaveBeenCalledWith(
      expect.objectContaining({
        incomingMessage: expect.stringContaining("monthly re-engagement"),
      })
    );
  });

  it("respects preferredChannel for imported contacts (SMS when set)", async () => {
    (db.getImportedContactsDueForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeLostLead({ id: 10, ghlContactId: "ghl-import-001", preferredChannel: "SMS", phone: "+19545551234" }),
    ]);
    (helpers.buildSendOpts as ReturnType<typeof vi.fn>).mockReturnValue({ type: "SMS", message: "Hey!" });
    const result = await processImportedContactNurture();
    expect(result.sent).toBe(1);
    expect(brain.runBrainCouncil).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "SMS" })
    );
  });
});
