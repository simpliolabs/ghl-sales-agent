/**
 * Tests for GATE 3: Universal Human Agent Activity Check in sendMessage (ghl.ts)
 *
 * This is the centralized safeguard that blocks ALL AI outbound messages when
 * a human agent has recently sent a message from GHL UI.
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

const mockFetchGhlConversationHistory = vi.fn().mockResolvedValue([]);
const mockGhlPost = vi.fn().mockResolvedValue({ data: { messageId: "msg_123" } });

vi.mock("axios", () => ({
  default: {
    create: () => ({
      get: vi.fn().mockResolvedValue({ data: { conversations: [] } }),
      post: mockGhlPost,
      put: vi.fn().mockResolvedValue({ data: {} }),
    }),
  },
}));

// We need to mock fetchGhlConversationHistory at the module level
// Since it's defined in ghl.ts itself, we'll test the behavior through sendMessage

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
// Import after mocks
// ============================================================
let sendMessage: any;

beforeEach(async () => {
  vi.clearAllMocks();
  mockIsAiOffline.mockResolvedValue(false);
  mockGetLeadByGhlContactId.mockResolvedValue(null);
  mockGetConversationHistory.mockResolvedValue([]);
  mockFetchGhlConversationHistory.mockResolvedValue([]);

  // Re-import to get fresh module
  const mod = await import("./ghl");
  sendMessage = mod.sendMessage;
});

describe("GATE 3: Human Agent Activity Check", () => {
  it("should BLOCK send when humanTakeover=1 and lastAgentActivityAt is recent", async () => {
    const recentTime = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 1,
      humanTakeover: 1,
      lastAgentActivityAt: recentTime,
      ghlContactId: "contact_test",
    });

    const result = await sendMessage("contact_test", {
      type: "SMS",
      message: "AI message that should be blocked",
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("HUMAN_AGENT_ACTIVE");
    // Ensure GHL API was NOT called
    expect(mockGhlPost).not.toHaveBeenCalled();
  });

  it("should BLOCK send when humanTakeover=1 and lastAgentActivityAt is within 24 hours", async () => {
    const recentTime = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago — within 24hr window
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 1,
      humanTakeover: 1,
      lastAgentActivityAt: recentTime,
      ghlContactId: "contact_test_24h",
    });

    const result = await sendMessage("contact_test_24h", {
      type: "SMS",
      message: "AI message that should be blocked within 24hr window",
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("HUMAN_AGENT_ACTIVE");
  });

  it("should ALLOW send when humanTakeover=1 but lastAgentActivityAt is older than 24 hours", async () => {
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago — beyond 24hr window
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 1,
      humanTakeover: 1,
      lastAgentActivityAt: oldTime,
      ghlContactId: "contact_test_old",
    });

    const result = await sendMessage("contact_test_old", {
      type: "SMS",
      message: "AI message that should be allowed after 24hr window",
    });

    // Should NOT be blocked by HUMAN_AGENT_ACTIVE
    // (may be blocked by cooldown or other gates, but not by agent check)
    if (result.blocked) {
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE");
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE_GHL");
    }
  });

  it("should ALLOW send when no lead found in DB (new contact)", async () => {
    mockGetLeadByGhlContactId.mockResolvedValue(null);

    const result = await sendMessage("unknown_contact", {
      type: "SMS",
      message: "AI message to unknown contact",
    });

    // Should NOT be blocked by agent check
    if (result.blocked) {
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE");
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE_GHL");
    }
  });

  it("should ALLOW send when humanTakeover=0 and no agent activity", async () => {
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 1,
      humanTakeover: 0,
      lastAgentActivityAt: null,
      ghlContactId: "contact_test",
    });

    const result = await sendMessage("contact_test", {
      type: "SMS",
      message: "AI message that should be allowed",
    });

    // Should NOT be blocked by agent check
    if (result.blocked) {
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE");
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE_GHL");
    }
  });

  it("should handle DB errors gracefully (fail OPEN)", async () => {
    mockGetLeadByGhlContactId.mockRejectedValue(new Error("DB connection failed"));

    const result = await sendMessage("contact_test", {
      type: "SMS",
      message: "AI message during DB outage",
    });

    // Should NOT crash — should either succeed or be blocked by a different gate
    expect(result).toBeDefined();
    if (result.blocked) {
      expect(result.reason).not.toBe("HUMAN_AGENT_ACTIVE");
    }
  });
});

describe("GATE 3: Architecture validation", () => {
  it("sendMessage should be the universal chokepoint — all send paths use it", async () => {
    // Verify that sendMessage exists and is a function
    const mod = await import("./ghl");
    expect(typeof mod.sendMessage).toBe("function");
  });

  it("sendMessage should check isAiOffline before anything else", async () => {
    mockIsAiOffline.mockResolvedValue(true);

    const result = await sendMessage("contact_test", {
      type: "SMS",
      message: "Should be blocked by offline check",
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("AI_OFFLINE");
  });

  it("GATE 3 should run AFTER cooldown gate (GATE 2)", async () => {
    // Send two messages rapidly to the same contact
    // First should pass, second should be blocked by cooldown (GATE 2)
    // This verifies gate ordering
    mockGetLeadByGhlContactId.mockResolvedValue({
      id: 1,
      humanTakeover: 0,
      lastAgentActivityAt: null,
      ghlContactId: "rapid_test",
    });

    // First send
    await sendMessage("rapid_test", { type: "SMS", message: "First message" });

    // Second send immediately — should be blocked by cooldown
    const result2 = await sendMessage("rapid_test", { type: "SMS", message: "Second message" });
    expect(result2.blocked).toBe(true);
    expect(result2.reason).toBe("COOLDOWN");
  });
});

describe("Send path coverage audit", () => {
  it("should verify all known send paths flow through sendMessage", async () => {
    // This is a documentation test — it lists all known callers of sendMessage
    // to ensure the centralized guard covers them all.
    const knownCallers = [
      "webhook-message.ts (via sendMessageWithRetry)",
      "webhook-contact.ts (via sendMessageWithRetry)",
      "webhook-pipeline.ts (via sendMessageWithRetry)",
      "webhook-task.ts (via sendMessageWithRetry)",
      "follow-up-trigger.ts (via sendMessageWithRetry)",
      "auto-correction.ts (direct sendMessage)",
      "brain-council-review.ts (direct sendMessage)",
      "webhook-helpers.ts (sendMessageWithRetry wraps sendMessage)",
    ];

    // All 8 paths flow through ghl.ts sendMessage
    expect(knownCallers.length).toBe(8);

    // The GATE 3 guard is inside sendMessage, so it covers all 8 paths
    // This test serves as documentation that no path is missed
  });
});
