import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("./db", () => ({
  getLeadById: vi.fn(),
  insertQuote: vi.fn().mockResolvedValue(undefined),
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
  getQuotesByLead: vi.fn(),
  updateQuoteStatus: vi.fn(),
  getConversationHistory: vi.fn().mockResolvedValue([]),
  getLeadMemory: vi.fn().mockResolvedValue(null),
  getAiState: vi.fn().mockResolvedValue(null),
  getActivePromptVersion: vi.fn().mockResolvedValue({ id: 1, promptKey: "v3.0", abTrafficPercent: 100 }),
}));

vi.mock("./ghl", () => ({
  createAppointment: vi.fn().mockResolvedValue({ id: "appt_123" }),
  getNextBusinessHoursSlot: vi.fn().mockReturnValue({
    start: new Date("2026-05-19T13:30:00.000Z"),
    end: new Date("2026-05-19T13:40:00.000Z"),
  }),
  getCalendarEvents: vi.fn().mockResolvedValue([]),
  AGENT_CALENDAR_IDS: {
    "Abby Bouwer": "cal_abby",
    "Chris McHendry": "cal_chris",
  },
  toETOffsetString: vi.fn().mockImplementation((d: Date) => d.toISOString()),
}));

vi.mock("./pricing-engine", () => ({
  getQuote: vi.fn().mockReturnValue({
    product: "custom_tshirt",
    productName: "Custom T-Shirt",
    qty: 100,
    sides: 1,
    perUnit: 8.5,
    perUnitRange: [7.5, 9.5],
    subtotal: 850,
    rushFee: null,
    setupFee: 50,
    total: 900,
    breakdown: "100 × $8.50 + $50 setup",
    callForQuote: false,
  }),
}));

vi.mock("./output-guards", () => ({
  runOutputGuards: vi.fn().mockReturnValue({
    passed: true,
    blocked: false,
    violations: [],
    correctedDecision: null,
  }),
}));

vi.mock("../server/_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [{
      message: {
        content: JSON.stringify({
          message: "Here's your quote for 100 custom t-shirts!",
          channel: "SMS",
          nextFollowUpHours: 48,
          pipelineAction: null,
          routeToHuman: false,
          routeReason: null,
          confidence: 85,
        }),
        tool_calls: null,
      },
      finish_reason: "stop",
    }],
  }),
}));

vi.mock("./lead-memory", () => ({
  getConversationHistory: vi.fn().mockResolvedValue([]),
  getLeadMemory: vi.fn().mockResolvedValue(null),
}));

vi.mock("./fine-tuning-pipeline", () => ({
  selectModel: vi.fn().mockReturnValue("gpt-4o-mini"),
}));

vi.mock("../shared/sales-training", () => ({
  BRAND_VOICE_GUIDE: "Be friendly and professional.",
  ESCALATION_RULES: "Escalate if angry.",
  COMPETITIVE_INTEL: "We are the best.",
  SEASONAL_CALENDAR: "Summer is busy.",
  PERSONA_PLAYBOOKS: {},
  DNC_PATTERNS: [],
  SYSTEM_PROMPT_FRAGMENTS: [],
  getPersonaGuidance: vi.fn().mockReturnValue("Treat this lead as a small business owner."),
}));

vi.mock("../shared/stage-behavior.json", () => ({
  default: {
    new: { objective: "Qualify the lead", signals_to_ask_for: [], avoid: [] },
    quote_given: { objective: "Follow up on quote", signals_to_ask_for: [], avoid: [] },
    appointment_scheduled: { objective: "Confirm appointment", signals_to_ask_for: [], avoid: [] },
  },
}));

import { getLeadById, insertQuote, updateLeadFields } from "./db";
import { createAppointment, getNextBusinessHoursSlot, getCalendarEvents } from "./ghl";
import { getQuote } from "./pricing-engine";

