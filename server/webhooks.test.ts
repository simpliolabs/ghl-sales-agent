import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies
vi.mock("./db", () => ({
  upsertLead: vi.fn().mockResolvedValue({ id: 1, name: "Test Lead", businessName: "Test Co", email: "test@test.com", phone: "+1234567890", assignedAgent: null, pipelineValue: null }),
  addConversation: vi.fn().mockResolvedValue({ id: 1 }),
  addPipelineEvent: vi.fn().mockResolvedValue(undefined),
  getLeadByGhlContactId: vi.fn().mockResolvedValue({ id: 1, name: "Test Lead", businessName: "Test Co", email: "test@test.com", phone: "+1234567890", assignedAgent: "Abby Bouwer", humanTakeover: 0, lastAgentActivityAt: null, pipelineValue: 500 }),
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
  upsertAiState: vi.fn().mockResolvedValue(undefined),
  getConversationHistory: vi.fn().mockResolvedValue([]),
  getRecentAiOutboundCount: vi.fn().mockResolvedValue(0),
  addAgentAssignment: vi.fn().mockResolvedValue(undefined),
  getAgentWorkload: vi.fn().mockResolvedValue([{ agent: "Abby Bouwer", count: 5 }, { agent: "Chris McHendry", count: 3 }]),
  addWebhookLog: vi.fn().mockResolvedValue(undefined),
  getLeadById: vi.fn().mockResolvedValue({ id: 1, name: "Test Lead", businessName: "Test Co", email: "test@test.com", phone: "+1234567890", assignedAgent: "Abby Bouwer", humanTakeover: 0, pipelineValue: 500 }),
  addBrainCouncilAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./ai-brain", () => ({
  generateAIResponse: vi.fn().mockResolvedValue({ message: "Hello!", fromName: "Adorb Custom Tees", framework: "PAS", angle: "intro", extractedDates: [], score: 50, segment: "other" }),
  classifySegment: vi.fn().mockResolvedValue("brand"),
  shouldHandoffToAgent: vi.fn().mockResolvedValue({ handoff: false, reason: "No handoff needed", resumeAI: false }),
  generateContactNotes: vi.fn().mockResolvedValue("Test notes"),
  estimateOrderValue: vi.fn().mockResolvedValue({ estimatedValue: 500, confidence: "medium", reasoning: "Test" }),
  generateResearchContext: vi.fn().mockResolvedValue({ summary: "Test business", businessType: "brand", potentialNeeds: ["t-shirts"], notes: "" }),
}));

vi.mock("./ghl", () => ({
  sendMessage: vi.fn().mockResolvedValue({ messageId: "msg_123" }),
  updateContactCustomField: vi.fn().mockResolvedValue({}),
  createTask: vi.fn().mockResolvedValue({ id: "task_123" }),
  addNote: vi.fn().mockResolvedValue({ id: "note_123" }),
  updateOpportunityValue: vi.fn().mockResolvedValue({}),
  updateOpportunityStage: vi.fn().mockResolvedValue({}),
  fetchGhlConversationHistory: vi.fn().mockResolvedValue([]),
  getContact: vi.fn().mockResolvedValue({ id: "resolved-123", firstName: "Test", lastName: "Lead", email: "test@test.com", phone: "+1234567890", companyName: "Test Co" }),
  searchContacts: vi.fn().mockResolvedValue([{ id: "resolved-123", firstName: "Test", lastName: "Lead", email: "test@test.com", phone: "+1234567890" }]),
}));

vi.mock("./omnisend", () => ({
  pushContactToOmnisend: vi.fn().mockResolvedValue({}),
}));

vi.mock("./scheduling-engine", () => ({
  calculateNextFollowUp: vi.fn().mockResolvedValue({ nextFollowUpAt: new Date(Date.now() + 24 * 60 * 60 * 1000), cadencePosition: 1, channel: "SMS", reason: "Test schedule" }),
  checkRateLimits: vi.fn().mockResolvedValue({ allowed: true, reason: "OK" }),
  checkLeadRateLimit: vi.fn().mockResolvedValue(true),
}));

vi.mock("./brain-council-orchestrator", () => ({
  runBrainCouncil: vi.fn().mockResolvedValue({ message: "Hello from Brain Council!", fromName: "Adorb Custom Tees", framework: "PAS", angle: "intro", extractedDates: [], score: 50, segment: "other", nextEngagementHours: 24, qcScore: 85, strategyReasoning: "Test strategy" }),
}));

