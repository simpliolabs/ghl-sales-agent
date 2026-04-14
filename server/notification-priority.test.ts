import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the notifyOwner function's priority behavior by mocking fetch
// and verifying which calls actually hit the upstream service vs get logged only.

// Mock ENV
vi.mock("./server/_core/env", () => ({
  ENV: {
    forgeApiUrl: "https://fake-forge.example.com/",
    forgeApiKey: "test-key-123",
  },
}));

// We need to test the actual notification module
let notifyOwner: typeof import("./_core/notification").notifyOwner;

describe("Notification Priority System", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Reset module cache to get fresh dedup state
    vi.resetModules();

    // Mock fetch globally
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });
    global.fetch = fetchSpy as any;

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Re-import to get fresh module state
    const mod = await import("./_core/notification");
    notifyOwner = mod.notifyOwner;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // CRITICAL notifications — should call fetch (send email)
  // ============================================================

  it("sends email for explicit priority: critical", async () => {
    const result = await notifyOwner({
      title: "Test Critical",
      content: "This is critical",
      priority: "critical",
    });
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends email for payment received (auto-inferred critical)", async () => {
    const result = await notifyOwner({
      title: "💰 Payment received: Test Lead",
      content: "Test Lead has paid. Order value: $500.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends email for AI Messaging Paused (auto-inferred critical)", async () => {
    const result = await notifyOwner({
      title: "🔴 AI Messaging Paused",
      content: "AI messaging has been set to OFFLINE.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends email for Human Handoff (auto-inferred critical)", async () => {
    const result = await notifyOwner({
      title: "📞 Human Handoff: John Smith",
      content: "Lead needs human attention.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends email for LLM Credits Exhausted (auto-inferred critical)", async () => {
    const result = await notifyOwner({
      title: "⚠️ LLM Credits Exhausted — Follow-ups Paused",
      content: "Brain Council failed.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends email for CIRCUIT BREAKER (auto-inferred critical)", async () => {
    const result = await notifyOwner({
      title: "🚨 CIRCUIT BREAKER: AI paused for John (Lead #123)",
      content: "AI has failed 3 times.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends email for URGENT SLA breach (auto-inferred critical)", async () => {
    const result = await notifyOwner({
      title: "🔴 URGENT: 3 lead(s) waiting 8+ business hours for human response",
      content: "SLA breach.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // STANDARD notifications — should NOT call fetch (portal only)
  // ============================================================

  it("does NOT send email for explicit priority: standard", async () => {
    const result = await notifyOwner({
      title: "🟢 AI Messaging Resumed",
      content: "AI is back online.",
      priority: "standard",
    });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Notification/Portal]")
    );
  });

  it("does NOT send email for New Contact (auto-inferred standard)", async () => {
    const result = await notifyOwner({
      title: "📞 New Contact: Jane Doe",
      content: "A new contact has entered the system.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT send email for AI Message BLOCKED (auto-inferred standard)", async () => {
    const result = await notifyOwner({
      title: "⚠️ AI Message BLOCKED for Jane Doe (Lead #456)",
      content: "Violation: GENERIC_OPENER",
    });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT send email for Auto-Correction Sent (auto-inferred standard)", async () => {
    const result = await notifyOwner({
      title: "🔧 Auto-Correction Sent: Jane Doe",
      content: "An auto-correction was sent.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT send email for Lead Disposition (auto-inferred standard)", async () => {
    const result = await notifyOwner({
      title: "Lead Disposition: 2 DNC, 1 email escalated, 0 takeover expired",
      content: "Disposition sweep completed.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT send email for Seasonal Campaign (auto-inferred standard)", async () => {
    const result = await notifyOwner({
      title: 'Seasonal Campaign "Summer Push": 15 leads activated',
      content: "Campaign activated stale leads.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT send email for SLA Warning 4+ hours (auto-inferred standard)", async () => {
    const result = await notifyOwner({
      title: "🟡 SLA Warning: 2 lead(s) waiting 4+ business hours for human response",
      content: "Please respond soon.",
    });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT send email for Supervisor failed corrections (auto-inferred standard)", async () => {
    const result = await notifyOwner({
      title: "Supervisor: 3 failed corrections",
      content: "Lead #123: invariant — correction",
    });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT send email for Council Self-Review (auto-inferred standard)", async () => {
    const result = await notifyOwner({
      title: "🔄 Council Self-Review: Recovery Sent to Jane Doe",
      content: "Issue: stale_angle",
    });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ============================================================
  // Deduplication still works for CRITICAL notifications
  // ============================================================

  it("deduplicates critical notifications within 5-minute window", async () => {
    await notifyOwner({
      title: "💰 Payment received: Dedup Test",
      content: "First call",
      priority: "critical",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call with same title should be suppressed
    await notifyOwner({
      title: "💰 Payment received: Dedup Test",
      content: "Second call",
      priority: "critical",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Still 1 — second was suppressed
  });

  // ============================================================
  // Standard notifications skip dedup entirely (no fetch call)
  // ============================================================

  it("standard notifications always return true without hitting fetch", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await notifyOwner({
        title: "Routine update",
        content: `Update #${i}`,
        priority: "standard",
      });
      expect(result).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