describe("Phase 4: Quote Persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getLeadById as any).mockResolvedValue({
      id: 1,
      ghlContactId: "contact_abc",
      name: "John Smith",
      businessName: "Acme Corp",
      assignedAgent: "Abby Bouwer",
      pipelineStage: "quote_given",
      email: "john@acme.com",
      phone: "555-1234",
      channel: "SMS",
    });
  });

  it("should persist quote to DB when getQuote tool is called", async () => {
    // Import the module fresh to get the executeTool function
    const { runSingleBrain } = await import("./single-brain");
    const { invokeLLM } = await import("..//server/_core/llm");

    // Mock LLM to call getQuote tool first, then return final message
    (invokeLLM as any)
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              function: {
                name: "getQuote",
                arguments: JSON.stringify({ qty: 100, sides: 1, product: "custom_tshirt", rush: false }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              message: "Here's your quote: 100 custom t-shirts at $8.50 each = $900 total.",
              channel: "SMS",
              nextFollowUpHours: 48,
              pipelineAction: null,
              routeToHuman: false,
              routeReason: null,
              confidence: 90,
            }),
            tool_calls: null,
          },
          finish_reason: "stop",
        }],
      });

    const result = await runSingleBrain({
      leadId: 1,
      trigger: "inbound_message",
      inboundMessage: "How much for 100 custom t-shirts?",
      channel: "SMS",
    });

    // Verify quote was persisted
    expect(insertQuote).toHaveBeenCalledOnce();
    const quoteArg = (insertQuote as any).mock.calls[0][0];
    expect(quoteArg.leadId).toBe(1);
    expect(quoteArg.product).toBe("custom_tshirt");
    expect(quoteArg.qty).toBe(100);
    expect(quoteArg.total).toBe(90000); // $900 in cents
    expect(quoteArg.rush).toBe(0);
    expect(quoteArg.status).toBe("sent");
  });

  it("should mark callForQuote status when product needs manual pricing", async () => {
    const { runSingleBrain } = await import("./single-brain");
    const { invokeLLM } = await import("..//server/_core/llm");

    // Override getQuote to return callForQuote
    (getQuote as any).mockReturnValueOnce({
      product: "vehicle_wrap",
      productName: "Vehicle Wrap",
      qty: 1,
      sides: null,
      perUnit: null,
      perUnitRange: null,
      subtotal: null,
      rushFee: null,
      setupFee: 0,
      total: null,
      breakdown: "Custom quote required",
      callForQuote: true,
    });

    (invokeLLM as any)
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              function: {
                name: "getQuote",
                arguments: JSON.stringify({ qty: 1, sides: 1, product: "vehicle_wrap", rush: false }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              message: "Vehicle wraps need a custom quote. Let me connect you with our team.",
              channel: "SMS",
              nextFollowUpHours: 24,
              pipelineAction: null,
              routeToHuman: true,
              routeReason: "Custom pricing needed",
              confidence: 90,
            }),
            tool_calls: null,
          },
          finish_reason: "stop",
        }],
      });

    await runSingleBrain({
      leadId: 1,
      trigger: "inbound_message",
      inboundMessage: "How much for a vehicle wrap?",
      channel: "SMS",
    });

    expect(insertQuote).toHaveBeenCalledOnce();
    const quoteArg = (insertQuote as any).mock.calls[0][0];
    expect(quoteArg.status).toBe("call_for_quote");
    expect(quoteArg.callForQuote).toBe(1);
    expect(quoteArg.total).toBeNull();
  });
});

