/**
 * FINE-TUNING PIPELINE — Automated OpenAI LoRA Training
 *
 * Full lifecycle:
 *   1. Export winning pairs → JSONL (via training-export.ts)
 *   2. Upload JSONL to OpenAI Files API
 *   3. Create fine-tuning job
 *   4. Poll job status until complete
 *   5. Start A/B test (20% traffic to fine-tuned model)
 *   6. After 7 days, auto-promote if fine-tuned wins OR rollback
 *
 * Connected to:
 *   - _core/index.ts → Monday weekly schedule (after training export)
 *   - composer.ts → model selection for message generation
 *   - routers.ts → tRPC procedures for monitoring
 */

import { getDb } from "./db";
import { fineTuningJobs, trainingExports } from "../drizzle/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { ENV } from "./_core/env";
import { createTrainingExport, getTrainingExport } from "./training-export";

const BASE_MODEL = "gpt-4.1-mini-2025-04-14";
const MIN_TRAINING_PAIRS = 50; // Minimum pairs needed to start training
const AB_TEST_DURATION_DAYS = 7;
const AB_TRAFFIC_PERCENT = 20; // Start with 20% traffic to fine-tuned model
const MIN_AB_SAMPLES = 30; // Minimum samples before making promotion decision

// ============================================================
// STEP 1: Upload training file to OpenAI
// ============================================================
async function uploadTrainingFile(fileUrl: string): Promise<{ fileId: string } | null> {
  try {
    // Download the JSONL file from S3
    const response = await fetch(fileUrl);
    if (!response.ok) {
      console.error(`[FineTuning] Failed to download training file: ${response.status}`);
      return null;
    }
    const fileContent = await response.text();

    // Upload to OpenAI Files API
    const formData = new FormData();
    const blob = new Blob([fileContent], { type: "application/jsonl" });
    formData.append("file", blob, "training_data.jsonl");
    formData.append("purpose", "fine-tune");

    const uploadResponse = await fetch("https://api.openai.com/v1/files", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ENV.openaiApiKey}`,
      },
      body: formData,
    });

    if (!uploadResponse.ok) {
      const err = await uploadResponse.text();
      console.error(`[FineTuning] OpenAI file upload failed: ${err}`);
      return null;
    }

    const data = await uploadResponse.json();
    console.log(`[FineTuning] File uploaded: ${data.id} (${data.bytes} bytes)`);
    return { fileId: data.id };
  } catch (err) {
    console.error("[FineTuning] uploadTrainingFile error:", err);
    return null;
  }
}

// ============================================================
// STEP 2: Create fine-tuning job
// ============================================================
async function createFineTuningJob(fileId: string, epochs: number = 3): Promise<{ jobId: string } | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/fine_tuning/jobs", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ENV.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        training_file: fileId,
        model: BASE_MODEL,
        hyperparameters: {
          n_epochs: epochs,
        },
        suffix: `adorb-outreach-${Date.now()}`,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[FineTuning] Job creation failed: ${err}`);
      return null;
    }

    const data = await response.json();
    console.log(`[FineTuning] Job created: ${data.id} (status: ${data.status})`);
    return { jobId: data.id };
  } catch (err) {
    console.error("[FineTuning] createFineTuningJob error:", err);
    return null;
  }
}

