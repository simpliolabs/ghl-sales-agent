import { describe, it, expect, vi, beforeEach } from "vitest";
import { attemptSend } from "./attempt-send";
import type { SendRequest, Channel } from "./send-types";
import { isDelivered, shouldRecordAttempt } from "./send-types";

// Mock the underlying sendMessageWithRetry
const mockSendMessageWithRetry = vi.fn();
const mockRecordSendAttempt = vi.fn().mockResolvedValue(undefined);

vi.mock("./webhook-helpers", () => ({
  sendMessageWithRetry: (...args: any[]) => mockSendMessageWithRetry(...args),
}));

vi.mock("./db", () => ({
  recordSendAttempt: (...args: any[]) => mockRecordSendAttempt(...args),
}));

const baseRequest: SendRequest = {
  leadId: 1234,
  ghlContactId: "test_contact_abc",
  channel: "SMS",
  message: "Hello there",
  trigger: "first_contact",
};

describe("Foundation A: attemptSend wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns kind:delivered when send succeeds with messageId", async () => {
    mockSendMessageWithRetry.mockResolvedValue({
      success: true,
      resolvedContactId: "test_contact_abc",
      ghlMessageId: "msg_xyz_123",
      isPhantom: false,
    });

    const outcome = await attemptSend(baseRequest);

    expect(outcome.kind).toBe("delivered");
    if (outcome.kind === "delivered") {
      expect(outcome.messageId).toBe("msg_xyz_123");
      expect(outcome.channel).toBe("SMS");
      expect(outcome.resolvedContactId).toBe("test_contact_abc");
    }
    expect(mockRecordSendAttempt).not.toHaveBeenCalled();
  });

  it("returns kind:phantom when send returns success but no messageId", async () => {
    mockSendMessageWithRetry.mockResolvedValue({
      success: true,
      resolvedContactId: "test_contact_abc",
      ghlMessageId: undefined,
      isPhantom: true,
    });

    const outcome = await attemptSend({ ...baseRequest, channel: "IG" });

    expect(outcome.kind).toBe("phantom");
    if (outcome.kind === "phantom") {
      expect(outcome.channel).toBe("IG");
      expect(outcome.reason).toContain("no messageId");
    }
    expect(mockRecordSendAttempt).toHaveBeenCalledOnce();
    expect(mockRecordSendAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: 1234,
        channel: "IG",
        outcomeKind: "phantom",
        trigger: "first_contact",
      })
    );
  });

  it("returns kind:failed when send returns success:false", async () => {
    mockSendMessageWithRetry.mockResolvedValue({
      success: false,
      resolvedContactId: "test_contact_abc",
      error: "GHL API returned 422",
      errorType: "ghl_api_error",
    });

    const outcome = await attemptSend(baseRequest);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.errorType).toBe("ghl_api_error");
      expect(outcome.retryable).toBe(true);
    }
    expect(mockRecordSendAttempt).toHaveBeenCalledOnce();
  });

  it("returns kind:failed when sendMessageWithRetry throws", async () => {
    mockSendMessageWithRetry.mockRejectedValue(new Error("Network timeout"));

    const outcome = await attemptSend(baseRequest);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.reason).toBe("Network timeout");
      expect(outcome.errorType).toBe("unknown");
      expect(outcome.retryable).toBe(false);
    }
    expect(mockRecordSendAttempt).toHaveBeenCalledOnce();
  });

  it("retryable=true for rate limit, timeout, api_error", async () => {
    for (const errorType of ["ghl_rate_limit", "timeout", "ghl_api_error"]) {
      mockSendMessageWithRetry.mockResolvedValue({
        success: false,
        resolvedContactId: "test_contact_abc",
        error: "test",
        errorType,
      });

      const outcome = await attemptSend(baseRequest);
      if (outcome.kind === "failed") {
        expect(outcome.retryable).toBe(true);
      }
    }
  });

  it("retryable=false for auth errors, no_phone, no_email, dnc", async () => {
    for (const errorType of ["ghl_auth_error", "no_phone", "no_email", "lead_dnc"]) {
      mockSendMessageWithRetry.mockResolvedValue({
        success: false,
        resolvedContactId: "test_contact_abc",
        error: "test",
        errorType,
      });

      const outcome = await attemptSend(baseRequest);
      if (outcome.kind === "failed") {
        expect(outcome.retryable).toBe(false);
      }
    }
  });

  it("isDelivered type guard narrows correctly", async () => {
    mockSendMessageWithRetry.mockResolvedValue({
      success: true,
      resolvedContactId: "test_contact_abc",
      ghlMessageId: "msg_123",
      isPhantom: false,
    });

    const outcome = await attemptSend(baseRequest);
    if (isDelivered(outcome)) {
      // TypeScript should narrow this to the delivered variant
      expect(outcome.messageId).toBe("msg_123");
    } else {
      throw new Error("Expected delivered outcome");
    }
  });

  it("shouldRecordAttempt returns false for delivered, true for others", async () => {
    mockSendMessageWithRetry.mockResolvedValue({
      success: true,
      resolvedContactId: "test_contact_abc",
      ghlMessageId: "msg_123",
      isPhantom: false,
    });
    const delivered = await attemptSend(baseRequest);
    expect(shouldRecordAttempt(delivered)).toBe(false);

    mockSendMessageWithRetry.mockResolvedValue({
      success: false,
      error: "test",
      errorType: "ghl_api_error",
      resolvedContactId: "test_contact_abc",
    });
    const failed = await attemptSend(baseRequest);
    expect(shouldRecordAttempt(failed)).toBe(true);
  });

  it("passes trigger through to recordSendAttempt", async () => {
    mockSendMessageWithRetry.mockResolvedValue({
      success: false,
      error: "test",
      errorType: "ghl_api_error",
      resolvedContactId: "test_contact_abc",
    });

    await attemptSend({ ...baseRequest, trigger: "lookback_drip" });

    expect(mockRecordSendAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "lookback_drip" })
    );
  });

  it("FB channel phantom includes channel in outcome", async () => {
    mockSendMessageWithRetry.mockResolvedValue({
      success: true,
      resolvedContactId: "test_contact_abc",
      ghlMessageId: undefined,
      isPhantom: true,
    });

    const outcome = await attemptSend({ ...baseRequest, channel: "FB" });

    expect(outcome.kind).toBe("phantom");
    if (outcome.kind === "phantom") {
      expect(outcome.channel).toBe("FB");
    }
  });
});