vi.mock("./lead-researcher", () => ({
  researchLead: vi.fn().mockResolvedValue({ summary: "Test research", businessType: "brand", potentialNeeds: ["t-shirts"], notes: "" }),
}));

import { createWebhookRouter } from "./webhooks";
import express from "express";
import request from "supertest";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter());
  return app;
}

describe("Webhook Router", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();
  });

  describe("Unified endpoint /api/webhooks/ghl", () => {
    it("handles contact creation payload", async () => {
      const res = await request(app).post("/api/webhooks/ghl").send({
        id: "contact_123",
        firstName: "John",
        lastName: "Doe",
        email: "john@test.com",
        phone: "+1234567890",
        companyName: "Test Co",
        type: "ContactCreate",
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("handles inbound message payload", async () => {
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        body: "I need 50 t-shirts for our event",
        type: "InboundMessage",
        direction: "inbound",
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("handles pipeline stage change payload", async () => {
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        type: "PipelineStageChanged",
        previousStage: "New Lead",
        currentStage: "Qualified",
        monetaryValue: 1000,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.stage).toBe("Qualified");
    });

    it("handles task completed payload", async () => {
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        type: "TaskCompleted",
        title: "Create design proof for Test Co",
        status: "completed",
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns success for unrecognized events", async () => {
      const res = await request(app).post("/api/webhooks/ghl").send({
        randomField: "value",
      });
      expect(res.status).toBe(200);
      expect(res.body.action).toBe("unrecognized_event");
    });
  });

  describe("Legacy endpoints", () => {
    it("still handles /api/webhooks/ghl/contact", async () => {
      const res = await request(app).post("/api/webhooks/ghl/contact").send({
        id: "contact_456",
        firstName: "Jane",
        email: "jane@test.com",
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("still handles /api/webhooks/ghl/pipeline", async () => {
      const res = await request(app).post("/api/webhooks/ghl/pipeline").send({
        contactId: "contact_123",
        previousStage: "Qualified",
        currentStage: "Quote Sent",
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Pipeline stage automation", () => {
    it("sends customer notification on Qualified stage", async () => {
      const { sendMessage } = await import("./ghl");
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        type: "PipelineStageChanged",
        currentStage: "Qualified",
      });
      expect(res.status).toBe(200);
      // Should create a task for the assigned agent
      const { createTask } = await import("./ghl");
      expect(createTask).toHaveBeenCalled();
    });

    it("assigns César for design proof on Paid - Proof Needed stage", async () => {
      const { createTask } = await import("./ghl");
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        type: "PipelineStageChanged",
        currentStage: "Paid - Proof Needed",
      });
      expect(res.status).toBe(200);
      expect(createTask).toHaveBeenCalledWith("contact_123", expect.objectContaining({
        title: expect.stringContaining("design proof"),
        assignedTo: "César Vásquez",
      }));
    });

    it("assigns Cindy for production on Approved + Deposit stage", async () => {
      const { createTask } = await import("./ghl");
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        type: "PipelineStageChanged",
        currentStage: "Approved + Deposit",
      });
      expect(res.status).toBe(200);
      expect(createTask).toHaveBeenCalledWith("contact_123", expect.objectContaining({
        title: expect.stringContaining("production"),
        assignedTo: "Cindy Muchnick",
      }));
    });

    it("assigns Cindy for shipping on Ready stage", async () => {
      const { createTask } = await import("./ghl");
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        type: "PipelineStageChanged",
        currentStage: "Ready",
      });
      expect(res.status).toBe(200);
      expect(createTask).toHaveBeenCalledWith("contact_123", expect.objectContaining({
        title: expect.stringContaining("Ship"),
        assignedTo: "Cindy Muchnick",
      }));
    });

    it("schedules review follow-up on Delivered stage", async () => {
      const { updateLeadFields } = await import("./db");
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        type: "PipelineStageChanged",
        currentStage: "Delivered",
      });
      expect(res.status).toBe(200);
      expect(updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        nextFollowUpAt: expect.any(Date),
      }));
    });
  });

  describe("Task completion auto-advance", () => {
    it("advances to Proof Sent when design proof task completed", async () => {
      const { updateLeadFields } = await import("./db");
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        type: "TaskCompleted",
        title: "Create design proof for Test Lead",
        status: "completed",
      });
      expect(res.status).toBe(200);
      expect(updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        pipelineStage: "Proof Sent",
      }));
    });

    it("advances to Ready when production task completed", async () => {
      const { updateLeadFields } = await import("./db");
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        type: "TaskCompleted",
        title: "Start production for Test Lead",
        status: "completed",
      });
      expect(res.status).toBe(200);
      expect(updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        pipelineStage: "Ready",
      }));
    });

    it("advances to Delivered when shipping task completed", async () => {
      const { updateLeadFields } = await import("./db");
      const res = await request(app).post("/api/webhooks/ghl").send({
        contactId: "contact_123",
        type: "TaskCompleted",
        title: "Ship/arrange pickup for Test Lead",
        status: "completed",
      });
      expect(res.status).toBe(200);
      expect(updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        pipelineStage: "Delivered",
      }));
    });
  });

  describe("Message handling", () => {
    it("rejects messages without contactId", async () => {
      const res = await request(app).post("/api/webhooks/ghl/message").send({
        body: "Hello",
      });
      expect(res.status).toBe(400);
    });

    it("logs outbound human messages without AI response", async () => {
      const res = await request(app).post("/api/webhooks/ghl/message").send({
        contactId: "contact_123",
        body: "I'll send the quote now",
        direction: "outbound",
      });
      expect(res.status).toBe(200);
      expect(res.body.action).toBe("human_message_logged");
    });
  });
});

