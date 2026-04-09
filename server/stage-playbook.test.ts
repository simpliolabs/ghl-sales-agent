import { describe, it, expect } from "vitest";
import {
  getStagePlaybook,
  getStrategistStageBlock,
  getComposerStageBlock,
  getCloserStageBlock,
  getObjectionHandlerStageBlock,
  getStageTaskContext,
  getStageNote,
  getStageFollowUpDelay,
  isAiProactiveAtStage,
  isTerminalStage,
  getPlaybookSummaryForLearning,
  getStageOrder,
} from "./stage-playbook";

const ALL_STAGE_NAMES = getStageOrder();

// ─── getStagePlaybook ──────────────────────────────────────────────────────

describe("getStagePlaybook", () => {
  it("returns playbook for exact stage name", () => {
    const pb = getStagePlaybook("New Lead");
    expect(pb).not.toBeNull();
    expect(pb!.stage).toBe("New Lead");
    expect(pb!.goal).toContain("Qualify");
  });

  it("returns playbook for case-insensitive match", () => {
    const pb = getStagePlaybook("new lead");
    expect(pb).not.toBeNull();
    expect(pb!.stage).toBe("New Lead");
  });

  it("returns playbook for partial match", () => {
    const pb = getStagePlaybook("Paid - Proof Needed");
    expect(pb).not.toBeNull();
    expect(pb!.label).toBe("Paid - Proof Needed");
  });

  it("returns null for null/undefined input", () => {
    expect(getStagePlaybook(null)).toBeNull();
    expect(getStagePlaybook(undefined)).toBeNull();
    expect(getStagePlaybook("")).toBeNull();
  });

  it("returns null for unknown stage", () => {
    expect(getStagePlaybook("Totally Made Up Stage")).toBeNull();
  });

  it("returns all 11 stages from the Bulk Printing Pipeline", () => {
    const expectedStages = [
      "New Lead",
      "Contacted",
      "Qualified",
      "Quote Sent",
      "Paid - Proof Needed",
      "Proof Sent",
      "Approved + Deposit",
      "In Production",
      "Ready",
      "Delivered",
      "Not Qualified",
    ];
    for (const stage of expectedStages) {
      const pb = getStagePlaybook(stage);
      expect(pb, `Missing playbook for stage: ${stage}`).not.toBeNull();
    }
  });
});

// ─── Playbook content validation ────────────────────────────────────────────

