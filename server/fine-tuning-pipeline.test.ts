import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Tests for the Fine-Tuning Pipeline (Decision 9 + LoRA automation)
 * 
 * Validates:
 * 1. Pipeline module structure and exports
 * 2. Model selection logic (base vs fine-tuned)
 * 3. A/B outcome recording
 * 4. Weekly schedule integration
 * 5. Composer model override wiring
 * 6. Schema correctness
 */

const PIPELINE_PATH = path.join(__dirname, "fine-tuning-pipeline.ts");
const COMPOSER_PATH = path.join(__dirname, "composer.ts");
const OUTCOME_PATH = path.join(__dirname, "outcome-engine.ts");
const INDEX_PATH = path.join(__dirname, "_core/index.ts");
const SCHEMA_PATH = path.join(__dirname, "../drizzle/schema.ts");
const BRAIN_TYPES_PATH = path.join(__dirname, "brain-types.ts");
const LLM_PATH = path.join(__dirname, "_core/llm.ts");
const ENV_PATH = path.join(__dirname, "_core/env.ts");

describe("Fine-Tuning Pipeline Module", () => {
  const pipelineCode = fs.readFileSync(PIPELINE_PATH, "utf-8");

  it("exports runWeeklyFineTuning function", () => {
    expect(pipelineCode).toContain("export async function runWeeklyFineTuning()");
  });

  it("exports selectModel function", () => {
    expect(pipelineCode).toContain("export async function selectModel()");
  });

  it("exports recordAbOutcome function", () => {
    expect(pipelineCode).toContain("export async function recordAbOutcome(");
  });

  it("exports getFineTuningStatus function", () => {
    expect(pipelineCode).toContain("export async function getFineTuningStatus()");
  });

  it("uses correct OpenAI fine-tuning API endpoint", () => {
    expect(pipelineCode).toContain("https://api.openai.com/v1/fine_tuning/jobs");
  });

  it("uses correct OpenAI files API endpoint", () => {
    expect(pipelineCode).toContain("https://api.openai.com/v1/files");
  });

  it("has minimum training pairs threshold", () => {
    expect(pipelineCode).toMatch(/MIN_TRAINING_PAIRS\s*=\s*50/);
  });

  it("has 7-day A/B test duration", () => {
    expect(pipelineCode).toMatch(/AB_TEST_DURATION_DAYS\s*=\s*7/);
  });

  it("starts A/B test at 20% traffic", () => {
    expect(pipelineCode).toMatch(/AB_TRAFFIC_PERCENT\s*=\s*20/);
  });

  it("requires minimum 30 samples before promotion decision", () => {
    expect(pipelineCode).toMatch(/MIN_AB_SAMPLES\s*=\s*30/);
  });

  it("uses gpt-4.1-mini as base model", () => {
    expect(pipelineCode).toContain("gpt-4.1-mini-2025-04-14");
  });

  it("checks for active job before starting new cycle", () => {
    expect(pipelineCode).toContain("abTestActive");
    expect(pipelineCode).toContain("training");
  });

  it("handles job cancellation", () => {
    expect(pipelineCode).toContain("async function cancelJob(jobId: string)");
  });

  it("evaluates A/B test with win rate comparison", () => {
    expect(pipelineCode).toContain("fineTunedWinRate > baseWinRate");
  });

  it("promotes winning model to 100%", () => {
    expect(pipelineCode).toContain("promoted: 1");
    expect(pipelineCode).toContain("abTrafficPercent: 100");
  });

  it("rolls back losing model to 0%", () => {
    expect(pipelineCode).toContain("abTrafficPercent: 0");
    expect(pipelineCode).toContain("promoted: 0");
  });

  it("skips if no OpenAI API key", () => {
    expect(pipelineCode).toContain("if (!ENV.openaiApiKey)");
  });
});

describe("Model Selection Logic", () => {
  const pipelineCode = fs.readFileSync(PIPELINE_PATH, "utf-8");

  it("checks for promoted model first (100% traffic)", () => {
    expect(pipelineCode).toContain("eq(fineTuningJobs.promoted, 1)");
  });

  it("checks for active A/B test second", () => {
    expect(pipelineCode).toContain("eq(fineTuningJobs.abTestActive, 1)");
  });

  it("uses random roll for traffic splitting", () => {
    expect(pipelineCode).toContain("Math.random() * 100");
    expect(pipelineCode).toContain("roll < abTest.abTrafficPercent");
  });

  it("falls back to base model when no fine-tuned model active", () => {
    expect(pipelineCode).toContain("return { model: BASE_MODEL, isFineTuned: false, jobId: null }");
  });
});

describe("Composer Model Override Wiring", () => {
  const composerCode = fs.readFileSync(COMPOSER_PATH, "utf-8");

  it("imports selectModel from fine-tuning-pipeline", () => {
    expect(composerCode).toContain('import { selectModel } from "./fine-tuning-pipeline"');
  });

  it("calls selectModel before invokeLLM", () => {
    expect(composerCode).toContain("const modelSelection = await selectModel()");
  });

  it("passes model to invokeLLM when fine-tuned", () => {
    expect(composerCode).toContain("model: modelSelection.isFineTuned ? modelSelection.model : undefined");
  });

  it("attaches _modelMeta to composed message", () => {
    expect(composerCode).toContain("parsed._modelMeta = {");
    expect(composerCode).toContain("model: modelSelection.model");
    expect(composerCode).toContain("isFineTuned: modelSelection.isFineTuned");
    expect(composerCode).toContain("jobId: modelSelection.jobId");
  });
});

