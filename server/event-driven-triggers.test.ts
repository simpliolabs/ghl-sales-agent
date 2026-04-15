import { describe, it, expect } from "vitest";
import { buildEventTriggerContext } from "./event-driven-triggers";

describe("Event-Driven Triggers — buildEventTriggerContext", () => {
  it("returns empty string when no trigger is set", () => {
    expect(buildEventTriggerContext({})).toBe("");
    expect(buildEventTriggerContext({ lastEventTrigger: null })).toBe("");
    expect(buildEventTriggerContext({ lastEventTrigger: "" })).toBe("");
  });

  it("returns email_opened_no_reply context with age", () => {
    const result = buildEventTriggerContext({
      lastEventTrigger: "email_opened_no_reply",
      lastEventTriggerAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3h ago
    });
    expect(result).toContain("EVENT TRIGGER");
    expect(result).toContain("OPENED your email");
    expect(result).toContain("3h ago");
    expect(result).toContain("did NOT reply");
  });

  it("returns email_link_clicked context", () => {
    const result = buildEventTriggerContext({
      lastEventTrigger: "email_link_clicked",
      lastEventTriggerAt: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5h ago
    });
    expect(result).toContain("EVENT TRIGGER");
    expect(result).toContain("CLICKED A LINK");
    expect(result).toContain("HOT intent signal");
    expect(result).toContain("5h ago");
  });

  it("returns quote_sent_no_response context", () => {
    const result = buildEventTriggerContext({
      lastEventTrigger: "quote_sent_no_response",
      lastEventTriggerAt: new Date(Date.now() - 50 * 60 * 60 * 1000), // 50h ago
    });
    expect(result).toContain("EVENT TRIGGER");
    expect(result).toContain("quote was sent");
    expect(result).toContain("48+ hours");
  });

  it("returns engaged_then_silent context", () => {
    const result = buildEventTriggerContext({
      lastEventTrigger: "engaged_then_silent",
      lastEventTriggerAt: new Date(Date.now() - 80 * 60 * 60 * 1000), // 80h ago
    });
    expect(result).toContain("EVENT TRIGGER");
    expect(result).toContain("actively engaged");
    expect(result).toContain("silent for 72+ hours");
  });

  it("returns empty string for unknown trigger type", () => {
    const result = buildEventTriggerContext({
      lastEventTrigger: "unknown_trigger_type",
      lastEventTriggerAt: new Date(),
    });
    expect(result).toBe("");
  });

  it("handles missing lastEventTriggerAt gracefully", () => {
    const result = buildEventTriggerContext({
      lastEventTrigger: "email_opened_no_reply",
    });
    expect(result).toContain("EVENT TRIGGER");
    expect(result).toContain("recently");
  });

  it("returns context with correct emoji for each trigger type", () => {
    expect(buildEventTriggerContext({ lastEventTrigger: "email_opened_no_reply", lastEventTriggerAt: new Date() })).toContain("⚡");
    expect(buildEventTriggerContext({ lastEventTrigger: "email_link_clicked", lastEventTriggerAt: new Date() })).toContain("🔥");
    expect(buildEventTriggerContext({ lastEventTrigger: "quote_sent_no_response", lastEventTriggerAt: new Date() })).toContain("📋");
    expect(buildEventTriggerContext({ lastEventTrigger: "engaged_then_silent", lastEventTriggerAt: new Date() })).toContain("🔕");
  });
});

describe("Event-Driven Triggers — processEventDrivenTriggers", () => {
  it("exports processEventDrivenTriggers function", async () => {
    const mod = await import("./event-driven-triggers");
    expect(typeof mod.processEventDrivenTriggers).toBe("function");
  });

  it("exports buildEventTriggerContext function", async () => {
    const mod = await import("./event-driven-triggers");
    expect(typeof mod.buildEventTriggerContext).toBe("function");
  });
});
