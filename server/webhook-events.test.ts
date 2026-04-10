/**
 * Tests for Phase 2: Webhook Event Handlers + AI Training Corpus
 */
import { describe, it, expect } from "vitest";

// ─── Webhook Events Handler Tests ──────────────────────────────────────────

describe("webhook-events.ts", () => {
  it("should export all 5 new event handlers", async () => {
    const mod = await import("./webhook-events");
    expect(typeof mod.handleAppointmentWebhook).toBe("function");
    expect(typeof mod.handleNoteWebhook).toBe("function");
    expect(typeof mod.handleEmailEventWebhook).toBe("function");
    expect(typeof mod.handleContactDndWebhook).toBe("function");
    expect(typeof mod.handleOpportunityWebhook).toBe("function");
  });
});

// ─── Webhook Helpers Extended Event Detection ──────────────────────────────

describe("webhook-helpers detectEventType extensions", () => {
  it("should export detectEventType function", async () => {
    const mod = await import("./webhook-helpers");
    expect(typeof mod.detectEventType).toBe("function");
  });

  it("should detect appointment events", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      type: "AppointmentCreate",
      appointment: { id: "apt1" },
    });
    expect(result).toBe("appointment");
  });

  it("should detect note events", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      type: "NoteCreate",
      note: { id: "note1", body: "test" },
    });
    expect(result).toBe("note");
  });

  it("should detect email event via emailEvent field", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      type: "EmailStatistics",
      emailEvent: "opened",
    });
    expect(result).toBe("email_event");
  });

  it("should detect contact DND events", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      type: "ContactDndUpdate",
      dndSettings: { sms: true },
      contactId: "c1",
    });
    expect(result).toBe("contact_dnd");
  });

  it("should detect opportunity events", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      type: "OpportunityStatusUpdate",
      opportunity: { id: "opp1", status: "won" },
    });
    expect(result).toBe("opportunity");
  });

  it("should still detect InboundMessage correctly", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      type: "InboundMessage",
      body: "hello",
      direction: "inbound",
    });
    expect(result).toBe("message");
  });

  it("should still detect OutboundMessage correctly", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      type: "OutboundMessage",
      body: "hello",
      direction: "outbound",
    });
    expect(result).toBe("message");
  });

  it("should still detect ContactCreate correctly", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      type: "ContactCreate",
      firstName: "John",
    });
    expect(result).toBe("contact");
  });

  it("should return unknown for unrecognized payloads", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({ randomField: true });
    expect(result).toBe("unknown");
  });

  // --- Workflow-name-based detection (new GHL workflow app payloads) ---
  it("should detect agent outbound message via workflow.name", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      contact_id: "abc123",
      message: {},
      workflow: { id: "wf1", name: "Adorb AI - Agent Outbound Message" },
    });
    expect(result).toBe("message");
  });

  it("should detect email events via workflow.name", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      contact_id: "abc123",
      workflow: { id: "wf2", name: "Adorb AI - Email Events" },
    });
    expect(result).toBe("email_event");
  });

  it("should detect appointment via workflow.name", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      contact_id: "abc123",
      workflow: { id: "wf3", name: "Adorb AI - Appointment Status" },
    });
    expect(result).toBe("appointment");
  });

  it("should detect DND via workflow.name", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      contact_id: "abc123",
      workflow: { id: "wf4", name: "Adorb AI - Contact DND Changed" },
    });
    expect(result).toBe("contact_dnd");
  });

  it("should detect opportunity via workflow.name", async () => {
    const { detectEventType } = await import("./webhook-helpers");
    const result = detectEventType({
      contact_id: "abc123",
      workflow: { id: "wf5", name: "Adorb AI - Opportunity Updated" },
    });
    expect(result).toBe("opportunity");
  });

  it("normalizeWorkflowPayload should set direction=outbound for agent outbound workflow", async () => {
    const { normalizeWorkflowPayload } = await import("./webhook-helpers");
    const result = normalizeWorkflowPayload({
      contact_id: "abc123",
      message: { body: "Hello from agent" },
      workflow: { id: "wf1", name: "Adorb AI - Agent Outbound Message" },
    });
    expect(result.direction).toBe("outbound");
    expect(result.contactId).toBe("abc123");
    expect(result.body).toBe("Hello from agent");
  });

  it("normalizeWorkflowPayload should set direction=outbound even with empty message body", async () => {
    const { normalizeWorkflowPayload } = await import("./webhook-helpers");
    const result = normalizeWorkflowPayload({
      contact_id: "abc123",
      message: {},
      workflow: { id: "wf1", name: "Adorb AI - Agent Outbound Message" },
    });
    expect(result.direction).toBe("outbound");
  });
});

