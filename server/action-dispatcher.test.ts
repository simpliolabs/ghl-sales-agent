/**
 * ACTION DISPATCHER TESTS
 *
 * Tests the centralized state-to-GHL-action mapping.
 * All external dependencies (GHL, DB, channel-fallback) are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StateTransitionResult } from "./conversation-state";
import type { IntentResult } from "./intent-classifier";
import type { DispatchContext, DispatchResult } from "./action-dispatcher";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("./db", () => ({
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
  addConversation: vi.fn().mockResolvedValue(undefined),
  getLeadById: vi.fn().mockResolvedValue({
    id: 1, name: "Test Lead", email: "test@example.com", phone: "+1234567890",
    dndSms: 0, dndEmail: 0, dndFb: 0, dndWhatsapp: 0, dndGmb: 0,
  }),
}));

vi.mock("./ghl", () => ({
  createTask: vi.fn().mockResolvedValue({ id: "task_123" }),
  addNote: vi.fn().mockResolvedValue(undefined),
  updateOpportunityStage: vi.fn().mockResolvedValue(undefined),
  getOpportunitiesByContact: vi.fn().mockResolvedValue([]),
}));

vi.mock("./agent-notifications", () => ({
  escalateNotification: vi.fn().mockResolvedValue({
    actions: ["Updated appointment to: Close deal", "Updated task to: Close deal", "Added escalation note to GHL"],
    errors: [],
    appointmentId: "appt_123",
    taskId: "task_123",
  }),
  createHeadsUpNotification: vi.fn().mockResolvedValue({
    actions: ["Created heads-up appointment", "Created heads-up task", "Added heads-up note to GHL"],
    errors: [],
    appointmentId: "appt_123",
    taskId: "task_123",
  }),
}));

vi.mock("./channel-fallback", () => ({
  handleChannelDnc: vi.fn().mockResolvedValue({
    action: "escalated",
    blockedChannel: "SMS",
    nextChannel: "Email",
    allChannelsExhausted: false,
  }),
  allChannelsExhausted: vi.fn().mockReturnValue(false),
  detectDncChannel: vi.fn().mockReturnValue("SMS"),
}));

vi.mock("./scheduling-engine", () => ({
  calculateNextFollowUp: vi.fn().mockResolvedValue({
    nextFollowUpAt: new Date("2026-04-15"),
    cadencePosition: 1,
    reason: "Post-commitment follow-up in 2 days",
  }),
}));

vi.mock("../shared/ghl-stages", () => ({
  getNqStageId: vi.fn((pipelineId: string) => {
    const map: Record<string, string> = {
      "OpojlMx3cTa0ts0e2pMc": "6f1ca442-4a6b-490f-bf49-95a5870f7f86",
    };
    return map[pipelineId] || null;
  }),
  getQualifiedStageId: vi.fn((pipelineId: string) => {
    const map: Record<string, string> = {
      "OpojlMx3cTa0ts0e2pMc": "dee13ae5-1db8-45aa-9f4a-33a6b271cb94",
      "5YIrCvKmzb27yXHP3fBF": "45c2fc05-fe5f-4427-9523-f0f8ae000a39",
    };
    return map[pipelineId] || null;
  }),
  getDeliveredStageId: vi.fn((pipelineId: string) => {
    const map: Record<string, string> = {
      "OpojlMx3cTa0ts0e2pMc": "117d9332-7654-42bc-92de-829ae3be6337",
      "5YIrCvKmzb27yXHP3fBF": "b3bec5e2-0b24-41fd-bbbc-fcf37b073e78",
    };
    return map[pipelineId] || null;
  }),
  NOT_QUALIFIED_STAGE_IDS: {
    "OpojlMx3cTa0ts0e2pMc": "6f1ca442-4a6b-490f-bf49-95a5870f7f86",
    "5YIrCvKmzb27yXHP3fBF": "6ca358e4-db09-4818-9896-ab21bad0c0e7",
  },
  CONTACTED_STAGE_IDS: {
    "OpojlMx3cTa0ts0e2pMc": "6dbcb373-9832-4c45-a5e6-176f92685f67",
    "5YIrCvKmzb27yXHP3fBF": "6501f3bf-b2a9-4c0f-935f-fc8441f6deb0",
  },
  NEW_LEAD_STAGE_IDS: new Set([
    "69534612-6905-413a-a3b9-3c3de2365a6a",
    "a54400ac-e9df-44e2-8872-45ccccf9a442",
  ]),
}));

vi.mock("./webhook-helpers", () => ({
  STAGES: {
    NEW_LEAD: "New Lead", CONTACTED: "Contacted", QUALIFIED: "Qualified",
    QUOTE_SENT: "Quote Sent", PAID_PROOF_NEEDED: "Paid - Proof Needed",
    PROOF_SENT: "Proof Sent", APPROVED: "Approved + Deposit",
    IN_PRODUCTION: "In Production", READY: "Ready", DELIVERED: "Delivered",
  },
  SALES_AGENTS: ["Abby Bouwer", "Chris McHendry"],
  DESIGNER: "César Vásquez",
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeIntent(overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    intent: "confirmation",
    confidence: 90,
    reasoning: "Customer confirmed order details",
    closingSignal: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeTransition(
  from: string,
  to: string,
  intent?: Partial<IntentResult>,
  reason = "Test transition",
): StateTransitionResult {
  return {
    previousState: from as any,
    newState: to as any,
    intent: makeIntent(intent),
    transitionReason: reason,
    changed: true,
  };
}

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    leadId: 1,
    ghlContactId: "contact_123",
    leadName: "Paulette",
    businessName: "Paulette's Boutique",
    email: "paulette@example.com",
    phone: "+1234567890",
    assignedAgent: "Abby Bouwer",
    pipelineValue: 500,
    ghlOpportunityId: "opp_123",
    ghlPipelineId: "OpojlMx3cTa0ts0e2pMc",
    channel: "SMS",
    pipelineStage: null,
    existingAppointmentId: "appt_existing",
    existingTaskId: "task_existing",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Action Dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("dispatchStateActions", () => {
    it("skips dispatch when state has not changed", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const result = await dispatchStateActions(
        { ...makeTransition("exploring", "exploring"), changed: false },
        makeCtx(),
      );
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("No state change");
      expect(result.actionsExecuted).toHaveLength(0);
    });

    it("dispatches committed \u2192 escalates existing appointment/task via agent-notifications", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { escalateNotification } = await import("./agent-notifications");

      const result = await dispatchStateActions(
        makeTransition("interested", "committed", { intent: "thank_you_close", closingSignal: true }),
        makeCtx(),
      );

      expect(result.skipped).toBe(false);
      expect(result.actionsExecuted.length).toBeGreaterThan(0);
      // Verify escalateNotification was called with "committed" type
      expect(escalateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: 1,
          ghlContactId: "contact_123",
          existingAppointmentId: "appt_existing",
          existingTaskId: "task_existing",
        }),
        "committed",
        expect.stringContaining("committed"),
        expect.objectContaining({ intent: "thank_you_close" }),
      );
    });

    it("dispatches committed \u2192 escalates notification (which adds note internally)", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { escalateNotification } = await import("./agent-notifications");

      await dispatchStateActions(
        makeTransition("interested", "committed"),
        makeCtx(),
      );

      // Note is now added inside escalateNotification (mocked), not directly via addNote
      expect(escalateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ ghlContactId: "contact_123" }),
        "committed",
        expect.any(String),
        expect.any(Object),
      );
    });

    it("dispatches committed → schedules follow-up", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { updateLeadFields } = await import("./db");

      await dispatchStateActions(
        makeTransition("interested", "committed"),
        makeCtx(),
      );

      expect(updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        nextFollowUpAt: expect.any(Date),
      }));
    });

    it("dispatches interested \u2192 adds note only (no new tasks — heads-up already exists)", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { addNote } = await import("./ghl");
      const { createTask } = await import("./ghl");

      const result = await dispatchStateActions(
        makeTransition("new_lead", "interested", { intent: "price_inquiry" }),
        makeCtx(),
      );

      expect(result.skipped).toBe(false);
      // No new tasks created — heads-up was created on first contact
      expect(createTask).not.toHaveBeenCalled();
      // But a note should be added
      expect(addNote).toHaveBeenCalledWith("contact_123", expect.stringContaining("INTERESTED"));
    });    it("dispatches interested → skips if coming from committed (already past interested)", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { createTask } = await import("./ghl");

      const result = await dispatchStateActions(
        makeTransition("committed", "interested"),
        makeCtx(),
      );

      expect(result.skipped).toBe(true);
      expect(createTask).not.toHaveBeenCalled();
    });

    it("dispatches dnc_channel → calls handleChannelDnc", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { handleChannelDnc } = await import("./channel-fallback");

      const result = await dispatchStateActions(
        makeTransition("exploring", "dnc_channel", { intent: "dnc" }),
        makeCtx(),
      );

      expect(result.skipped).toBe(false);
      expect(handleChannelDnc).toHaveBeenCalled();
      expect(result.actionsExecuted.some(a => a.includes("Channel DNC"))).toBe(true);
    });

    it("dispatches dnc_all → moves to Not Qualified", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { updateLeadFields } = await import("./db");
      const { updateOpportunityStage } = await import("./ghl");

      const result = await dispatchStateActions(
        makeTransition("dnc_channel", "dnc_all", { intent: "dnc" }),
        makeCtx(),
      );

      expect(result.skipped).toBe(false);
      expect(updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        pipelineStage: "not_qualified",
        humanTakeover: 1,
      }));
      expect(updateOpportunityStage).toHaveBeenCalledWith("opp_123", "6f1ca442-4a6b-490f-bf49-95a5870f7f86");
    });

    it("dispatches dnc_all → handles missing pipeline ID gracefully", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { updateOpportunityStage } = await import("./ghl");

      const result = await dispatchStateActions(
        makeTransition("dnc_channel", "dnc_all"),
        makeCtx({ ghlPipelineId: null, ghlOpportunityId: null }),
      );

      expect(result.skipped).toBe(false);
      expect(updateOpportunityStage).not.toHaveBeenCalled();
    });

    it("dispatches fulfilled → schedules post-delivery follow-up", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { calculateNextFollowUp } = await import("./scheduling-engine");

      const result = await dispatchStateActions(
        makeTransition("committed", "fulfilled"),
        makeCtx(),
      );

      expect(result.skipped).toBe(false);
      expect(calculateNextFollowUp).toHaveBeenCalledWith(expect.objectContaining({
        triggerEvent: "stage_change",
        stageTransition: "Delivered",
      }));
    });

    it("dispatches human_active \u2192 sets humanTakeover=1 and escalates notification", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { updateLeadFields } = await import("./db");
      const { escalateNotification } = await import("./agent-notifications");

      const result = await dispatchStateActions(
        makeTransition("exploring", "human_active", undefined, "Agent sent message"),
        makeCtx(),
      );

      expect(result.skipped).toBe(false);
      expect(updateLeadFields).toHaveBeenCalledWith(1, expect.objectContaining({
        humanTakeover: 1,
      }));
      // Verify escalateNotification was called with "human_handoff" type
      expect(escalateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: 1,
          ghlContactId: "contact_123",
        }),
        "human_handoff",
        "Agent sent message",
      );
    });

    it("dispatches objecting → adds GHL note only (no pipeline action)", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");
      const { addNote } = await import("./ghl");
      const { createTask } = await import("./ghl");

      const result = await dispatchStateActions(
        makeTransition("interested", "objecting", { intent: "objection" }),
        makeCtx(),
      );

      expect(result.skipped).toBe(false);
      expect(addNote).toHaveBeenCalledWith("contact_123", expect.stringContaining("OBJECTING"));
      // No task creation for objections
      expect(createTask).not.toHaveBeenCalled();
    });

    it("dispatches exploring → skips (no GHL actions needed)", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");

      const result = await dispatchStateActions(
        makeTransition("new_lead", "exploring"),
        makeCtx(),
      );

      expect(result.skipped).toBe(true);
    });

    it("dispatches stale → skips (handled by disposition sweep)", async () => {
      const { dispatchStateActions } = await import("./action-dispatcher");

      const result = await dispatchStateActions(
        makeTransition("exploring", "stale"),
        makeCtx(),
      );

      expect(result.skipped).toBe(true);
    });
  });

  describe("buildDispatchContext", () => {
    it("builds context from lead row", async () => {
      const { buildDispatchContext } = await import("./action-dispatcher");

      const lead = {
        id: 42,
        ghlContactId: "contact_42",
        name: "Test Lead",
        businessName: "Test Biz",
        email: "test@test.com",
        phone: "+1111111111",
        assignedAgent: "Chris McHendry",
        pipelineValue: 1200,
        ghlOpportunityId: "opp_42",
        ghlPipelineId: "OpojlMx3cTa0ts0e2pMc",
        appointmentId: "appt_42",
        ghlTaskId: "task_42",
      };

      const ctx = buildDispatchContext(lead, "Email");

      expect(ctx.leadId).toBe(42);
      expect(ctx.ghlContactId).toBe("contact_42");
      expect(ctx.leadName).toBe("Test Lead");
      expect(ctx.channel).toBe("Email");
      expect(ctx.pipelineValue).toBe(1200);
    });

    it("handles null/undefined fields gracefully", async () => {
      const { buildDispatchContext } = await import("./action-dispatcher");

      const lead = {
        id: 1,
        ghlContactId: "contact_1",
        name: null,
        businessName: null,
        email: null,
        phone: null,
        assignedAgent: null,
        pipelineValue: undefined,
        ghlOpportunityId: undefined,
        ghlPipelineId: undefined,
      };

      const ctx = buildDispatchContext(lead, "SMS");

      expect(ctx.leadName).toBeNull();
      expect(ctx.pipelineValue).toBeNull();
      expect(ctx.ghlOpportunityId).toBeNull();
      expect(ctx.ghlPipelineId).toBeNull();
    });
  });



  describe("shared/ghl-stages.ts centralization", () => {
    it("exports NOT_QUALIFIED_STAGE_IDS for both pipelines", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("shared/ghl-stages.ts", "utf8");
      expect(src).toContain("OpojlMx3cTa0ts0e2pMc"); // Bulk Printing
      expect(src).toContain("5YIrCvKmzb27yXHP3fBF"); // T-shirt Inquiry
      expect(src).toContain("6f1ca442-4a6b-490f-bf49-95a5870f7f86"); // NQ stage
      expect(src).toContain("6ca358e4-db09-4818-9896-ab21bad0c0e7"); // NQ stage
    });

    it("exports CONTACTED_STAGE_IDS for all 4 pipelines", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("shared/ghl-stages.ts", "utf8");
      expect(src).toContain("CONTACTED_STAGE_IDS");
      expect(src).toContain("6dbcb373-9832-4c45-a5e6-176f92685f67"); // Bulk Printing Contacted
      expect(src).toContain("6501f3bf-b2a9-4c0f-935f-fc8441f6deb0"); // T-shirt Inquiry Contacted
    });

    it("exports getNqStageId helper function", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("shared/ghl-stages.ts", "utf8");
      expect(src).toContain("export function getNqStageId");
      expect(src).toContain("export function getContactedStageId");
    });
  });

  describe("webhook-message.ts integration", () => {
    it("imports and calls dispatchStateActions after state change", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("server/webhook-message.ts", "utf8");
      expect(src).toContain('import { dispatchStateActions, buildDispatchContext } from "./action-dispatcher"');
      expect(src).toContain("dispatchStateActions(stateResult, dispatchCtx)");
      expect(src).toContain("buildDispatchContext(lead!, channel)");
    });

    it("wraps dispatch in try-catch for non-fatal error handling", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("server/webhook-message.ts", "utf8");
      expect(src).toContain("[Webhook/Dispatch] Error for lead");
      expect(src).toContain("(non-fatal)");
    });
  });
});