describe("Outcome Engine A/B Recording", () => {
  const outcomeCode = fs.readFileSync(OUTCOME_PATH, "utf-8");

  it("imports recordAbOutcome from fine-tuning-pipeline", () => {
    expect(outcomeCode).toContain('import { recordAbOutcome } from "./fine-tuning-pipeline"');
  });

  it("checks for fineTuningJobId on audit entry", () => {
    expect(outcomeCode).toContain("(audit as any).fineTuningJobId");
  });

  it("records positive outcome for positive sentiment or fast reply", () => {
    expect(outcomeCode).toContain('sentiment === "positive" || replyMinutes < 30');
  });

  it("determines isFineTuned by checking modelUsed", () => {
    expect(outcomeCode).toContain('(audit as any).modelUsed !== "gemini-2.5-flash"');
  });

  it("wraps in try-catch for non-fatal error handling", () => {
    expect(outcomeCode).toContain("Fine-tuning A/B recording error (non-fatal)");
  });
});

describe("Brain Council Audit Model Tracking", () => {
  const schemaCode = fs.readFileSync(SCHEMA_PATH, "utf-8");
  const brainTypesCode = fs.readFileSync(BRAIN_TYPES_PATH, "utf-8");

  it("schema has modelUsed column in brain_council_audit", () => {
    expect(schemaCode).toContain('modelUsed: varchar("modelUsed", { length: 128 })');
  });

  it("schema has fineTuningJobId column in brain_council_audit", () => {
    expect(schemaCode).toContain('fineTuningJobId: int("fineTuningJobId")');
  });

  it("ComposedMessage interface has _modelMeta", () => {
    expect(brainTypesCode).toContain("_modelMeta?: {");
    expect(brainTypesCode).toContain("model: string");
    expect(brainTypesCode).toContain("isFineTuned: boolean");
    expect(brainTypesCode).toContain("jobId: number | null");
  });
});

describe("LLM Model Override Support", () => {
  const llmCode = fs.readFileSync(LLM_PATH, "utf-8");

  it("InvokeParams accepts optional model parameter", () => {
    expect(llmCode).toContain("model?: string;");
  });

  it("uses params.model when provided", () => {
    expect(llmCode).toContain('params.model || "gemini-2.5-flash"');
  });
});

describe("Environment Configuration", () => {
  const envCode = fs.readFileSync(ENV_PATH, "utf-8");

  it("ENV includes openaiApiKey", () => {
    expect(envCode).toContain("openaiApiKey: process.env.OPENAI_API_KEY");
  });
});

describe("fine_tuning_jobs Schema", () => {
  const schemaCode = fs.readFileSync(SCHEMA_PATH, "utf-8");

  it("has fine_tuning_jobs table", () => {
    expect(schemaCode).toContain('mysqlTable("fine_tuning_jobs"');
  });

  it("has openaiJobId column", () => {
    expect(schemaCode).toContain('openaiJobId: varchar("openaiJobId"');
  });

  it("has openaiFileId column", () => {
    expect(schemaCode).toContain('openaiFileId: varchar("openaiFileId"');
  });

  it("has baseModel column with default", () => {
    expect(schemaCode).toContain('baseModel: varchar("baseModel"');
  });

  it("has fineTunedModel column", () => {
    expect(schemaCode).toContain('fineTunedModel: varchar("fineTunedModel"');
  });

  it("has A/B test tracking columns", () => {
    expect(schemaCode).toContain('abTestActive: tinyint("abTestActive")');
    expect(schemaCode).toContain('abTrafficPercent: int("abTrafficPercent")');
    expect(schemaCode).toContain('abWins: int("abWins")');
    expect(schemaCode).toContain('abLosses: int("abLosses")');
    expect(schemaCode).toContain('baseWins: int("baseWins")');
    expect(schemaCode).toContain('baseLosses: int("baseLosses")');
  });

  it("has promoted column", () => {
    expect(schemaCode).toContain('promoted: tinyint("promoted")');
  });

  it("has status column", () => {
    expect(schemaCode).toContain('status: varchar("status"');
  });
});

describe("Monday Weekly Schedule Integration", () => {
  const indexCode = fs.readFileSync(INDEX_PATH, "utf-8");

  it("imports runWeeklyFineTuning in weekly review", () => {
    expect(indexCode).toContain('import("../fine-tuning-pipeline")');
  });

  it("calls runWeeklyFineTuning as Step 4", () => {
    expect(indexCode).toContain("Step 4: Fine-Tuning Pipeline");
    expect(indexCode).toContain("runWeeklyFineTuning");
  });

  it("logs fine-tuning result", () => {
    expect(indexCode).toContain("[WeeklyReview/FineTuning]");
  });

  it("wraps in try-catch for non-fatal error handling", () => {
    expect(indexCode).toContain('[WeeklyReview/FineTuning] Error:');
  });
});