describe("Phase 4: Appointment Booking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getLeadById as any).mockResolvedValue({
      id: 1,
      ghlContactId: "contact_abc",
      name: "John Smith",
      businessName: "Acme Corp",
      assignedAgent: "Abby Bouwer",
      pipelineStage: "quote_given",
      email: "john@acme.com",
      phone: "555-1234",
      channel: "SMS",
    });
  });

  it("should book appointment and update lead stage when bookAppointment tool is called", async () => {
    const { runSingleBrain } = await import("./single-brain");
    const { invokeLLM } = await import("..//server/_core/llm");

    (invokeLLM as any)
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              function: {
                name: "bookAppointment",
                arguments: JSON.stringify({ title: "T-shirt order consultation", notes: "Wants 100 custom tees" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              message: "I've booked a consultation for you on Monday at 9:30 AM ET!",
              channel: "SMS",
              nextFollowUpHours: 24,
              pipelineAction: null,
              routeToHuman: false,
              routeReason: null,
              confidence: 95,
            }),
            tool_calls: null,
          },
          finish_reason: "stop",
        }],
      });

    const result = await runSingleBrain({
      leadId: 1,
      trigger: "inbound_message",
      inboundMessage: "Can I schedule a call to discuss the order?",
      channel: "SMS",
    });

    // Verify appointment was created
    expect(createAppointment).toHaveBeenCalledOnce();
    const apptArg = (createAppointment as any).mock.calls[0][0];
    expect(apptArg.contactId).toBe("contact_abc");
    expect(apptArg.title).toBe("T-shirt order consultation");

    // Verify lead stage was updated
    expect(updateLeadFields).toHaveBeenCalledWith(1, { pipelineStage: "appointment_scheduled" });

    // Verify tool log contains the booking result
    expect(result.toolLog).toHaveLength(1);
    expect(result.toolLog[0].name).toBe("bookAppointment");
    expect(result.toolLog[0].result.booked).toBe(true);
    expect(result.toolLog[0].result.appointmentId).toBe("appt_123");
  });

  it("should check calendar availability and skip occupied slots", async () => {
    const { runSingleBrain } = await import("./single-brain");
    const { invokeLLM } = await import("..//server/_core/llm");

    // First slot is occupied, second is free
    (getCalendarEvents as any)
      .mockResolvedValueOnce([{ id: "existing_1", startTime: "2026-05-19T13:30:00Z", endTime: "2026-05-19T13:40:00Z" }])
      .mockResolvedValueOnce([]);

    (invokeLLM as any)
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              function: {
                name: "bookAppointment",
                arguments: JSON.stringify({}),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              message: "Booked!",
              channel: "SMS",
              nextFollowUpHours: 24,
              pipelineAction: null,
              routeToHuman: false,
              routeReason: null,
              confidence: 95,
            }),
            tool_calls: null,
          },
          finish_reason: "stop",
        }],
      });

    await runSingleBrain({
      leadId: 1,
      trigger: "inbound_message",
      inboundMessage: "Let's schedule a call",
      channel: "SMS",
    });

    // Should have checked calendar twice (first occupied, second free)
    expect(getCalendarEvents).toHaveBeenCalledTimes(2);
    // Should have advanced the slot pointer
    expect(getNextBusinessHoursSlot).toHaveBeenCalledTimes(2);
  });

  it("should return error when lead has no GHL contact ID", async () => {
    const { runSingleBrain } = await import("./single-brain");
    const { invokeLLM } = await import("..//server/_core/llm");

    (getLeadById as any).mockResolvedValue({
      id: 2,
      ghlContactId: null,
      name: "No Contact",
      businessName: null,
      assignedAgent: null,
      pipelineStage: "new",
      email: null,
      phone: null,
      channel: "SMS",
    });

    (invokeLLM as any)
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              function: {
                name: "bookAppointment",
                arguments: JSON.stringify({}),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              message: "I wasn't able to book that appointment. Let me connect you with our team.",
              channel: "SMS",
              nextFollowUpHours: 24,
              pipelineAction: null,
              routeToHuman: true,
              routeReason: "Booking failed",
              confidence: 80,
            }),
            tool_calls: null,
          },
          finish_reason: "stop",
        }],
      });

    const result = await runSingleBrain({
      leadId: 2,
      trigger: "inbound_message",
      inboundMessage: "Schedule a call",
      channel: "SMS",
    });

    // Should NOT have called createAppointment
    expect(createAppointment).not.toHaveBeenCalled();
    // Tool result should contain error
    expect(result.toolLog[0].result.error).toContain("no GHL contact ID");
  });

  it("should use lead's assigned agent for calendar selection", async () => {
    const { runSingleBrain } = await import("./single-brain");
    const { invokeLLM } = await import("..//server/_core/llm");

    (getLeadById as any).mockResolvedValue({
      id: 3,
      ghlContactId: "contact_xyz",
      name: "Jane Doe",
      businessName: "Jane's Bakery",
      assignedAgent: "Chris McHendry",
      pipelineStage: "quote_given",
      email: "jane@bakery.com",
      phone: "555-5678",
      channel: "SMS",
    });

    (invokeLLM as any)
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              function: {
                name: "bookAppointment",
                arguments: JSON.stringify({}),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              message: "Booked with Chris!",
              channel: "SMS",
              nextFollowUpHours: 24,
              pipelineAction: null,
              routeToHuman: false,
              routeReason: null,
              confidence: 95,
            }),
            tool_calls: null,
          },
          finish_reason: "stop",
        }],
      });

    await runSingleBrain({
      leadId: 3,
      trigger: "inbound_message",
      inboundMessage: "Book a call",
      channel: "SMS",
    });

    // Should use Chris's calendar
    expect(getNextBusinessHoursSlot).toHaveBeenCalledWith(expect.any(Date), "Chris McHendry");
    const apptArg = (createAppointment as any).mock.calls[0][0];
    expect(apptArg.calendarId).toBe("cal_chris");
  });
});