// ============================================================
// STEP 3: Check job status
// ============================================================
async function checkJobStatus(jobId: string): Promise<{
  status: string;
  fineTunedModel?: string;
  error?: string;
} | null> {
  try {
    const response = await fetch(`https://api.openai.com/v1/fine_tuning/jobs/${jobId}`, {
      headers: {
        "Authorization": `Bearer ${ENV.openaiApiKey}`,
      },
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[FineTuning] Status check failed: ${err}`);
      return null;
    }

    const data = await response.json();
    return {
      status: data.status, // validating_files, queued, running, succeeded, failed, cancelled
      fineTunedModel: data.fine_tuned_model || undefined,
      error: data.error?.message || undefined,
    };
  } catch (err) {
    console.error("[FineTuning] checkJobStatus error:", err);
    return null;
  }
}

// ============================================================
// STEP 4: Cancel a job
// ============================================================
async function cancelJob(jobId: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.openai.com/v1/fine_tuning/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ENV.openaiApiKey}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// ORCHESTRATOR: Run the full weekly pipeline
// ============================================================

/**
 * Called by the Monday weekly schedule.
 * Orchestrates the full pipeline: export → upload → train → track.
 */
export async function runWeeklyFineTuning(): Promise<{
  action: string;
  details: string;
}> {
  const db = await getDb();
  if (!db) return { action: "skipped", details: "No database connection" };

  if (!ENV.openaiApiKey) {
    return { action: "skipped", details: "No OpenAI API key configured" };
  }

  try {
    // Check if there's already an active training job or A/B test
    const [activeJob] = await db.select()
      .from(fineTuningJobs)
      .where(
        sql`${fineTuningJobs.status} IN ('pending', 'uploading', 'training') OR ${fineTuningJobs.abTestActive} = 1`
      )
      .orderBy(desc(fineTuningJobs.createdAt))
      .limit(1);

    if (activeJob) {
      // If there's an active A/B test, check if it's ready for promotion
      if (activeJob.abTestActive) {
        return await evaluateAbTest(activeJob.id);
      }
      // If there's an active training job, poll its status
      return await pollActiveJob(activeJob.id);
    }

    // No active job — start a new training cycle
    return await startNewTrainingCycle();
  } catch (err) {
    console.error("[FineTuning] runWeeklyFineTuning error:", err);
    return { action: "error", details: String(err) };
  }
}

/**
 * Start a new training cycle: export → upload → train
 */
async function startNewTrainingCycle(): Promise<{ action: string; details: string }> {
  const db = await getDb();
  if (!db) return { action: "error", details: "No DB" };

  // Step 1: Create a training export
  const exportResult = await createTrainingExport("auto-weekly-" + new Date().toISOString().slice(0, 10), {
    minScore: 3,
    onlyReplied: true,
  });

  if (!exportResult) {
    return { action: "skipped", details: "Failed to create training export" };
  }

  // Wait for export to complete (poll for up to 60 seconds)
  let exportData: any = null;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    exportData = await getTrainingExport(exportResult.id);
    if (exportData?.status === "completed" || exportData?.status === "failed") break;
  }

  if (!exportData || exportData.status !== "completed") {
    return { action: "skipped", details: "Training export did not complete in time" };
  }

  if (exportData.totalPairs < MIN_TRAINING_PAIRS) {
    return {
      action: "skipped",
      details: `Only ${exportData.totalPairs} training pairs (need ${MIN_TRAINING_PAIRS}). Waiting for more data.`,
    };
  }

  // Step 2: Upload to OpenAI
  const uploadResult = await uploadTrainingFile(exportData.fileUrl);
  if (!uploadResult) {
    return { action: "error", details: "Failed to upload training file to OpenAI" };
  }

  // Step 3: Create fine-tuning job
  const jobResult = await createFineTuningJob(uploadResult.fileId);
  if (!jobResult) {
    return { action: "error", details: "Failed to create fine-tuning job" };
  }

  // Step 4: Record in database
  await db.insert(fineTuningJobs).values({
    openaiJobId: jobResult.jobId,
    openaiFileId: uploadResult.fileId,
    baseModel: BASE_MODEL,
    trainingExportId: exportResult.id,
    trainingPairs: exportData.totalPairs,
    status: "training",
  });

  console.log(`[FineTuning] New training cycle started: job=${jobResult.jobId}, pairs=${exportData.totalPairs}`);
  return {
    action: "training_started",
    details: `Job ${jobResult.jobId} started with ${exportData.totalPairs} training pairs`,
  };
}

/**
 * Poll an active training job and update status.
 */
async function pollActiveJob(jobDbId: number): Promise<{ action: string; details: string }> {
  const db = await getDb();
  if (!db) return { action: "error", details: "No DB" };

  const [job] = await db.select()
    .from(fineTuningJobs)
    .where(eq(fineTuningJobs.id, jobDbId))
    .limit(1);

  if (!job || !job.openaiJobId) {
    return { action: "error", details: "Job not found" };
  }

  const status = await checkJobStatus(job.openaiJobId);
  if (!status) {
    return { action: "error", details: "Failed to check job status" };
  }

  if (status.status === "succeeded" && status.fineTunedModel) {
    // Training complete — start A/B test
    await db.update(fineTuningJobs)
      .set({
        status: "succeeded",
        fineTunedModel: status.fineTunedModel,
        completedAt: new Date(),
        abTestActive: 1,
        abTrafficPercent: AB_TRAFFIC_PERCENT,
        abStartedAt: new Date(),
      })
      .where(eq(fineTuningJobs.id, jobDbId));

    console.log(`[FineTuning] Training complete! Model: ${status.fineTunedModel}. Starting A/B test at ${AB_TRAFFIC_PERCENT}%.`);
    return {
      action: "ab_test_started",
      details: `Model ${status.fineTunedModel} ready. A/B test started at ${AB_TRAFFIC_PERCENT}% traffic.`,
    };
  }

  if (status.status === "failed") {
    await db.update(fineTuningJobs)
      .set({ status: "failed", error: status.error || "Unknown error", completedAt: new Date() })
      .where(eq(fineTuningJobs.id, jobDbId));

    return { action: "failed", details: `Training failed: ${status.error}` };
  }

  // Still in progress
  await db.update(fineTuningJobs)
    .set({ status: status.status })
    .where(eq(fineTuningJobs.id, jobDbId));

  return { action: "polling", details: `Job status: ${status.status}` };
}

/**
 * Evaluate an active A/B test and decide whether to promote or rollback.
 */
async function evaluateAbTest(jobDbId: number): Promise<{ action: string; details: string }> {
  const db = await getDb();
  if (!db) return { action: "error", details: "No DB" };

  const [job] = await db.select()
    .from(fineTuningJobs)
    .where(eq(fineTuningJobs.id, jobDbId))
    .limit(1);

  if (!job) return { action: "error", details: "Job not found" };

  // Check if A/B test has run long enough
  const abStarted = job.abStartedAt ? new Date(job.abStartedAt).getTime() : 0;
  const daysSinceStart = (Date.now() - abStarted) / (1000 * 60 * 60 * 24);

  if (daysSinceStart < AB_TEST_DURATION_DAYS) {
    const totalSamples = job.abWins + job.abLosses + job.baseWins + job.baseLosses;
    return {
      action: "ab_test_running",
      details: `A/B test day ${Math.floor(daysSinceStart)}/${AB_TEST_DURATION_DAYS}. Samples: ${totalSamples}. Fine-tuned: ${job.abWins}W/${job.abLosses}L. Base: ${job.baseWins}W/${job.baseLosses}L.`,
    };
  }

  // Enough time has passed — make a decision
  const totalAbSamples = job.abWins + job.abLosses;
  const totalBaseSamples = job.baseWins + job.baseLosses;

  if (totalAbSamples < MIN_AB_SAMPLES || totalBaseSamples < MIN_AB_SAMPLES) {
    // Not enough data — extend the test
    return {
      action: "ab_test_extended",
      details: `Not enough samples (fine-tuned: ${totalAbSamples}, base: ${totalBaseSamples}, need ${MIN_AB_SAMPLES} each). Extending test.`,
    };
  }

  const fineTunedWinRate = totalAbSamples > 0 ? job.abWins / totalAbSamples : 0;
  const baseWinRate = totalBaseSamples > 0 ? job.baseWins / totalBaseSamples : 0;

  if (fineTunedWinRate > baseWinRate) {
    // Fine-tuned model wins — promote to 100%
    await db.update(fineTuningJobs)
      .set({
        abTestActive: 0,
        abTrafficPercent: 100,
        promoted: 1,
        promotedAt: new Date(),
      })
      .where(eq(fineTuningJobs.id, jobDbId));

    console.log(`[FineTuning] PROMOTED: ${job.fineTunedModel} (${(fineTunedWinRate * 100).toFixed(1)}% vs base ${(baseWinRate * 100).toFixed(1)}%)`);
    return {
      action: "promoted",
      details: `Fine-tuned model promoted! Win rate: ${(fineTunedWinRate * 100).toFixed(1)}% vs base ${(baseWinRate * 100).toFixed(1)}%.`,
    };
  } else {
    // Base model wins — rollback
    await db.update(fineTuningJobs)
      .set({
        abTestActive: 0,
        abTrafficPercent: 0,
        promoted: 0,
      })
      .where(eq(fineTuningJobs.id, jobDbId));

    console.log(`[FineTuning] ROLLBACK: Base model wins (${(baseWinRate * 100).toFixed(1)}% vs fine-tuned ${(fineTunedWinRate * 100).toFixed(1)}%)`);
    return {
      action: "rolled_back",
      details: `Fine-tuned model underperformed. Base: ${(baseWinRate * 100).toFixed(1)}% vs fine-tuned: ${(fineTunedWinRate * 100).toFixed(1)}%. Rolled back to base model.`,
    };
  }
}

// ============================================================
// MODEL SELECTION — Used by composer to pick which model to use
// ============================================================

/**
 * Returns the model ID to use for message composition.
 * If a fine-tuned model is active and the random roll hits the traffic %,
 * use the fine-tuned model. Otherwise use base.
 *
 * Returns: { model: string, isFineTuned: boolean, jobId: number | null }
 */
export async function selectModel(): Promise<{
  model: string;
  isFineTuned: boolean;
  jobId: number | null;
}> {
  const db = await getDb();
  if (!db) return { model: BASE_MODEL, isFineTuned: false, jobId: null };

  try {
    // Check for promoted model first (100% traffic)
    const [promoted] = await db.select()
      .from(fineTuningJobs)
      .where(and(
        eq(fineTuningJobs.promoted, 1),
        sql`${fineTuningJobs.fineTunedModel} IS NOT NULL`
      ))
      .orderBy(desc(fineTuningJobs.promotedAt))
      .limit(1);

    if (promoted && promoted.fineTunedModel) {
      return { model: promoted.fineTunedModel, isFineTuned: true, jobId: promoted.id };
    }

    // Check for active A/B test
    const [abTest] = await db.select()
      .from(fineTuningJobs)
      .where(and(
        eq(fineTuningJobs.abTestActive, 1),
        sql`${fineTuningJobs.fineTunedModel} IS NOT NULL`
      ))
      .orderBy(desc(fineTuningJobs.createdAt))
      .limit(1);

    if (abTest && abTest.fineTunedModel) {
      // Random roll to decide if this request goes to fine-tuned model
      const roll = Math.random() * 100;
      if (roll < abTest.abTrafficPercent) {
        return { model: abTest.fineTunedModel, isFineTuned: true, jobId: abTest.id };
      }
    }

    return { model: BASE_MODEL, isFineTuned: false, jobId: null };
  } catch (err) {
    console.error("[FineTuning] selectModel error:", err);
    return { model: BASE_MODEL, isFineTuned: false, jobId: null };
  }
}

/**
 * Record an A/B test outcome for the given job.
 * Called after a message is sent and its outcome is determined.
 */
export async function recordAbOutcome(
  jobId: number,
  isFineTuned: boolean,
  isPositive: boolean,
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    if (isFineTuned) {
      if (isPositive) {
        await db.update(fineTuningJobs)
          .set({ abWins: sql`abWins + 1` })
          .where(eq(fineTuningJobs.id, jobId));
      } else {
        await db.update(fineTuningJobs)
          .set({ abLosses: sql`abLosses + 1` })
          .where(eq(fineTuningJobs.id, jobId));
      }
    } else {
      if (isPositive) {
        await db.update(fineTuningJobs)
          .set({ baseWins: sql`baseWins + 1` })
          .where(eq(fineTuningJobs.id, jobId));
      } else {
        await db.update(fineTuningJobs)
          .set({ baseLosses: sql`baseLosses + 1` })
          .where(eq(fineTuningJobs.id, jobId));
      }
    }
  } catch (err) {
    console.error("[FineTuning] recordAbOutcome error:", err);
  }
}

/**
 * Get the current pipeline status for the dashboard.
 */
export async function getFineTuningStatus(): Promise<{
  currentJob: any | null;
  recentJobs: any[];
  activeModel: string;
  isFineTuned: boolean;
}> {
  const db = await getDb();
  if (!db) return { currentJob: null, recentJobs: [], activeModel: BASE_MODEL, isFineTuned: false };

  try {
    const recentJobs = await db.select()
      .from(fineTuningJobs)
      .orderBy(desc(fineTuningJobs.createdAt))
      .limit(10);

    const currentJob = recentJobs.find(j =>
      j.status === "training" || j.status === "uploading" || j.abTestActive === 1
    ) || null;

    const { model, isFineTuned } = await selectModel();

    return { currentJob, recentJobs, activeModel: model, isFineTuned };
  } catch (err) {
    console.error("[FineTuning] getFineTuningStatus error:", err);
    return { currentJob: null, recentJobs: [], activeModel: BASE_MODEL, isFineTuned: false };
  }
}
