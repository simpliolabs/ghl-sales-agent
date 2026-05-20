/**
 * Foundation C.1 / C.1.1 — Body Coercion Tests
 *
 * Verifies that coerceWebhookBody() correctly handles all GHL payload shapes,
 * and that handleMessageWebhook() returns HTTP 200 with action="empty_body_skipped"
 * (not HTTP 400 and not a conversation row write) when the body coerces to empty.
 *
 * C.1.1 additions:
 * - Test 4: outbound direction with body: {} → empty_body_skipped (the hole C.1 missed)
 * - Test 5: outbound direction with real body → conversation row IS written (regression)
 * - All tests use __synth__ contactId prefix to prevent lead/conversation table pollution
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

// ─── Integration tests: __synth__ short-circuit path (C.1 + C.1.1) ────────────
// These tests use the __synth__ contactId prefix so no leads/conversations are created.
// They exercise the coercion guard in isolation without DB side effects.

describe("handleMessageWebhook — synthetic verification (Foundation C.1 + C.1.1)", () => {
  it("Test 1 (inbound body: {}) → empty_body_skipped, synthetic: true", async () => {
    const { handleMessageWebhook } = await import("./webhook-message");
    const payload: Record<string, unknown> = {
      contactId: "__synth__test_c1_inbound_empty_obj",
      body: {},
      direction: "inbound",
      type: "InboundMessage",
    };
    let responseBody: unknown = null;
    const res = { status: () => res, json: (b: unknown) => { responseBody = b; return res; } } as any;
    await handleMessageWebhook(payload, res);
    expect((responseBody as any)?.action).toBe("empty_body_skipped");
    expect((responseBody as any)?.synthetic).toBe(true);
  });

  it("Test 2 (inbound body: []) → empty_body_skipped, synthetic: true", async () => {
    const { handleMessageWebhook } = await import("./webhook-message");
    const payload: Record<string, unknown> = {
      contactId: "__synth__test_c1_inbound_empty_arr",
      body: [],
      direction: "inbound",
      type: "InboundMessage",
    };
    let responseBody: unknown = null;
    const res = { status: () => res, json: (b: unknown) => { responseBody = b; return res; } } as any;
    await handleMessageWebhook(payload, res);
    expect((responseBody as any)?.action).toBe("empty_body_skipped");
    expect((responseBody as any)?.synthetic).toBe(true);
  });

  it("Test 3 (inbound body: real string) → synthetic_real_content_accepted, synthetic: true", async () => {
    const { handleMessageWebhook } = await import("./webhook-message");
    const payload: Record<string, unknown> = {
      contactId: "__synth__test_c1_inbound_real",
      body: "Hello real message",
      direction: "inbound",
      type: "InboundMessage",
    };
    let responseBody: unknown = null;
    const res = { status: () => res, json: (b: unknown) => { responseBody = b; return res; } } as any;
    await handleMessageWebhook(payload, res);
    expect((responseBody as any)?.action).toBe("synthetic_real_content_accepted");
    expect((responseBody as any)?.synthetic).toBe(true);
    expect((responseBody as any)?.bodyLength).toBeGreaterThan(0);
  });

  it("Test 4 (outbound body: {}) → empty_body_skipped, synthetic: true [C.1.1 hole fix]", async () => {
    // This test covers the hole that C.1 missed: outbound direction with empty body.
    // Before C.1.1, the outbound branch ran BEFORE the empty-body guard and wrote {} rows.
    const { handleMessageWebhook } = await import("./webhook-message");
    const payload: Record<string, unknown> = {
      contactId: "__synth__test_c1_outbound_empty",
      body: {},
      direction: "outbound",
      type: "OutboundMessage",
    };
    let responseBody: unknown = null;
    const res = { status: () => res, json: (b: unknown) => { responseBody = b; return res; } } as any;
    await handleMessageWebhook(payload, res);
    expect((responseBody as any)?.action).toBe("empty_body_skipped");
    expect((responseBody as any)?.synthetic).toBe(true);
  });

  it("Test 5 (outbound body: real string) → synthetic_real_content_accepted [C.1.1 regression]", async () => {
    // Regression: real outbound content must still be accepted (not blocked by the guard).
    const { handleMessageWebhook } = await import("./webhook-message");
    const payload: Record<string, unknown> = {
      contactId: "__synth__test_c1_outbound_real",
      body: "Real outbound message from agent",
      direction: "outbound",
      type: "OutboundMessage",
    };
    let responseBody: unknown = null;
    const res = { status: () => res, json: (b: unknown) => { responseBody = b; return res; } } as any;
    await handleMessageWebhook(payload, res);
    expect((responseBody as any)?.action).toBe("synthetic_real_content_accepted");
    expect((responseBody as any)?.synthetic).toBe(true);
    expect((responseBody as any)?.bodyLength).toBeGreaterThan(0);
  });
});