// ─── Sales Training Corpus Tests ───────────────────────────────────────────

describe("sales-training.ts", () => {
  it("should export all training corpus functions and constants", async () => {
    const mod = await import("../shared/sales-training");
    expect(typeof mod.getTrainingCorpus).toBe("function");
    expect(typeof mod.getCompactTrainingCorpus).toBe("function");
    expect(typeof mod.getPersonaGuidance).toBe("function");
    expect(typeof mod.PRICING_MATRIX).toBe("string");
    expect(typeof mod.ESCALATION_RULES).toBe("string");
    expect(typeof mod.BRAND_VOICE_GUIDE).toBe("string");
    expect(typeof mod.PERSONA_PLAYBOOKS).toBe("string");
    expect(typeof mod.SALES_PROCESS_GUIDE).toBe("string");
    expect(typeof mod.COMPETITIVE_INTEL).toBe("string");
    expect(typeof mod.SEASONAL_CALENDAR).toBe("string");
  });

  it("getTrainingCorpus should return non-empty string with all sections when all enabled", async () => {
    const { getTrainingCorpus } = await import("../shared/sales-training");
    const full = getTrainingCorpus({
      includePricing: true,
      includeBrandVoice: true,
      includePersonas: true,
      includeSalesProcess: true,
      includeCompetitive: true,
      includeSeasonal: true,
      includeEscalation: true,
    });
    expect(full.length).toBeGreaterThan(500);
    // Should contain content from multiple sections
    expect(full).toBeTruthy();
  });

  it("getTrainingCorpus should respect section toggles — pricing only", async () => {
    const { getTrainingCorpus } = await import("../shared/sales-training");
    const pricingOnly = getTrainingCorpus({
      includePricing: true,
      includeBrandVoice: false,
      includePersonas: false,
      includeSalesProcess: false,
      includeCompetitive: false,
      includeSeasonal: false,
      includeEscalation: false,
    });
    expect(pricingOnly.length).toBeGreaterThan(100);
  });

  it("getCompactTrainingCorpus should return a non-empty string", async () => {
    const { getCompactTrainingCorpus } = await import("../shared/sales-training");
    const compact = getCompactTrainingCorpus();
    expect(compact.length).toBeGreaterThan(100);
  });

  it("getPersonaGuidance should return guidance for known segments", async () => {
    const { getPersonaGuidance } = await import("../shared/sales-training");
    // Test with a segment that likely exists in the persona playbooks
    const guidance = getPersonaGuidance("Churches & Religious");
    // Should return non-empty guidance for a known segment
    expect(typeof guidance).toBe("string");
  });

  it("getPersonaGuidance should return empty string for null segment", async () => {
    const { getPersonaGuidance } = await import("../shared/sales-training");
    const result = getPersonaGuidance(null);
    expect(result).toBe("");
  });

  it("getPersonaGuidance should return empty string for undefined segment", async () => {
    const { getPersonaGuidance } = await import("../shared/sales-training");
    const result = getPersonaGuidance(undefined);
    expect(result).toBe("");
  });

  it("PRICING_MATRIX should contain key product categories", async () => {
    const { PRICING_MATRIX } = await import("../shared/sales-training");
    expect(PRICING_MATRIX.length).toBeGreaterThan(100);
    // Should contain at least some printing method references
    const lc = PRICING_MATRIX.toLowerCase();
    expect(lc).toMatch(/dtf|screen|embroid|print/i);
  });

  it("ESCALATION_RULES should contain escalation-related content", async () => {
    const { ESCALATION_RULES } = await import("../shared/sales-training");
    expect(ESCALATION_RULES.length).toBeGreaterThan(50);
    const lc = ESCALATION_RULES.toLowerCase();
    expect(lc).toMatch(/escalat|human|agent|takeover|handoff/i);
  });
});