describe("Playbook content validation", () => {
  it("every playbook has required fields populated", () => {
    for (const name of ALL_STAGE_NAMES) {
      const pb = getStagePlaybook(name)!;
      expect(pb.stage, `${name}: missing stage`).toBeTruthy();
      expect(pb.label, `${name}: missing label`).toBeTruthy();
      expect(pb.goal.length, `${name}: goal too short`).toBeGreaterThan(10);
      expect(pb.focusTopics.length, `${name}: no focus topics`).toBeGreaterThan(0);
      expect(pb.neverDo.length, `${name}: no never-do rules`).toBeGreaterThan(0);
      expect(pb.advanceSignals.length, `${name}: no advance signals`).toBeGreaterThan(0);
      expect(pb.tone.length, `${name}: tone too short`).toBeGreaterThan(5);
      expect(pb.suggestedApproaches.length, `${name}: no suggested approaches`).toBeGreaterThan(0);
      expect(pb.preferredFrameworks.length, `${name}: no preferred frameworks`).toBeGreaterThan(0);
      expect(pb.noteTemplate.length, `${name}: no note template`).toBeGreaterThan(0);
      expect(typeof pb.followUpDelayHours).toBe("number");
      expect(typeof pb.aiProactive).toBe("boolean");
      expect(typeof pb.isTerminal).toBe("boolean");
    }
  });

  it("non-terminal stages have a nextStage defined", () => {
    for (const name of ALL_STAGE_NAMES) {
      const pb = getStagePlaybook(name)!;
      if (!pb.isTerminal) {
        expect(pb.nextStage, `${name}: non-terminal but no nextStage`).toBeTruthy();
      }
    }
  });

  it("terminal stages are Delivered and Not Qualified only", () => {
    for (const name of ALL_STAGE_NAMES) {
      const pb = getStagePlaybook(name)!;
      if (pb.isTerminal) {
        expect(["Delivered", "Not Qualified"]).toContain(pb.stage);
      }
    }
  });

  it("stages with tasks have valid assignTo values", () => {
    for (const name of ALL_STAGE_NAMES) {
      const pb = getStagePlaybook(name)!;
      if (pb.taskContext) {
        expect(["designer", "production", "sales", "shipping"]).toContain(pb.taskContext.assignTo);
        expect(pb.taskContext.title.length).toBeGreaterThan(0);
        expect(pb.taskContext.description.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── getStageBlock ─────────────────────────────────────────────────────────

describe("getStageBlock", () => {
  it("returns formatted block with all sections for known stage", () => {
    const block = getStrategistStageBlock("Qualified");
    expect(block).toContain("STAGE PLAYBOOK");
    expect(block).toContain("GOAL AT THIS STAGE:");
    expect(block).toContain("FOCUS TOPICS:");
    expect(block).toContain("SUGGESTED APPROACHES");
    expect(block).toContain("PREFERRED FRAMEWORKS:");
    expect(block).toContain("ADVANCE SIGNALS");
    expect(block).toContain("ESCALATION SIGNALS");
    expect(block).toContain("AI PROACTIVE:");
    expect(block).toContain("NEXT STAGE:");
  });

  it("returns empty string for unknown stage", () => {
    expect(getStrategistStageBlock("Fake Stage")).toBe("");
  });

  it("returns empty string for null", () => {
    expect(getStrategistStageBlock(null)).toBe("");
    expect(getStrategistStageBlock(undefined)).toBe("");
  });
});

// ─── getCloserStageBlock ───────────────────────────────────────────────────

describe("getCloserStageBlock", () => {
  it("returns closer-specific block with stage context", () => {
    const block = getCloserStageBlock("Paid - Proof Needed");
    expect(block).toContain("CURRENT PIPELINE STAGE:");
    expect(block).toContain("STAGE GOAL:");
    expect(block).toContain("FOCUS:");
    expect(block).toContain("NEVER:");
    expect(block).toContain("NEXT STEP:");
    expect(block).toContain("TONE:");
  });

  it("returns empty string for unknown stage", () => {
    expect(getCloserStageBlock("Fake")).toBe("");
  });
});

// ─── getObjectionStageBlock ────────────────────────────────────────────────

describe("getObjectionStageBlock", () => {
  it("returns objection-specific block with escalation triggers", () => {
    const block = getObjectionHandlerStageBlock("Quote Sent");
    expect(block).toContain("OBJECTION CONTEXT");
    expect(block).toContain("CURRENT STAGE:");
    expect(block).toContain("STAGE GOAL:");
    expect(block).toContain("ESCALATION TRIGGERS:");
    expect(block).toContain("TONE:");
  });

  it("returns empty string for unknown stage", () => {
    expect(getObjectionHandlerStageBlock("Fake")).toBe("");
  });
});

// ─── getStageTaskContext ───────────────────────────────────────────────────

describe("getStageTaskContext", () => {
  it("returns task for stages that have tasks defined", () => {
    // Qualified has a task for sales
    const task = getStageTaskContext("Qualified", "John Doe");
    expect(task).not.toBeNull();
    expect(task!.title).toContain("John Doe");
    expect(task!.assignTo).toBe("sales");
  });

  it("replaces {{leadName}} placeholder in task title", () => {
    const task = getStageTaskContext("Qualified", "Acme Corp");
    expect(task!.title).toContain("Acme Corp");
    expect(task!.title).not.toContain("{{leadName}}");
  });

  it("returns null for stages without tasks", () => {
    const task = getStageTaskContext("Contacted", "Test Lead");
    expect(task).toBeNull();
  });

  it("returns null for unknown stage", () => {
    expect(getStageTaskContext("Fake", "Test")).toBeNull();
  });
});

// ─── getStageNote ──────────────────────────────────────────────────────────

describe("getStageNote", () => {
  it("returns note template for known stage", () => {
    const note = getStageNote("New Lead");
    expect(note).toContain("New lead");
  });

  it("returns fallback for unknown stage", () => {
    const note = getStageNote("Unknown Stage");
    expect(note).toContain("Unknown Stage");
  });
});

// ─── getStageFollowUpDelay ─────────────────────────────────────────────────

describe("getStageFollowUpDelay", () => {
  it("returns delay in milliseconds", () => {
    const delay = getStageFollowUpDelay("New Lead");
    // New Lead has 24h follow-up = 24 * 60 * 60 * 1000
    expect(delay).toBe(24 * 60 * 60 * 1000);
  });

  it("returns default 48h for unknown stage", () => {
    const delay = getStageFollowUpDelay("Unknown");
    expect(delay).toBe(48 * 60 * 60 * 1000);
  });
});

// ─── isAiProactiveAtStage ──────────────────────────────────────────────────

describe("isAiProactiveAtStage", () => {
  it("returns true for early stages (New Lead, Contacted)", () => {
    expect(isAiProactiveAtStage("New Lead")).toBe(true);
    expect(isAiProactiveAtStage("Contacted")).toBe(true);
  });

  it("returns false for production stages where AI should be passive", () => {
    expect(isAiProactiveAtStage("In Production")).toBe(false);
  });

  it("returns true by default for null/unknown", () => {
    expect(isAiProactiveAtStage(null)).toBe(true);
    expect(isAiProactiveAtStage(undefined)).toBe(true);
  });
});

// ─── isTerminalStage ───────────────────────────────────────────────────────

describe("isTerminalStage", () => {
  it("Delivered is terminal", () => {
    expect(isTerminalStage("Delivered")).toBe(true);
  });

  it("Not Qualified is terminal", () => {
    expect(isTerminalStage("Not Qualified")).toBe(true);
  });

  it("New Lead is not terminal", () => {
    expect(isTerminalStage("New Lead")).toBe(false);
  });

  it("unknown stage is not terminal by default", () => {
    expect(isTerminalStage("Unknown")).toBe(false);
    expect(isTerminalStage(null)).toBe(false);
  });
});

// ─── getPlaybookSummaryForLearning ─────────────────────────────────────────

describe("getPlaybookSummaryForLearning", () => {
  it("returns compact summary with key fields", () => {
    const summary = getPlaybookSummaryForLearning("Qualified");
    expect(summary).toContain("Qualified");
    expect(summary).toContain("goal:");
    expect(summary).toContain("approaches:");
    expect(summary).toContain("proactive:");
  });

  it("returns 'unknown_stage' for null/unknown", () => {
    expect(getPlaybookSummaryForLearning(null)).toBe("unknown_stage");
    expect(getPlaybookSummaryForLearning("Fake")).toBe("unknown_stage");
  });
});

// ─── Pipeline workflow integrity ───────────────────────────────────────────

describe("Pipeline workflow integrity", () => {
  it("nextStage chain follows the correct order", () => {
    const expectedChain = [
      "New Lead",
      "Contacted",
      "Qualified",
      "Quote Sent",
      "Paid - Proof Needed",
      "Proof Sent",
      "Approved + Deposit",
      "In Production",
      "Ready",
      "Delivered",
    ];

    let current = "New Lead";
    const visited: string[] = [current];

    while (true) {
      const pb = getStagePlaybook(current);
      expect(pb, `Missing playbook for: ${current}`).not.toBeNull();
      if (pb!.isTerminal || !pb!.nextStage) break;
      current = pb!.nextStage;
      visited.push(current);
    }

    expect(visited).toEqual(expectedChain);
  });

  it("follow-up delays increase as pipeline progresses (generally)", () => {
    // Early stages should have shorter follow-ups than production stages
    const earlyDelay = getStageFollowUpDelay("New Lead");
    const productionDelay = getStageFollowUpDelay("In Production");
    expect(productionDelay).toBeGreaterThanOrEqual(earlyDelay);
  });
});

// ─── ALL_STAGE_NAMES export ────────────────────────────────────────────────

describe("ALL_STAGE_NAMES", () => {
  it("exports all 11 stage names", () => {
    expect(ALL_STAGE_NAMES.length).toBe(11);
  });

  it("includes all Bulk Printing Pipeline stages", () => {
    const expected = [
      "New Lead", "Contacted", "Qualified", "Quote Sent",
      "Paid - Proof Needed", "Proof Sent", "Approved + Deposit",
      "In Production", "Ready", "Delivered", "Not Qualified",
    ];
    for (const name of expected) {
      expect(ALL_STAGE_NAMES, `Missing: ${name}`).toContain(name);
    }
  });
});
