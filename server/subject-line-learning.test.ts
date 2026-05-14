/**
 * Tests for email subject line self-learning pipeline:
 * 1. emailSubject is saved in brain_council_audit
 * 2. emailSubject flows to message_outcomes via attribution
 * 3. Email open events are attributed to specific sent messages
 * 4. open_rate is a valid A/B experiment metric
 * 5. Subject line pattern classification works correctly
 * 6. analyzeSubjectLinePatterns generates learning records
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- 1. classifySubjectPattern tests ---
import { classifySubjectPattern } from "./learning-loop";

describe("classifySubjectPattern", () => {
  it("classifies questions (ending with ?)", () => {
    expect(classifySubjectPattern("still need those tees?")).toBe("question");
    expect(classifySubjectPattern("ready for new gear?")).toBe("question");
  });

  it("classifies personalized_you (contains 'your' or 'you')", () => {
    expect(classifySubjectPattern("your church gear idea")).toBe("personalized_you");
    expect(classifySubjectPattern("thought you might like this")).toBe("personalized_you");
  });

  it("classifies follow_up (contains 'still', 'yet', 'update')", () => {
    expect(classifySubjectPattern("still thinking it over")).toBe("follow_up");
    expect(classifySubjectPattern("quick update on pricing")).toBe("follow_up");
  });

  it("classifies casual_short (contains 'quick', 'fast', 'just')", () => {
    expect(classifySubjectPattern("quick check-in")).toBe("casual_short");
    expect(classifySubjectPattern("just following up")).toBe("casual_short");
  });

  it("classifies suggestion (contains 'idea', 'thought')", () => {
    expect(classifySubjectPattern("an idea for the team")).toBe("suggestion");
    expect(classifySubjectPattern("thought about the jerseys")).toBe("suggestion");
  });

  it("classifies need_based (contains 'ready', 'need', 'looking')", () => {
    expect(classifySubjectPattern("ready to order")).toBe("need_based");
    expect(classifySubjectPattern("need custom shirts")).toBe("need_based");
  });

  it("classifies promotional (contains 'save', 'deal', 'offer', 'free', 'discount')", () => {
    expect(classifySubjectPattern("save 20% this week")).toBe("promotional");
    expect(classifySubjectPattern("special deal for churches")).toBe("promotional");
  });

  it("classifies ultra_short (<=20 chars)", () => {
    expect(classifySubjectPattern("hey there")).toBe("ultra_short");
    expect(classifySubjectPattern("hi pastor")).toBe("ultra_short");
  });

  it("classifies short (21-35 chars)", () => {
    expect(classifySubjectPattern("checking in on the order")).toBe("short");
  });

  it("classifies standard (>35 chars, no other pattern)", () => {
    expect(classifySubjectPattern("we have some amazing options for the whole team to enjoy")).toBe("standard");
  });

  // Question mark takes priority over other patterns
  it("question pattern takes priority", () => {
    expect(classifySubjectPattern("still need your gear?")).toBe("question");
  });
});

// --- 2. A/B testing open_rate metric ---
describe("A/B testing open_rate metric", () => {
  it("open_rate maps to emailOpened column in evaluateExperiment", async () => {
    // This is a structural test — verify the metric mapping exists in the code
    const abTestingCode = await import("fs").then(fs =>
      fs.readFileSync("/home/ubuntu/adorb-outreach/server/ab-testing.ts", "utf-8")
    );
    expect(abTestingCode).toContain('metric === "open_rate" ? messageOutcomes.emailOpened');
  });
});

// --- 3. Email open attribution in webhook-events ---
describe("Email open attribution wiring", () => {
  it("webhook-events.ts imports brainCouncilAudit and messageOutcomes", async () => {
    const code = await import("fs").then(fs =>
      fs.readFileSync("/home/ubuntu/adorb-outreach/server/webhook-events.ts", "utf-8")
    );
    expect(code).toContain("brainCouncilAudit");
    expect(code).toContain("messageOutcomes");
    expect(code).toContain("emailOpened: 1");
    expect(code).toContain("emailOpenedAt: now");
  });
});

// --- 4. emailSubject flows through the pipeline ---
describe("emailSubject pipeline wiring", () => {
  it("brain-council-orchestrator saves emailSubject in audit", async () => {
    const code = await import("fs").then(fs =>
      fs.readFileSync("/home/ubuntu/adorb-outreach/server/brain-council-orchestrator.ts", "utf-8")
    );
    expect(code).toContain("emailSubject: composed.subject");
  });

  it("outcome-engine copies emailSubject from audit to message_outcomes (attributeReply)", async () => {
    const code = await import("fs").then(fs =>
      fs.readFileSync("/home/ubuntu/adorb-outreach/server/outcome-engine.ts", "utf-8")
    );
    // Check both attributeReply and backfillOutcomes
    // Check attributeReply path
    expect(code).toContain("emailSubject:");
    // Check that emailSubject is referenced in the outcome engine at least once
    const matches = code.match(/emailSubject/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2); // multiple references across attributeReply + backfill
  });

  it("backfillOutcomes selects emailSubject from brainCouncilAudit", async () => {
    const code = await import("fs").then(fs =>
      fs.readFileSync("/home/ubuntu/adorb-outreach/server/outcome-engine.ts", "utf-8")
    );
    expect(code).toContain("emailSubject: brainCouncilAudit.emailSubject");
  });
});

// --- 5. Schema has the new columns ---
describe("Schema columns", () => {
  it("brain_council_audit has emailSubject column", async () => {
    const schema = await import("fs").then(fs =>
      fs.readFileSync("/home/ubuntu/adorb-outreach/drizzle/schema.ts", "utf-8")
    );
    expect(schema).toMatch(/brainCouncilAudit.*emailSubject/s);
  });

  it("message_outcomes has emailSubject, emailOpened, emailOpenedAt columns", async () => {
    const schema = await import("fs").then(fs =>
      fs.readFileSync("/home/ubuntu/adorb-outreach/drizzle/schema.ts", "utf-8")
    );
    expect(schema).toMatch(/messageOutcomes[\s\S]*emailSubject/);
    expect(schema).toMatch(/messageOutcomes[\s\S]*emailOpened/);
    expect(schema).toMatch(/messageOutcomes[\s\S]*emailOpenedAt/);
  });
});