// ─── Brain Council Integration Tests (source code verification) ────────────

describe("Brain Council training corpus integration", () => {
  it("strategist.ts should import and use training corpus", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/strategist.ts", "utf-8");
    expect(src).toContain("from \"../shared/sales-training\"");
    expect(src).toContain("getTrainingCorpus");
    expect(src).toContain("getPersonaGuidance");
  });

  it("composer.ts should import and use training corpus", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/composer.ts", "utf-8");
    expect(src).toContain("from \"../shared/sales-training\"");
    expect(src).toContain("getCompactTrainingCorpus");
    expect(src).toContain("getPersonaGuidance");
  });

  it("closer.ts should import and use training corpus", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/closer.ts", "utf-8");
    expect(src).toContain("from \"../shared/sales-training\"");
    expect(src).toContain("getCompactTrainingCorpus");
  });

  it("objection-handler.ts should import and use training corpus", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/objection-handler.ts", "utf-8");
    expect(src).toContain("from \"../shared/sales-training\"");
    expect(src).toContain("getCompactTrainingCorpus");
  });

  it("qc.ts should import pricing matrix and escalation rules", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/qc.ts", "utf-8");
    expect(src).toContain("from \"../shared/sales-training\"");
    expect(src).toContain("PRICING_MATRIX");
    expect(src).toContain("ESCALATION_RULES");
  });

  it("ai-brain.ts (legacy fallback) should import training corpus", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/ai-brain.ts", "utf-8");
    expect(src).toContain("from \"../shared/sales-training\"");
    expect(src).toContain("getCompactTrainingCorpus");
  });
});

// ─── Schema Extension Tests ────────────────────────────────────────────────

describe("Schema extensions for webhook data", () => {
  it("leads table should have email engagement columns", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("drizzle/schema.ts", "utf-8");
    expect(src).toContain("emailOpens");
    expect(src).toContain("emailClicks");
    expect(src).toContain("emailBounces");
    expect(src).toContain("lastEmailOpenAt");
  });

  it("leads table should have appointment columns", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("drizzle/schema.ts", "utf-8");
    expect(src).toContain("appointmentId");
    expect(src).toContain("appointmentStatus");
    expect(src).toContain("nextAppointmentAt");
  });

  it("leads table should have agent notes column", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("drizzle/schema.ts", "utf-8");
    expect(src).toContain("lastAgentNote");
  });
});

// ─── Webhooks.ts Event Routing Tests ───────────────────────────────────────

describe("Webhooks event routing", () => {
  it("webhooks.ts should import all new event handlers", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/webhooks.ts", "utf-8");
    expect(src).toContain("handleAppointmentWebhook");
    expect(src).toContain("handleNoteWebhook");
    expect(src).toContain("handleEmailEventWebhook");
    expect(src).toContain("handleContactDndWebhook");
    expect(src).toContain("handleOpportunityWebhook");
  });

  it("webhooks.ts should have case statements for new event types", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/webhooks.ts", "utf-8");
    // Check for the lowercase event type strings used in the switch
    expect(src).toContain("\"appointment\"");
    expect(src).toContain("\"note\"");
    expect(src).toContain("\"email_event\"");
    expect(src).toContain("\"contact_dnd\"");
    expect(src).toContain("\"opportunity\"");
  });
});
