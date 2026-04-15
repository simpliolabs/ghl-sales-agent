/**
 * Tests for the Lost Lead Long-Term Nurture Engine (v2 — Brain Council based)
 *
 * Validates:
 * 1. Full Brain Council is called with conversation history
 * 2. NOT-INTERESTED fast-path detection blocks sends
 * 3. graceful_exit from Brain Council blocks sends
 * 4. Successful sends go through Brain Council → GHL
 * 5. AI offline check skips the entire cycle
 * 6. Email-only enforcement
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── MOCK DEPENDENCIES ───────────────────────────────────────────────────────
vi.mock("./db", () => ({
  getLostLeadsForNurture: vi.fn(),
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
  addConversation: vi.fn().mockResolvedValue({ id: 999 }),
  isAiOffline: vi.fn().mockResolvedValue(false),
  getConversationHistory: vi.fn().mockResolvedValue([]),
  addBrainCouncilAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./ghl", () => ({
  sendMessage: vi.fn().mockResolvedValue({ blocked: false, messageId: "msg-123" }),
  fetchGhlConversationHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock("./brain-council-orchestrator", () => ({
  runBrainCouncil: vi.fn().mockResolvedValue({
    message: "Hey there, just checking in — it's been a while!",
    fromName: "Abby Bouwer",
    subject: "Quick check-in from Adorb",
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

import { processLostLeadNurture } from "./lost-lead-nurture";
import * as db from "./db";
import * as ghl from "./ghl";
import * as brain from "./brain-council-orchestrator";

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function makeLostLead(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    ghlContactId: "ghl-contact-001",
    name: "Jane Doe",
    email: "jane@example.com",
    businessName: "Jane's Boutique",
    pipelineStage: "lost",
    reactivationCount: 0,
    emailUnsubscribed: 0,
    dndEmail: null,
    lastLostNurtureAt: null,
    ...overrides,
  };
}

function resetMocks() {
  vi.clearAllMocks();
  (db.isAiOffline as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  (db.getConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (ghl.fetchGhlConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (ghl.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ blocked: false, messageId: "msg-123" });
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

// ─── TESTS ───────────────────────────────────────────────────────────────────
describe("Lost Lead Nurture Engine v2 (Brain Council)", () => {
  beforeEach(() => {
    resetMocks();
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

  describe("skip conditions", () => {
    it("skips lead with no ghlContactId", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead({ ghlContactId: null })]);
      const result = await processLostLeadNurture();
      expect(result.skipped).toBe(1);
      expect(result.sent).toBe(0);
      expect(brain.runBrainCouncil).not.toHaveBeenCalled();
    });

    it("skips lead with no email", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead({ email: null })]);
      const result = await processLostLeadNurture();
      expect(result.skipped).toBe(1);
      expect(result.sent).toBe(0);
    });
  });

  describe("Brain Council integration", () => {
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
          channel: "Email",
          externalHistory: expect.stringContaining("Hi there!"),
        })
      );
    });

    it("fetches GHL history and passes it to Brain Council", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (ghl.fetchGhlConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
        { direction: "outbound", type: "SMS", body: "Hey from GHL" },
        { direction: "inbound", type: "SMS", body: "Got it thanks" },
      ]);
      await processLostLeadNurture();
      expect(brain.runBrainCouncil).toHaveBeenCalledWith(
        expect.objectContaining({
          externalHistory: expect.stringContaining("Full GHL conversation history"),
        })
      );
    });

    it("passes nurture-specific trigger context to Brain Council", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      await processLostLeadNurture();
      expect(brain.runBrainCouncil).toHaveBeenCalledWith(
        expect.objectContaining({
          incomingMessage: expect.stringContaining("quarterly long-term nurture"),
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
      expect(db.addBrainCouncilAudit).toHaveBeenCalledWith(expect.objectContaining({
        blocked: 1,
        violationCategory: "explicit_decline_in_history",
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

    it("detects various not-interested patterns", async () => {
      const patterns = [
        "not interested",
        "No thanks",
        "decided not to do shirts",
        "please stop contacting me",
        "remove me from your list",
        "I opted out already",
        "take me off your list",
      ];
      for (const msg of patterns) {
        resetMocks();
        (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
        (db.getConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
          { senderType: "lead", direction: "inbound", channel: "SMS", messageBody: msg },
        ]);
        const result = await processLostLeadNurture();
        expect(result.blocked).toBe(1);
        expect(brain.runBrainCouncil).not.toHaveBeenCalled();
      }
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
      expect(ghl.sendMessage).not.toHaveBeenCalled();
      // Still updates lastLostNurtureAt to prevent immediate retry
      expect(db.updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        lastLostNurtureAt: expect.any(Date),
      }));
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

    it("skips when Brain Council returns empty message", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (brain.runBrainCouncil as ReturnType<typeof vi.fn>).mockResolvedValue({
        message: "",
        blocked: false,
        fallbackUsed: false,
      });
      const result = await processLostLeadNurture();
      expect(result.skipped).toBe(1);
      expect(ghl.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("successful send", () => {
    it("sends email and updates lead on successful Brain Council run", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      const result = await processLostLeadNurture();
      expect(result.sent).toBe(1);
      expect(ghl.sendMessage).toHaveBeenCalledWith("ghl-contact-001", expect.objectContaining({
        type: "Email",
        subject: "Quick check-in",
        fromName: "Abby Bouwer",
      }));
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

    it("uses default subject when Brain Council doesn't provide one", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (brain.runBrainCouncil as ReturnType<typeof vi.fn>).mockResolvedValue({
        message: "Hey there!",
        blocked: false,
        fallbackUsed: false,
      });
      await processLostLeadNurture();
      expect(ghl.sendMessage).toHaveBeenCalledWith("ghl-contact-001", expect.objectContaining({
        subject: expect.stringContaining("Checking in from"),
      }));
    });

    it("skips when GHL sendMessage returns blocked", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      (ghl.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ blocked: true, reason: "invalid email" });
      const result = await processLostLeadNurture();
      expect(result.skipped).toBe(1);
      expect(result.sent).toBe(0);
    });
  });

  describe("email channel enforcement", () => {
    it("always sends via Email channel — never SMS", async () => {
      (db.getLostLeadsForNurture as ReturnType<typeof vi.fn>).mockResolvedValue([makeLostLead()]);
      await processLostLeadNurture();
      const call = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].type).toBe("Email");
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
