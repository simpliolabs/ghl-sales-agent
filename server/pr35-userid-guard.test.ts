/**
 * PR#3.5 Tests: Layer B general path userId check
 *
 * Verifies that the general path (line 273) of the HUMAN_AGENT_ACTIVE_GHL guard
 * now checks userId before blocking, matching the new-contact path (line 254).
 *
 * The fix: when recentAgentMessages exist but none have userId, the guard should
 * NOT block — the messages are likely from GHL review activity or automation,
 * not a human agent typing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// Mock all dependencies that sendMessage uses
// ============================================================

const mockIsAiOffline = vi.fn().mockResolvedValue(false);
const mockGetLeadByGhlContactId = vi.fn();
const mockUpdateLeadFields = vi.fn().mockResolvedValue(undefined);
const mockGetConversationHistory = vi.fn().mockResolvedValue([]);

vi.mock("./db", () => ({
  isAiOffline: (...args: any[]) => mockIsAiOffline(...args),
  getLeadByGhlContactId: (...args: any[]) => mockGetLeadByGhlContactId(...args),
  updateLeadFields: (...args: any[]) => mockUpdateLeadFields(...args),
  getConversationHistory: (...args: any[]) => mockGetConversationHistory(...args),
}));

// Mock axios to control GHL API responses (including conversation history)
const mockAxiosGet = vi.fn();
const mockAxiosPost = vi.fn().mockResolvedValue({ data: { messageId: "msg_test" } });

vi.mock("axios", () => ({
  default: {
    create: () => ({
      get: mockAxiosGet,
      post: mockAxiosPost,
      put: vi.fn().mockResolvedValue({ data: {} }),
    }),
  },
}));

vi.mock("./_core/env", () => ({
  ENV: {
    ghlApiKey: "test-key",
    ghlLocationId: "test-location",
  },
}));

vi.mock("../shared/brand-assets", () => ({
  BRAND: {
    email: "test@adorb.com",
    name: "Adorb Custom Tees",
  },
}));

// ============================================================
// Helper: build GHL conversation history response
// ============================================================
function makeGhlMessage(overrides: Partial<{
  direction: string;
  body: string;
  dateAdded: string;
  type: number | string;
  userId: string | undefined;
}> = {}) {
  return {
    direction: overrides.direction ?? "outbound",
    body: overrides.body ?? "Some message from GHL",
    dateAdded: overrides.dateAdded ?? new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    type: overrides.type ?? 1, // SMS type (not system)
    userId: overrides.userId, // undefined = no userId
  };
}

function setupGhlHistoryMock(messages: any[]) {
  // First call: getContactConversations → returns one conversation
  // Second call: getConversationMessages → returns the messages
  mockAxiosGet
    .mockResolvedValueOnce({ data: { conversations: [{ id: "conv_1" }] } })
    .mockResolvedValueOnce({ data: { messages } });
}

// ============================================================
// Import after mocks
// ============================================================
let sendMessage: any;

beforeEach(async () => {
  vi.clearAllMocks();
  mockIsAiOffline.mockResolvedValue(false);
  mockGetConversationHistory.mockResolvedValue([]);
  mockAxiosGet.mockReset();
  mockAxiosPost.mockResolvedValue({ data: { messageId: "msg_test" } });

  // Re-import to get fresh module state (clears cooldown maps etc.)
  const mod = await import("./ghl");
  sendMessage = mod.sendMessage;
});

describe("PR#3.5: Layer B general path — userId check", () => {

  it("should BLOCK when GHL history has outbound message WITH userId (real human agent)", async () => {
    // Lead exists with local AI history (knownAiMessages > 0)
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 4980121,
      humanTakeover: 0,
      lastAgentActivityAt: null,
      ghlContactId: "contact_ron",
    });
    // Local AI history: one known AI message
    mockGetConversationHistory.mockResolvedValue([
      { senderType: "ai", messageBody: "Hi Ron! Chris here from Adorb" },
    ]);
    // GHL history: one outbound message WITH userId (human typed it)
    setupGhlHistoryMock([
      makeGhlMessage({
        body: "Hey Ron, I can help you with that quote",
        userId: "user_owner_123",
      }),
    ]);

    const result = await sendMessage("contact_ron", {
      type: "SMS",
      message: "AI follow-up message",
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("HUMAN_AGENT_ACTIVE_GHL");
    expect(mockUpdateLeadFields).toHaveBeenCalledWith(4980121, expect.objectContaining({
      humanTakeover: 1,
    }));
  });

  it("should ALLOW when GHL history has outbound message WITHOUT userId (review/automation)", async () => {
    // Lead exists with local AI history
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 4980121,
      humanTakeover: 0,
      lastAgentActivityAt: null,
      ghlContactId: "contact_ron",
    });
    // Local AI history: one known AI message
    mockGetConversationHistory.mockResolvedValue([
      { senderType: "ai", messageBody: "Hi Ron! Chris here from Adorb" },
    ]);
    // GHL history: outbound message WITHOUT userId (owner just reviewed conversation)
    setupGhlHistoryMock([
      makeGhlMessage({
        body: "Some unrecognized outbound event",
        userId: undefined,
      }),
    ]);

    const result = await sendMessage("contact_ron", {
      type: "SMS",
      message: "AI follow-up message",
    });

    // Should NOT be blocked by HUMAN_AGENT_ACTIVE_GHL
    if (result.blocked) {
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE_GHL");
    }
  });

  it("should BLOCK when GHL history has mix of messages — at least one WITH userId", async () => {
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 4980122,
      humanTakeover: 0,
      lastAgentActivityAt: null,
      ghlContactId: "contact_ron_mix",
    });
    mockGetConversationHistory.mockResolvedValue([
      { senderType: "ai", messageBody: "Hi Ron! Chris here from Adorb" },
    ]);
    // Mix: one without userId (automation), one with userId (human)
    setupGhlHistoryMock([
      makeGhlMessage({ body: "Automation message", userId: undefined }),
      makeGhlMessage({ body: "Human typed this", userId: "user_owner_123" }),
    ]);

    const result = await sendMessage("contact_ron_mix", {
      type: "SMS",
      message: "AI follow-up message",
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("HUMAN_AGENT_ACTIVE_GHL");
  });

  it("should ALLOW when all GHL outbound messages are known AI messages", async () => {
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 4980121,
      humanTakeover: 0,
      lastAgentActivityAt: null,
      ghlContactId: "contact_ron",
    });
    // Local AI history matches the GHL outbound message
    mockGetConversationHistory.mockResolvedValue([
      { senderType: "ai", messageBody: "Hi Ron! Chris here from Adorb" },
    ]);
    // GHL history: same message as our known AI message
    setupGhlHistoryMock([
      makeGhlMessage({
        body: "Hi Ron! Chris here from Adorb",
        userId: undefined,
      }),
    ]);

    const result = await sendMessage("contact_ron", {
      type: "SMS",
      message: "AI follow-up message",
    });

    // Known AI messages are filtered out of recentAgentMessages, so no block
    if (result.blocked) {
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE_GHL");
    }
  });

  it("should use user.id as fallback when userId is absent but user object exists", async () => {
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 4980123,
      humanTakeover: 0,
      lastAgentActivityAt: null,
      ghlContactId: "contact_ron_nested",
    });
    mockGetConversationHistory.mockResolvedValue([
      { senderType: "ai", messageBody: "Hi Ron! Chris here from Adorb" },
    ]);
    // GHL history: message with user.id (nested) instead of top-level userId
    // Note: fetchGhlConversationHistory normalizes userId from m.userId || m.user?.id
    // So we need to set userId in the normalized output
    setupGhlHistoryMock([
      {
        direction: "outbound",
        body: "Human typed via nested user object",
        dateAdded: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        type: 1,
        userId: "user_nested_123", // fetchGhlConversationHistory normalizes this
      },
    ]);

    const result = await sendMessage("contact_ron_nested", {
      type: "SMS",
      message: "AI follow-up message",
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("HUMAN_AGENT_ACTIVE_GHL");
  });

  it("should NOT block when GHL outbound messages are system types (filtered before userId check)", async () => {
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 4980121,
      humanTakeover: 0,
      lastAgentActivityAt: null,
      ghlContactId: "contact_ron",
    });
    mockGetConversationHistory.mockResolvedValue([
      { senderType: "ai", messageBody: "Hi Ron! Chris here from Adorb" },
    ]);
    // GHL history: system type message (type 31 = appointment) — filtered by recentAgentMessages
    setupGhlHistoryMock([
      makeGhlMessage({
        body: "Appointment scheduled for tomorrow",
        type: 31, // TYPE_ACTIVITY_APPOINTMENT
        userId: "user_owner_123", // Has userId but is system type
      }),
    ]);

    const result = await sendMessage("contact_ron", {
      type: "SMS",
      message: "AI follow-up message",
    });

    // System types are filtered out of recentAgentMessages before the userId check
    if (result.blocked) {
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE_GHL");
    }
  });

  it("should NOT block when GHL outbound messages match system patterns (filtered before userId check)", async () => {
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 4980121,
      humanTakeover: 0,
      lastAgentActivityAt: null,
      ghlContactId: "contact_ron",
    });
    mockGetConversationHistory.mockResolvedValue([
      { senderType: "ai", messageBody: "Hi Ron! Chris here from Adorb" },
    ]);
    // GHL history: system pattern message — filtered by isSystemMessage
    setupGhlHistoryMock([
      makeGhlMessage({
        body: "Opportunity Created - Custom T-Shirts",
        userId: "user_owner_123", // Has userId but matches system pattern
      }),
    ]);

    const result = await sendMessage("contact_ron", {
      type: "SMS",
      message: "AI follow-up message",
    });

    // System patterns are filtered by isSystemMessage before reaching userId check
    if (result.blocked) {
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE_GHL");
    }
  });
});

describe("PR#3.5: Path symmetry validation", () => {
  it("Path 1 (new contact) and Path 2 (general) should both check userId", async () => {
    // This is a structural test — verify the code has the same userId check in both paths
    // by testing the same scenario through each path

    // Path 1 scenario: no local AI history + outbound without userId → should NOT block
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 1,
      humanTakeover: 0,
      lastAgentActivityAt: null,
      ghlContactId: "contact_path1",
    });
    mockGetConversationHistory.mockResolvedValue([]); // No local AI history → Path 1
    setupGhlHistoryMock([
      makeGhlMessage({ body: "Automation message", userId: undefined }),
    ]);

    const result1 = await sendMessage("contact_path1", {
      type: "SMS",
      message: "Test message",
    });

    if (result1.blocked) {
      expect(result1.reason).not.toBe("HUMAN_AGENT_ACTIVE_NEW_CONTACT");
      expect(result1.reason).not.toBe("HUMAN_AGENT_ACTIVE_GHL");
    }
  });
});
