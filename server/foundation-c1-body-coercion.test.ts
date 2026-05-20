/**
 * Foundation C.1 — Body Coercion Tests
 *
 * Verifies that coerceWebhookBody() correctly handles all GHL payload shapes,
 * and that handleMessageWebhook() returns HTTP 200 with action="empty_body_skipped"
 * (not HTTP 400 and not a conversation row write) when the body coerces to empty.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { coerceWebhookBody } from "./webhook-message";

// ─── Unit tests: coerceWebhookBody ───────────────────────────────────────────

describe("coerceWebhookBody — Foundation C.1", () => {
  it("1. plain string passes through unchanged", () => {
    expect(coerceWebhookBody("hello")).toBe("hello");
  });

  it("2. empty object {} coerces to empty string", () => {
    expect(coerceWebhookBody({})).toBe("");
  });

  it("3. empty array [] coerces to empty string", () => {
    expect(coerceWebhookBody([])).toBe("");
  });

  it("4. null coerces to empty string", () => {
    expect(coerceWebhookBody(null)).toBe("");
  });

  it("5. undefined coerces to empty string", () => {
    expect(coerceWebhookBody(undefined)).toBe("");
  });

  it("6. non-empty object preserves JSON content", () => {
    expect(coerceWebhookBody({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  it("7. number coerces to string representation", () => {
    expect(coerceWebhookBody(42)).toBe("42");
  });

  it("8. non-empty string with only whitespace passes through (trimming is caller's responsibility)", () => {
    // coerceWebhookBody does NOT trim — the caller does .trim() checks
    expect(coerceWebhookBody("   ")).toBe("   ");
  });
});

// ─── Integration test: empty-body webhook returns 200 with empty_body_skipped ─

describe("handleMessageWebhook — empty body integration (Foundation C.1)", () => {
  it("returns HTTP 200 with action=empty_body_skipped and does NOT write conversation row when body is {}", async () => {
    // We need to mock all DB and external calls to isolate the early-return path.
    vi.mock("./db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./db")>();
      return {
        ...actual,
        getLeadByGhlContactId: vi.fn().mockResolvedValue(null),
        upsertLead: vi.fn().mockResolvedValue({ id: 99999, ghlContactId: "test_c1_synthetic", humanTakeover: 0 }),
        addConversation: vi.fn().mockResolvedValue(undefined),
        getConversationHistory: vi.fn().mockResolvedValue([]),
        getRecentAiOutboundCount: vi.fn().mockResolvedValue(0),
        getBrainCouncilAuditForLead: vi.fn().mockResolvedValue([]),
        findExistingLeadByIdentity: vi.fn().mockResolvedValue(null),
        hasPendingDeferredResponse: vi.fn().mockResolvedValue(false),
        insertDeferredResponse: vi.fn().mockResolvedValue(undefined),
        upsertAiState: vi.fn().mockResolvedValue(undefined),
        getAiState: vi.fn().mockResolvedValue(null),
      };
    });

    vi.mock("./ghl", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./ghl")>();
      return {
        ...actual,
        fetchGhlConversationHistory: vi.fn().mockResolvedValue([]),
        getContact: vi.fn().mockResolvedValue(null),
        sendMessage: vi.fn().mockResolvedValue({ messageId: "mock-id" }),
        updateContactCustomField: vi.fn().mockResolvedValue(undefined),
        addNote: vi.fn().mockResolvedValue(undefined),
        updateContactAssignment: vi.fn().mockResolvedValue(undefined),
      };
    });

    const { handleMessageWebhook } = await import("./webhook-message");
    const db = await import("./db");

    // Simulate a GHL metadata webhook with body: {}
    const payload: Record<string, unknown> = {
      contactId: "test_c1_synthetic_DO_NOT_PROCESS",
      body: {},
      direction: "inbound",
      type: "InboundMessage",
    };

    let responseBody: unknown = null;
    let statusCode = 200;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (body: unknown) => { responseBody = body; return res; },
    } as any;

    await handleMessageWebhook(payload, res);

    // Should return 200 (not 400)
    expect(statusCode).toBe(200);

    // Should have action = empty_body_skipped
    expect((responseBody as any)?.action).toBe("empty_body_skipped");

    // Should NOT have written any conversation row
    expect(db.addConversation).not.toHaveBeenCalled();
  });
});