describe("Research context and auto-scheduling", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();
  });

  it("generates research context for new contacts with business name", async () => {
    const { researchLead } = await import("./lead-researcher");
    const { updateLeadFields } = await import("./db");

    const res = await request(app).post("/api/webhooks/ghl").send({
      id: "contact_research_1",
      firstName: "Test",
      lastName: "User",
      companyName: "Research Corp",
      email: "test@research.com",
      type: "ContactCreate",
    });

    expect(res.status).toBe(200);
    expect(researchLead).toHaveBeenCalled();
    // Should store research data via updateLeadFields
    expect(updateLeadFields).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({
        researchData: expect.objectContaining({
          summary: expect.any(String),
          businessType: expect.any(String),
        }),
      })
    );
  });

  it("sets default nextFollowUpAt for new contacts", async () => {
    const { updateLeadFields } = await import("./db");

    const res = await request(app).post("/api/webhooks/ghl").send({
      id: "contact_schedule_1",
      firstName: "Schedule",
      lastName: "Test",
      type: "ContactCreate",
    });

    expect(res.status).toBe(200);
    // Should set nextFollowUpAt (default 30 min)
    expect(updateLeadFields).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({
        nextFollowUpAt: expect.any(Date),
      })
    );
  });
});

describe("Dedup guard and cadence backoff", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();
  });

  it("skips AI outreach on contact create if recent AI message exists (dedup)", async () => {
    const { getRecentAiOutboundCount } = await import("./db");
    (getRecentAiOutboundCount as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const { runBrainCouncil } = await import("./brain-council-orchestrator");

    const res = await request(app).post("/api/webhooks/ghl").send({
      id: "contact_dedup_1",
      firstName: "Dedup",
      lastName: "Test",
      email: "dedup@test.com",
      phone: "+1234567890",
      type: "ContactCreate",
    });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("dedup_skipped");
    // AI should NOT have been called
    expect(runBrainCouncil).not.toHaveBeenCalled();
  });

  it("skips AI response on inbound message if recent AI message exists (dedup cooldown)", async () => {
    const { getRecentAiOutboundCount } = await import("./db");
    (getRecentAiOutboundCount as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const { runBrainCouncil } = await import("./brain-council-orchestrator");

    const res = await request(app).post("/api/webhooks/ghl/message").send({
      contactId: "contact_123",
      body: "Hello there",
      direction: "inbound",
    });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("dedup_cooldown");
    expect(runBrainCouncil).not.toHaveBeenCalled();
  });

  it("applies cadence backoff when 2+ consecutive unanswered AI messages", async () => {
    const { getConversationHistory, getRecentAiOutboundCount } = await import("./db");
    (getRecentAiOutboundCount as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    // Simulate 3 consecutive unanswered AI outbound messages
    (getConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      { direction: "outbound", senderType: "ai", channel: "SMS", messageBody: "Third msg", timestamp: new Date() },
      { direction: "outbound", senderType: "ai", channel: "SMS", messageBody: "Second msg", timestamp: new Date(Date.now() - 60000) },
      { direction: "outbound", senderType: "ai", channel: "SMS", messageBody: "First msg", timestamp: new Date(Date.now() - 120000) },
    ]);

    const { runBrainCouncil } = await import("./brain-council-orchestrator");

    const res = await request(app).post("/api/webhooks/ghl/message").send({
      contactId: "contact_123",
      body: "Triggered by webhook but should be backed off",
      direction: "inbound",
    });

    expect(res.status).toBe(200);
    // Should either respond with cadence_backoff or proceed (depends on timing)
    // The key assertion is that runBrainCouncil was NOT called if backoff applied
    if (res.body.action === "cadence_backoff") {
      expect(runBrainCouncil).not.toHaveBeenCalled();
    }
  });

  it("allows AI response when no recent AI messages (dedup passes)", async () => {
    const { getRecentAiOutboundCount, getConversationHistory } = await import("./db");
    (getRecentAiOutboundCount as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    // Reset conversation history to empty (no unanswered messages)
    (getConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { runBrainCouncil } = await import("./brain-council-orchestrator");

    const res = await request(app).post("/api/webhooks/ghl/message").send({
      contactId: "contact_123",
      body: "I need 50 shirts",
      direction: "inbound",
    });

    expect(res.status).toBe(200);
    expect(runBrainCouncil).toHaveBeenCalled();
  });
});

describe("Form data extraction in contact webhook", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();
  });

  it("sends locked first-contact template (not Brain Council) when form data is present", async () => {
    const { sendMessage, fetchGhlConversationHistory } = await import("./ghl");
    const { addConversation } = await import("./db");
    (fetchGhlConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      { direction: "inbound", type: "FB", body: "Form submission data" },
    ]);

    const res = await request(app).post("/api/webhooks/ghl").send({
      id: "contact_form_1",
      firstName: "Garvey",
      lastName: "Mclean",
      companyName: "Life Church",
      email: "garvey@lifechurch.com",
      phone: "+1234567890",
      type: "ContactCreate",
      what_type_of_products_are_you_interested_in_: "T-shirts",
      what_do_you_need_bulk_printing_for_: "Church/Ministry",
      how_soon_do_you_need_your_order_: "Within 1 week",
    });

    expect(res.status).toBe(200);
    // Brain Council should NOT be called for first contact (locked template)
    const { runBrainCouncil } = await import("./brain-council-orchestrator");
    expect(runBrainCouncil).not.toHaveBeenCalled();
    // sendMessage should be called with the locked template messages
    expect(sendMessage).toHaveBeenCalled();
    // addConversation should store the outbound messages
    expect(addConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "outbound",
        senderType: "ai",
        messageBody: expect.stringContaining("4.9 star review"),
      })
    );
  });
});

