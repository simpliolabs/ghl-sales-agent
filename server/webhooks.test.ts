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
  addAgentAssignment: vi.fn().mockResolvedValue(undefined),
  getAgentWorkload: vi.fn().mockResolvedValue([{ agent: "Abby Bouwer", count: 5 }, { agent: "Chris McHendry", count: 3 }]),
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
}));

vi.mock("./omnisend", () => ({
  pushContactToOmnisend: vi.fn().mockResolvedValue({}),
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
    const { generateResearchContext } = await import("./ai-brain");
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
    expect(generateResearchContext).toHaveBeenCalled();
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
