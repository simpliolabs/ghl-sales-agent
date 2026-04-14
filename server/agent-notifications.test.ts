/**
 * Tests for agent-notifications.ts — lost-lead appointment guard
 *
 * Verifies that createHeadsUpNotification and escalateNotification
 * never create GHL appointments/tasks for lost or disqualified leads.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock all GHL calls so no real API requests are made ──────────────────────
vi.mock("./ghl", () => ({
  createAppointment: vi.fn().mockResolvedValue({ id: "appt-123" }),
  updateAppointment: vi.fn().mockResolvedValue({}),
  createTask: vi.fn().mockResolvedValue({ task: { id: "task-456" } }),
  updateTask: vi.fn().mockResolvedValue({}),
  addNote: vi.fn().mockResolvedValue({}),
  getNextBusinessHoursSlot: vi.fn().mockReturnValue({
    start: new Date("2026-04-14T13:00:00.000Z"),
  }),
  toETOffsetString: vi.fn((d: Date) => d.toISOString()),
  AGENT_CALENDAR_IDS: { "Abby Bouwer": "cal-abc" },
  AGENT_GHL_USER_IDS: { "Abby Bouwer": "user-abc" },
}));

vi.mock("./db", () => ({
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
  getConversationHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock("./webhook-helpers", () => ({
  SALES_AGENTS: ["Abby Bouwer"],
}));

import { createHeadsUpNotification, escalateNotification } from "./agent-notifications";
import { createAppointment, createTask } from "./ghl";

const BASE_CTX = {
  leadId: 99,
  ghlContactId: "ghl-contact-99",
  leadName: "Test Lead",
  businessName: "Test Biz",
  email: "test@example.com",
  phone: "555-0000",
  assignedAgent: "Abby Bouwer",
  pipelineValue: 500,
  channel: "SMS",
  existingAppointmentId: null,
  existingTaskId: null,
};

describe("agent-notifications — lost-lead guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── createHeadsUpNotification ────────────────────────────────────────────

  it("creates appointment for active lead (no pipelineStage set)", async () => {
    const result = await createHeadsUpNotification(BASE_CTX, "New inquiry");
    expect(createAppointment).toHaveBeenCalledTimes(1);
    expect(result.actions.some(a => a.includes("Created heads-up appointment"))).toBe(true);
  });

  it("creates appointment for lead in new_lead stage", async () => {
    const result = await createHeadsUpNotification({ ...BASE_CTX, pipelineStage: "new_lead" }, "New inquiry");
    expect(createAppointment).toHaveBeenCalledTimes(1);
    expect(result.actions.some(a => a.includes("Created heads-up appointment"))).toBe(true);
  });

  it("BLOCKS appointment for lead in 'Lost' stage (GHL capital-L)", async () => {
    const result = await createHeadsUpNotification({ ...BASE_CTX, pipelineStage: "Lost" }, "Inbound reply");
    expect(createAppointment).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(result.actions[0]).toContain("Skipped");
    expect(result.appointmentId).toBeNull();
    expect(result.taskId).toBeNull();
  });

  it("BLOCKS appointment for lead in 'not_qualified' stage", async () => {
    const result = await createHeadsUpNotification({ ...BASE_CTX, pipelineStage: "not_qualified" }, "Inbound reply");
    expect(createAppointment).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(result.actions[0]).toContain("Skipped");
  });

  it("BLOCKS appointment for lead in 'dnc' stage", async () => {
    const result = await createHeadsUpNotification({ ...BASE_CTX, pipelineStage: "dnc" }, "Inbound reply");
    expect(createAppointment).not.toHaveBeenCalled();
    expect(result.actions[0]).toContain("Skipped");
  });

  it("BLOCKS appointment for lead in 'competitor_won' stage", async () => {
    const result = await createHeadsUpNotification({ ...BASE_CTX, pipelineStage: "competitor_won" }, "Inbound reply");
    expect(createAppointment).not.toHaveBeenCalled();
    expect(result.actions[0]).toContain("Skipped");
  });

  it("BLOCKS appointment for 'LOST' uppercase variant", async () => {
    const result = await createHeadsUpNotification({ ...BASE_CTX, pipelineStage: "LOST" }, "Inbound reply");
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("skips creation when both appointment and task already exist (idempotent)", async () => {
    const result = await createHeadsUpNotification(
      { ...BASE_CTX, existingAppointmentId: "appt-existing", existingTaskId: "task-existing" },
      "New inquiry"
    );
    expect(createAppointment).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(result.actions[0]).toContain("already exists");
  });

  // ── escalateNotification ─────────────────────────────────────────────────

  it("BLOCKS escalation for lead in 'Lost' stage", async () => {
    const result = await escalateNotification(
      { ...BASE_CTX, pipelineStage: "Lost" },
      "human_handoff",
      "Test reason"
    );
    expect(createAppointment).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(result.actions[0]).toContain("Skipped escalation");
  });

  it("BLOCKS escalation for lead in 'not_qualified' stage", async () => {
    const result = await escalateNotification(
      { ...BASE_CTX, pipelineStage: "not_qualified" },
      "committed",
      "Test reason"
    );
    expect(createAppointment).not.toHaveBeenCalled();
    expect(result.actions[0]).toContain("Skipped escalation");
  });

  it("allows escalation for active lead", async () => {
    const result = await escalateNotification(
      { ...BASE_CTX, pipelineStage: "engaged" },
      "human_handoff",
      "Needs live quote"
    );
    // No existing appointment → should create one
    expect(createAppointment).toHaveBeenCalledTimes(1);
    expect(result.actions.some(a => a.includes("Created escalation appointment"))).toBe(true);
  });
});