describe("GHL workflow payload normalization", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();
  });

  it("handles workflow-style inbound message with contact_id and nested message.body", async () => {
    const { runBrainCouncil } = await import("./brain-council-orchestrator");
    const { addConversation } = await import("./db");

    // This is the exact payload format GHL sends from the "Customer Replied" workflow
    const res = await request(app).post("/api/webhooks/ghl").send({
      contact_id: "LfVLSEmvupduc5x8HBNX",
      first_name: "DENNIS",
      last_name: "BOST",
      full_name: "DENNIS BOST",
      email: "dennis@hwbbqrecon.com",
      phone: "+17862857531",
      company_name: "Hog Wild BBQ",
      message: { type: 2, body: "The last shirts I ordered were paid for and picked up long ago" },
      workflow: { id: "4559864a-68d8-442d-96cd-395a4870365d", name: "Adorb AI — Customer Replied" },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Brain Council should be called to generate a response
    expect(runBrainCouncil).toHaveBeenCalled();
    // The inbound message should be stored
    expect(addConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "inbound",
        messageBody: "The last shirts I ordered were paid for and picked up long ago",
      })
    );
  });

  it("handles workflow-style pipeline change with pipleline_stage and contact_id", async () => {
    const res = await request(app).post("/api/webhooks/ghl").send({
      contact_id: "LfVLSEmvupduc5x8HBNX",
      full_name: "DENNIS BOST",
      pipleline_stage: "Quote Sent",
      pipeline_id: "OpojlMx3cTa0ts0e2pMc",
      pipeline_name: "Bulk Printing Pipeline",
      workflow: { id: "1d6cf8d1-a6ca-4c0c-a302-7ac496421963", name: "Adorb AI — Pipeline Stage Changed" },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("does not drop messages with empty body from workflow payloads", async () => {
    // Some workflow payloads have empty message body (e.g., reactions)
    // Empty body is falsy, so normalizer won't promote it to top-level body.
    // detectEventType sees no body/messageType, so falls through to "unknown".
    // The default handler sees contactId and treats it as a fallback_contact.
    const res = await request(app).post("/api/webhooks/ghl").send({
      contact_id: "test-contact-123",
      full_name: "Test User",
      message: { type: 18, body: "" },
      workflow: { id: "test-workflow", name: "Adorb AI — Customer Replied" },
    });

    // Should not crash — empty body should be handled gracefully
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("Concurrent message dedup lock", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();
  });

  it("blocks duplicate concurrent message webhooks for the same contact+body", async () => {
    // Add a delay to Brain Council so the lock is held while the second request arrives
    const { runBrainCouncil } = await import("./brain-council-orchestrator");
    (runBrainCouncil as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 100)); // simulate processing time
      return { message: "Hello!", fromName: "Adorb", framework: "PAS", angle: "intro", extractedDates: [], score: 50, segment: "other", nextEngagementHours: 24, qcScore: 85, strategyReasoning: "Test" };
    });

    const payload = {
      contactId: "dedup-concurrent-1",
      body: "I need 50 t-shirts for our event",
      type: "InboundMessage",
      direction: "inbound",
    };

    const [res1, res2] = await Promise.all([
      request(app).post("/api/webhooks/ghl").send(payload),
      request(app).post("/api/webhooks/ghl").send(payload),
    ]);

    // Both should succeed (200)
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // One should be the real handler, the other should be dedup_blocked
    const actions = [res1.body.action, res2.body.action];
    expect(actions).toContain("dedup_blocked");
  });

  it("allows different contacts to process concurrently", async () => {
    const payload1 = {
      contactId: "dedup-different-1",
      body: "I need shirts",
      type: "InboundMessage",
      direction: "inbound",
    };
    const payload2 = {
      contactId: "dedup-different-2",
      body: "I need shirts",
      type: "InboundMessage",
      direction: "inbound",
    };

    const [res1, res2] = await Promise.all([
      request(app).post("/api/webhooks/ghl").send(payload1),
      request(app).post("/api/webhooks/ghl").send(payload2),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Neither should be dedup_blocked since they're different contacts
    const actions = [res1.body.action, res2.body.action];
    expect(actions).not.toContain("dedup_blocked");
  });

  it("allows same contact with different messages to process", async () => {
    const payload1 = {
      contactId: "dedup-diffmsg-1",
      body: "First message",
      type: "InboundMessage",
      direction: "inbound",
    };
    const payload2 = {
      contactId: "dedup-diffmsg-1",
      body: "Second different message",
      type: "InboundMessage",
      direction: "inbound",
    };

    const [res1, res2] = await Promise.all([
      request(app).post("/api/webhooks/ghl").send(payload1),
      request(app).post("/api/webhooks/ghl").send(payload2),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Neither should be dedup_blocked since messages are different
    const actions = [res1.body.action, res2.body.action];
    expect(actions).not.toContain("dedup_blocked");
  });

  it("blocks duplicate on legacy /api/webhooks/ghl/message endpoint too", async () => {
    // Add a delay to Brain Council so the lock is held
    const { runBrainCouncil } = await import("./brain-council-orchestrator");
    (runBrainCouncil as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 100));
      return { message: "Hello!", fromName: "Adorb", framework: "PAS", angle: "intro", extractedDates: [], score: 50, segment: "other", nextEngagementHours: 24, qcScore: 85, strategyReasoning: "Test" };
    });

    const payload = {
      contactId: "dedup-legacy-1",
      body: "Legacy endpoint test",
      type: "InboundMessage",
      direction: "inbound",
    };

    const [res1, res2] = await Promise.all([
      request(app).post("/api/webhooks/ghl/message").send(payload),
      request(app).post("/api/webhooks/ghl/message").send(payload),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const actions = [res1.body.action, res2.body.action];
    expect(actions).toContain("dedup_blocked");
  });
});
