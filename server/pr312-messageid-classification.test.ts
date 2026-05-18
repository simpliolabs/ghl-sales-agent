/**
 * PR#3.12 — Phantom conversation prevention + messageId capture
 *
 * Tests:
 * 1. classifySendOutcome returns messageId when GHL provides one
 * 2. classifySendOutcome flags isPhantom=true when GHL returns no messageId
 * 3. classifySendOutcome extracts emailMessageId from GHL response
 * 4. classifySendOutcome handles null/undefined response gracefully
 * 5. sendMessageWithRetry propagates ghlMessageId on normal success
 * 6. sendMessageWithRetry propagates isPhantom=true when GHL returns empty response
 * 7. sendMessageWithRetry propagates ghlMessageId through email fallback path
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ghl.ts before importing
vi.mock("./ghl", () => ({
  sendMessage: vi.fn(),
  fetchGhlConversationHistory: vi.fn().mockResolvedValue([]),
  updateContactCustomField: vi.fn().mockResolvedValue(undefined),
  resolveGhlContactId: vi.fn().mockResolvedValue(null),
}));

// Mock db.ts
vi.mock("./db", () => ({
  getLeadByGhlContactId: vi.fn().mockResolvedValue(null),
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
  addConversation: vi.fn().mockResolvedValue(undefined),
  getAiState: vi.fn().mockResolvedValue(null),
  upsertAiState: vi.fn().mockResolvedValue(undefined),
  checkLeadRateLimit: vi.fn().mockResolvedValue({ limited: false }),
}));

// Mock scheduling-engine
vi.mock("./scheduling-engine", () => ({
  calculateNextFollowUp: vi.fn().mockResolvedValue({ nextFollowUpAt: new Date() }),
  isBusinessHours: vi.fn().mockReturnValue(true),
  isSmsQuietHours: vi.fn().mockReturnValue(false),
  isHumanFeelHours: vi.fn().mockReturnValue(true),
  pushToNextBusinessHour: vi.fn().mockReturnValue(new Date()),
}));

// Mock area-code-timezone
vi.mock("./area-code-timezone", () => ({
  isTcpaQuietHoursForRecipient: vi.fn().mockReturnValue(false),
}));

import { classifySendOutcome, sendMessageWithRetry } from "./webhook-helpers";
import { sendMessage } from "./ghl";

describe("PR#3.12: classifySendOutcome", () => {
  it("returns messageId when GHL provides one", () => {
    const result = classifySendOutcome({ messageId: "msg_abc123", conversationId: "conv_xyz" });
    expect(result.messageId).toBe("msg_abc123");
    expect(result.isPhantom).toBe(false);
  });

  it("flags isPhantom=true when GHL returns no messageId", () => {
    const result = classifySendOutcome({ conversationId: "conv_xyz", status: "ok" });
    expect(result.messageId).toBeUndefined();
    expect(result.isPhantom).toBe(true);
  });

  it("extracts emailMessageId from GHL response", () => {
    const result = classifySendOutcome({ messageId: "msg_abc", emailMessageId: "email_def" });
    expect(result.emailMessageId).toBe("email_def");
    expect(result.messageId).toBe("msg_abc");
    expect(result.isPhantom).toBe(false);
  });

  it("handles null/undefined response gracefully", () => {
    const result1 = classifySendOutcome(null);
    expect(result1.isPhantom).toBe(true);
    expect(result1.messageId).toBeUndefined();

    const result2 = classifySendOutcome(undefined);
    expect(result2.isPhantom).toBe(true);
    expect(result2.messageId).toBeUndefined();
  });
});

describe("PR#3.12: sendMessageWithRetry messageId propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates ghlMessageId on normal success", async () => {
    (sendMessage as any).mockResolvedValueOnce({ messageId: "msg_real_123", conversationId: "conv_1" });

    const result = await sendMessageWithRetry(
      "contact_1",
      { type: "SMS", message: "Hello" },
      { email: "test@test.com", phone: "+15551234567", id: 1 }
    );

    expect(result.success).toBe(true);
    expect(result.ghlMessageId).toBe("msg_real_123");
    expect(result.isPhantom).toBe(false);
  });

  it("propagates isPhantom=true when GHL returns empty response", async () => {
    // GHL returns 200 but with no messageId — the phantom scenario
    (sendMessage as any).mockResolvedValueOnce({ conversationId: "conv_1", status: "sent" });

    const result = await sendMessageWithRetry(
      "contact_1",
      { type: "SMS", message: "Hello" },
      { email: "test@test.com", phone: "+15551234567", id: 1 }
    );

    expect(result.success).toBe(true);
    expect(result.ghlMessageId).toBeUndefined();
    expect(result.isPhantom).toBe(true);
  });

  it("propagates ghlMessageId through email fallback path", async () => {
    // First call fails with missing_phone error
    const missingPhoneErr = new Error("Phone number is required");
    (missingPhoneErr as any).response = { status: 422, data: { message: "Phone number is required" } };
    (sendMessage as any).mockRejectedValueOnce(missingPhoneErr);

    // Email fallback succeeds with a messageId
    (sendMessage as any).mockResolvedValueOnce({ messageId: "msg_email_456", emailMessageId: "email_thread_789" });

    const result = await sendMessageWithRetry(
      "contact_1",
      { type: "SMS", message: "Hello" },
      { email: "test@test.com", phone: null, id: 1 }
    );

    expect(result.success).toBe(true);
    expect(result.correctionTaken).toBe("fallback_to_email");
    expect(result.ghlMessageId).toBe("msg_email_456");
    expect(result.emailMessageId).toBe("email_thread_789");
    expect(result.isPhantom).toBe(false);
  });
});
