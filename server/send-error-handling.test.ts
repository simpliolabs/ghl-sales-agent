/**
 * SEND ERROR HANDLING TESTS
 * Tests for GHL send error classification and corrective action logic
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyGhlSendError, sendMessageWithRetry } from "./webhook-helpers";

// Mock dependencies
vi.mock("./ghl", () => ({
  sendMessage: vi.fn(),
  getContact: vi.fn(),
  searchContacts: vi.fn(),
  updateContactCustomField: vi.fn(),
}));

vi.mock("./db", () => ({
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
}));

import { sendMessage } from "./ghl";
import { updateLeadFields } from "./db";

const mockSendMessage = sendMessage as ReturnType<typeof vi.fn>;
const mockUpdateLeadFields = updateLeadFields as ReturnType<typeof vi.fn>;

function makeGhlError(status: number, message: string) {
  const err = new Error(`Request failed with status code ${status}`);
  (err as any).response = { status, data: { status, message, name: "HttpException" } };
  return err;
}

describe("classifyGhlSendError", () => {
  it("classifies missing phone error", () => {
    // GHL returns 422 with 'Missing phone number' — our classifier catches 'missing phone' text first
    const err = makeGhlError(422, "Missing phone number");
    const result = classifyGhlSendError(err);
    expect(result.type).toBe("missing_phone");
  });

  it("classifies missing email error", () => {
    const err = makeGhlError(400, "Contact has no email");
    const result = classifyGhlSendError(err);
    expect(result.type).toBe("missing_email");
  });

  it("classifies invalid email error", () => {
    const err = makeGhlError(400, "Unable to send e-mail, contact's e-mail is invalid");
    const result = classifyGhlSendError(err);
    expect(result.type).toBe("invalid_email");
  });

  it("classifies contact not found (400 without email/phone message)", () => {
    const err = makeGhlError(400, "Contact not found");
    const result = classifyGhlSendError(err);
    // 400 without email/phone keywords → contact_not_found
    expect(result.type).toBe("contact_not_found");
  });

  it("classifies 404 as contact not found", () => {
    const err = makeGhlError(404, "Not found");
    const result = classifyGhlSendError(err);
    expect(result.type).toBe("contact_not_found");
  });

  it("classifies 422 with generic message as carrier block", () => {
    // 422 with a non-phone-specific message → carrier_block
    const err = makeGhlError(422, "Unprocessable entity");
    const result = classifyGhlSendError(err);
    expect(result.type).toBe("carrier_block");
  });

  it("classifies DND rejection", () => {
    const err = makeGhlError(403, "Contact is opted out");
    const result = classifyGhlSendError(err);
    expect(result.type).toBe("dnd");
  });

  it("classifies isDndRejection flag", () => {
    const err = new Error("DND");
    (err as any).isDndRejection = true;
    const result = classifyGhlSendError(err);
    expect(result.type).toBe("dnd");
  });

  it("classifies 429 as transient", () => {
    const err = makeGhlError(429, "Rate limit exceeded");
    const result = classifyGhlSendError(err);
    expect(result.type).toBe("transient");
  });

  it("classifies unknown errors", () => {
    const err = makeGhlError(500, "Internal server error");
    const result = classifyGhlSendError(err);
    expect(result.type).toBe("unknown");
  });

  it("includes status code in result", () => {
    const err = makeGhlError(422, "Missing phone number");
    const result = classifyGhlSendError(err);
    expect(result.status).toBe(422);
  });
});

describe("sendMessageWithRetry — corrective actions", () => {
  const lead = { id: 42, email: "test@example.com", phone: "+15551234567" };
  const smsOpts = { type: "SMS" as const, message: "Hello!" };
  const emailOpts = { type: "Email" as const, subject: "Hi", html: "Hello!", message: "Hello!" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateLeadFields.mockResolvedValue(undefined);
  });

  it("returns success on clean send", async () => {
    mockSendMessage.mockResolvedValueOnce({ messageId: "msg_1" });
    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(true);
    expect(result.correctionTaken).toBeUndefined();
  });

  it("falls back to email when SMS has missing phone (422)", async () => {
    // GHL 422 'Missing phone number' → classified as missing_phone → fallback to email
    mockSendMessage.mockRejectedValueOnce(makeGhlError(422, "Missing phone number"));
    // Second call (Email fallback) succeeds
    mockSendMessage.mockResolvedValueOnce({ messageId: "msg_email_1" });

    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(true);
    expect(result.correctionTaken).toBe("fallback_to_email");
  });

  it("falls back to SMS when email is missing", async () => {
    // First call (Email) fails with missing email
    mockSendMessage.mockRejectedValueOnce(makeGhlError(400, "Contact has no email"));
    // Second call (SMS fallback) succeeds
    mockSendMessage.mockResolvedValueOnce({ messageId: "msg_sms_1" });

    const result = await sendMessageWithRetry("contact_1", emailOpts, lead);
    expect(result.success).toBe(true);
    expect(result.correctionTaken).toBe("fallback_to_sms");
  });

  it("falls back to SMS when email is invalid", async () => {
    mockSendMessage.mockRejectedValueOnce(makeGhlError(400, "Unable to send e-mail, contact's e-mail is invalid"));
    mockSendMessage.mockResolvedValueOnce({ messageId: "msg_sms_2" });

    const result = await sendMessageWithRetry("contact_1", emailOpts, lead);
    expect(result.success).toBe(true);
    expect(result.correctionTaken).toBe("fallback_to_sms");
  });

  it("marks lead unreachable when SMS missing phone and no email available", async () => {
    // 422 'Missing phone number' → missing_phone. No email → marked_unreachable
    const noEmailLead = { id: 99, email: null, phone: "+15551234567" };
    mockSendMessage.mockRejectedValueOnce(makeGhlError(422, "Missing phone number"));

    const result = await sendMessageWithRetry("contact_1", smsOpts, noEmailLead);
    expect(result.success).toBe(false);
    expect(result.correctionTaken).toBe("marked_unreachable");
    expect(mockUpdateLeadFields).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ lastAgentNote: expect.stringContaining("cannot reach") })
    );
  });

  it("flags dndSms and falls back to email when carrier blocks SMS (generic 422)", async () => {
    // Generic 422 (no phone-specific message) → carrier_block → flag dndSms + email fallback
    mockSendMessage.mockRejectedValueOnce(makeGhlError(422, "Unprocessable entity"));
    mockSendMessage.mockResolvedValueOnce({ messageId: "msg_email_cb" });

    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(true);
    expect(result.correctionTaken).toBe("carrier_block_fallback_to_email");
    expect(mockUpdateLeadFields).toHaveBeenCalledWith(42, expect.objectContaining({ dndSms: 1 }));
  });

  it("marks lead unreachable when email fails and no phone available", async () => {
    const noPhoneLead = { id: 77, email: "test@example.com", phone: null };
    mockSendMessage.mockRejectedValueOnce(makeGhlError(400, "Contact has no email"));

    const result = await sendMessageWithRetry("contact_1", emailOpts, noPhoneLead);
    expect(result.success).toBe(false);
    expect(result.correctionTaken).toBe("marked_unreachable");
    expect(mockUpdateLeadFields).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ lastAgentNote: expect.stringContaining("cannot reach") })
    );
  });

  it("returns dnd error type on DND rejection", async () => {
    const dndErr = new Error("DND");
    (dndErr as any).isDndRejection = true;
    mockSendMessage.mockRejectedValueOnce(dndErr);

    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(false);
    expect(result.errorType).toBe("dnd");
  });

  it("returns transient error type on 429", async () => {
    mockSendMessage.mockRejectedValueOnce(makeGhlError(429, "Rate limit exceeded"));
    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(false);
    expect(result.errorType).toBe("transient");
  });
});

describe("sendMessageWithRetry — blocked send detection", () => {
  const lead = { id: 42, email: "test@example.com", phone: "+15551234567" };
  const smsOpts = { type: "SMS" as const, message: "Hello!" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateLeadFields.mockResolvedValue(undefined);
  });

  it("returns failure when sendMessage returns { blocked: true, reason: 'AI_OFFLINE' }", async () => {
    mockSendMessage.mockResolvedValueOnce({ blocked: true, reason: "AI_OFFLINE", messageId: null });
    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(false);
    expect(result.error).toContain("AI_OFFLINE");
    expect(result.correctionTaken).toBe("blocked_by_ai_offline");
  });

  it("returns failure when sendMessage returns { blocked: true, reason: 'COOLDOWN' }", async () => {
    mockSendMessage.mockResolvedValueOnce({ blocked: true, reason: "COOLDOWN", messageId: null });
    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(false);
    expect(result.error).toContain("COOLDOWN");
    expect(result.correctionTaken).toBe("blocked_by_cooldown");
  });

  it("returns failure when sendMessage returns { blocked: true, reason: 'HUMAN_AGENT_ACTIVE' }", async () => {
    mockSendMessage.mockResolvedValueOnce({ blocked: true, reason: "HUMAN_AGENT_ACTIVE", messageId: null });
    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(false);
    expect(result.error).toContain("HUMAN_AGENT_ACTIVE");
    expect(result.correctionTaken).toBe("blocked_by_human_agent_active");
  });

  it("returns failure when sendMessage returns { blocked: true, reason: 'HUMAN_AGENT_ACTIVE_GHL' }", async () => {
    mockSendMessage.mockResolvedValueOnce({ blocked: true, reason: "HUMAN_AGENT_ACTIVE_GHL", messageId: null });
    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(false);
    expect(result.error).toContain("HUMAN_AGENT_ACTIVE_GHL");
    expect(result.correctionTaken).toBe("blocked_by_human_agent_active_ghl");
  });

  it("returns failure when sendMessage returns { blocked: true, reason: 'OFFLINE_CHECK_FAILED' }", async () => {
    mockSendMessage.mockResolvedValueOnce({ blocked: true, reason: "OFFLINE_CHECK_FAILED", messageId: null });
    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(false);
    expect(result.error).toContain("OFFLINE_CHECK_FAILED");
  });

  it("returns failure with UNKNOWN_GATE when blocked reason is missing", async () => {
    mockSendMessage.mockResolvedValueOnce({ blocked: true, messageId: null });
    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(false);
    expect(result.error).toContain("UNKNOWN_GATE");
  });

  it("still returns success when sendMessage returns normal data (not blocked)", async () => {
    mockSendMessage.mockResolvedValueOnce({ messageId: "msg_123", blocked: false });
    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(true);
  });

  it("still returns success when sendMessage returns data without blocked field", async () => {
    mockSendMessage.mockResolvedValueOnce({ messageId: "msg_456" });
    const result = await sendMessageWithRetry("contact_1", smsOpts, lead);
    expect(result.success).toBe(true);
  });
});


// --- buildContextSubject tests ---
import { buildContextSubject } from "./webhook-helpers";

describe("buildContextSubject", () => {
  it("uses businessName + productType when both available", () => {
    const subject = buildContextSubject({
      name: "Iory Yagami",
      businessName: "LSU Construction Management",
      formData: [{ label: "What type of products are you interested in?", value: "T-shirts" }],
    }, "Abby");
    expect(subject).toContain("LSU Construction Management");
    expect(subject).toContain("T-shirts");
    expect(subject).toContain("Abby");
    expect(subject).not.toBe("Abby from Adorb Custom Tees");
  });

  it("uses productType + firstName when no businessName", () => {
    const subject = buildContextSubject({
      name: "John Smith",
      businessName: null,
      formData: [{ label: "Product type", value: "Hoodies" }],
    }, "Chris");
    expect(subject).toContain("John");
    expect(subject).toContain("Hoodies");
    expect(subject).toContain("Chris");
  });

  it("uses businessName alone when no productType in form data", () => {
    const subject = buildContextSubject({
      name: "Jane Doe",
      businessName: "Acme Corp",
      formData: [{ label: "Notes", value: "Need rush order" }],
    }, "Abby");
    expect(subject).toContain("Acme Corp");
    expect(subject).toContain("Abby");
  });

  it("uses firstName when only name available", () => {
    const subject = buildContextSubject({
      name: "Glory",
      businessName: null,
      formData: null,
    }, "Chris");
    expect(subject).toContain("Glory");
    expect(subject).toContain("Chris");
    expect(subject).not.toBe("Chris from Adorb Custom Tees");
  });

  it("falls back to generic when no lead data", () => {
    const subject = buildContextSubject({
      name: null,
      businessName: null,
      formData: null,
    }, "Abby");
    expect(subject).toBe("Abby from Adorb Custom Tees");
  });

  it("handles empty formData array", () => {
    const subject = buildContextSubject({
      name: "Test Lead",
      businessName: null,
      formData: [],
    }, "Abby");
    expect(subject).toContain("Test");
    expect(subject).toContain("Abby");
  });

  it("extracts product from 'interested in' label", () => {
    const subject = buildContextSubject({
      name: "Kim",
      businessName: null,
      formData: [{ label: "What are you interested in?", value: "Custom Mugs" }],
    }, "Abby");
    expect(subject).toContain("Custom Mugs");
  });
});
