/**
 * TRAINING EXPORT — LoRA Fine-Tuning Data Pipeline (Decision 9)
 *
 * Generates JSONL training pairs from successful conversations for
 * fine-tuning a custom model. Two data sources:
 *   1. LEGACY: brain_council_audit → message_outcomes (old 4-brain pipeline)
 *   2. SINGLE BRAIN: decision_log → message_outcomes (new single-brain, promptVersion='v3.0'+)
 *
 * The single-brain path stores the final message in decision_log.brainReasoning
 * and links to message_outcomes via decisionLogId.
 *
 * Format: OpenAI fine-tuning JSONL
 * { "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }] }
 *
 * Connected to:
 *   - /self-learning → "Training Export" tab (trigger exports, view history)
 *   - routers.ts → tRPC procedures for export management
 *   - S3 → stores exported JSONL files
 */

import { getDb } from "./db";
import { trainingExports } from "../drizzle/schema";
import { eq, sql, desc } from "drizzle-orm";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";

interface TrainingMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

interface TrainingPair {
  messages: TrainingMessage[];
}

interface ExportFilter {
  minScore?: number;       // Minimum outcome score (1-5)
  frameworks?: string[];   // Only include specific frameworks
  channels?: string[];     // Only include specific channels
  dateRange?: { from: number; to: number }; // Unix ms timestamps
  onlyReplied?: boolean;   // Only include messages that got a reply
  onlyConverted?: boolean; // Only include messages that led to conversion
  promptVersion?: string;  // Filter by specific prompt version (e.g., 'v3.0')
  source?: "all" | "legacy" | "single_brain"; // Which data source to use
}

const SYSTEM_PROMPT_TEMPLATE = `You are a sales representative for Adorb Custom Tees, a custom printing company specializing in t-shirts, apparel, and DTF transfers. You communicate in a warm, direct, confident tone — like texting a friend who runs a printing business. You personalize every message based on the lead's context and never send generic templates.`;

// ── Helper: Build WHERE clause parts from filter ────────────────────────
function buildFilterWhere(filter: ExportFilter, prefix: "mo"): string[] {
  const parts: string[] = [
    `(${prefix}.gotReply = 1 OR ${prefix}.converted = 1)`, // Only successful outcomes
  ];
  if (filter.frameworks && filter.frameworks.length > 0) {
    const fwList = filter.frameworks.map(f => `'${f.replace(/'/g, "''")}'`).join(",");
    parts.push(`${prefix}.framework IN (${fwList})`);
  }
  if (filter.channels && filter.channels.length > 0) {
    const chList = filter.channels.map(c => `'${c.replace(/'/g, "''")}'`).join(",");
    parts.push(`${prefix}.channel IN (${chList})`);
  }
  if (filter.dateRange) {
    parts.push(`${prefix}.createdAt >= '${new Date(filter.dateRange.from).toISOString().slice(0, 19)}'`);
    parts.push(`${prefix}.createdAt <= '${new Date(filter.dateRange.to).toISOString().slice(0, 19)}'`);
  }
  if (filter.onlyReplied) {
    parts.push(`${prefix}.gotReply = 1`);
  }
  if (filter.onlyConverted) {
    parts.push(`${prefix}.converted = 1`);
  }
  return parts;
}

// ── LEGACY PATH: Generate pairs from brain_council_audit ────────────────
async function generateLegacyPairs(filter: ExportFilter): Promise<TrainingPair[]> {
  const db = await getDb();
  if (!db) return [];
  const pairs: TrainingPair[] = [];

  try {
    const whereParts = buildFilterWhere(filter, "mo");
    if (filter.minScore) {
      whereParts.push(`bca.qcScore >= ${Number(filter.minScore) * 20}`);
    }
    const whereClause = whereParts.join(" AND ");

    const outcomes = await db.execute(sql.raw(`
      SELECT
        mo.leadId,
        mo.auditId,
        mo.framework,
        mo.channel,
        bca.qcScore,
        COALESCE(bca.finalMessage, bca.composedMessage) as sentMessage,
        bca.incomingMessage,
        bca.strategyApproach,
        l.name as leadName,
        l.businessName,
        l.omnisendSegment,
        l.pipelineStage
      FROM message_outcomes mo
      JOIN leads l ON l.id = mo.leadId
      JOIN brain_council_audit bca ON bca.id = mo.auditId
      WHERE mo.decisionLogId IS NULL AND ${whereClause}
      ORDER BY bca.qcScore DESC
      LIMIT 250
    `));

    const rows = Array.isArray((outcomes as any)[0]) ? (outcomes as any)[0] : outcomes;
    if (!Array.isArray(rows) || rows.length === 0) return [];

    for (const outcome of rows) {
      try {
        const sentMessage = outcome.sentMessage;
        if (!sentMessage || sentMessage.length < 20) continue;

        const leadContext = [
          outcome.leadName ? `Lead: ${outcome.leadName}` : "",
          outcome.businessName ? `Business: ${outcome.businessName}` : "",
          outcome.omnisendSegment ? `Segment: ${outcome.omnisendSegment}` : "",
          outcome.pipelineStage ? `Stage: ${outcome.pipelineStage}` : "",
          outcome.framework ? `Framework: ${outcome.framework}` : "",
          outcome.channel ? `Channel: ${outcome.channel}` : "",
          outcome.strategyApproach ? `Approach: ${outcome.strategyApproach}` : "",
        ].filter(Boolean).join(", ");

        const userContent = outcome.incomingMessage
          ? `[Context: ${leadContext}]\n\nIncoming message: ${outcome.incomingMessage}`
          : `[Context: ${leadContext}]\n\nGenerate an outreach message for this lead.`;

        pairs.push({
          messages: [
            { role: "system", content: SYSTEM_PROMPT_TEMPLATE },
            { role: "user", content: userContent },
            { role: "assistant", content: sentMessage },
          ],
        });
      } catch {
        continue;
      }
    }
    return pairs;
  } catch (err) {
    console.error("[TrainingExport] generateLegacyPairs error:", err);
    return [];
  }
}

// ── SINGLE BRAIN PATH: Generate pairs from decision_log ─────────────────
async function generateSingleBrainPairs(filter: ExportFilter): Promise<TrainingPair[]> {
  const db = await getDb();
  if (!db) return [];
  const pairs: TrainingPair[] = [];

  try {
    const whereParts = buildFilterWhere(filter, "mo");
    // Only include decision_log entries (single brain)
    whereParts.push(`mo.decisionLogId IS NOT NULL`);
    // Filter by prompt version if specified
    if (filter.promptVersion) {
      whereParts.push(`dl.promptVersion = '${filter.promptVersion.replace(/'/g, "''")}'`);
    } else {
      // Default: only v3.0+ (single brain era)
      whereParts.push(`dl.promptVersion IS NOT NULL`);
    }
    // Only include entries where the message was actually sent (outputGuardResult = 'pass' or starts with 'corrected:')
    whereParts.push(`(dl.outputGuardResult = 'pass' OR dl.outputGuardResult LIKE 'corrected:%')`);
    // Must have a message (brainReasoning stores the final message text)
    whereParts.push(`dl.brainReasoning IS NOT NULL`);
    whereParts.push(`LENGTH(dl.brainReasoning) >= 20`);

    const whereClause = whereParts.join(" AND ");

    const outcomes = await db.execute(sql.raw(`
      SELECT
        mo.leadId,
        mo.decisionLogId,
        mo.framework,
        mo.channel,
        dl.brainReasoning as sentMessage,
        dl.trigger as triggerType,
        dl.promptVersion,
        dl.channel as dlChannel,
        l.name as leadName,
        l.businessName,
        l.omnisendSegment,
        l.pipelineStage
      FROM message_outcomes mo
      JOIN decision_log dl ON dl.id = mo.decisionLogId
      JOIN leads l ON l.id = mo.leadId
      WHERE ${whereClause}
      ORDER BY mo.createdAt DESC
      LIMIT 500
    `));

    const rows = Array.isArray((outcomes as any)[0]) ? (outcomes as any)[0] : outcomes;
    if (!Array.isArray(rows) || rows.length === 0) return [];

    for (const outcome of rows) {
      try {
        const sentMessage = outcome.sentMessage;
        if (!sentMessage || sentMessage.length < 20) continue;

        const leadContext = [
          outcome.leadName ? `Lead: ${outcome.leadName}` : "",
          outcome.businessName ? `Business: ${outcome.businessName}` : "",
          outcome.omnisendSegment ? `Segment: ${outcome.omnisendSegment}` : "",
          outcome.pipelineStage ? `Stage: ${outcome.pipelineStage}` : "",
          outcome.framework ? `Framework: ${outcome.framework}` : "",
          (outcome.channel || outcome.dlChannel) ? `Channel: ${outcome.channel || outcome.dlChannel}` : "",
        ].filter(Boolean).join(", ");

        // Build user message based on trigger type
        const isInbound = outcome.triggerType === "inbound_reply";
        const userContent = isInbound
          ? `[Context: ${leadContext}]\n\nTrigger: inbound_reply. The lead sent a message. Compose your response.`
          : `[Context: ${leadContext}]\n\nTrigger: ${outcome.triggerType || "proactive_follow_up"}. Compose an outreach message for this lead.`;

        pairs.push({
          messages: [
            { role: "system", content: SYSTEM_PROMPT_TEMPLATE },
            { role: "user", content: userContent },
            { role: "assistant", content: sentMessage },
          ],
        });
      } catch {
        continue;
      }
    }
    return pairs;
  } catch (err) {
    console.error("[TrainingExport] generateSingleBrainPairs error:", err);
    return [];
  }
}

/**
 * Generate training pairs from both legacy and single-brain sources.
 * Merges results, deduplicates by leadId+message, and returns up to 500 pairs.
 */
async function generateTrainingPairs(filter: ExportFilter): Promise<TrainingPair[]> {
  const source = filter.source || "all";

  const [legacyPairs, singleBrainPairs] = await Promise.all([
    source === "single_brain" ? Promise.resolve([]) : generateLegacyPairs(filter),
    source === "legacy" ? Promise.resolve([]) : generateSingleBrainPairs(filter),
  ]);

  // Single brain pairs are preferred (newer, higher quality) — put them first
  const combined = [...singleBrainPairs, ...legacyPairs];

  // Deduplicate by assistant message content (same message shouldn't appear twice)
  const seen = new Set<string>();
  const deduped: TrainingPair[] = [];
  for (const pair of combined) {
    const assistantMsg = pair.messages.find(m => m.role === "assistant")?.content || "";
    const key = assistantMsg.slice(0, 100); // Use first 100 chars as dedup key
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(pair);
    }
  }

  return deduped.slice(0, 500);
}

/**
 * Create a training export job.
 */
export async function createTrainingExport(
  exportName: string,
  filter: ExportFilter = {},
): Promise<{ id: number; status: string } | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const [result] = await db.insert(trainingExports).values({
      exportName,
      format: "jsonl",
      totalPairs: 0,
      filterCriteria: filter as any,
      status: "generating",
    }).$returningId();

    const exportId = result.id;

    // Generate in background (non-blocking)
    generateAndUpload(exportId, filter).catch(err => {
      console.error(`[TrainingExport] Background generation failed for export ${exportId}:`, err);
    });

    return { id: exportId, status: "generating" };
  } catch (err) {
    console.error("[TrainingExport] createTrainingExport error:", err);
    return null;
  }
}

async function generateAndUpload(exportId: number, filter: ExportFilter): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    const pairs = await generateTrainingPairs(filter);

    if (pairs.length === 0) {
      await db.update(trainingExports)
        .set({ status: "failed", totalPairs: 0 })
        .where(eq(trainingExports.id, exportId));
      return;
    }

    // Convert to JSONL format
    const jsonl = pairs.map(p => JSON.stringify(p)).join("\n");
    const buffer = Buffer.from(jsonl, "utf-8");

    // Upload to S3
    const fileKey = `training-exports/export-${exportId}-${nanoid(8)}.jsonl`;
    const { url } = await storagePut(fileKey, buffer, "application/jsonl");

    // Update export record
    await db.update(trainingExports)
      .set({
        status: "completed",
        totalPairs: pairs.length,
        fileUrl: url,
        fileKey,
        generatedAt: new Date(),
      })
      .where(eq(trainingExports.id, exportId));

    console.log(`[TrainingExport] Export ${exportId} completed: ${pairs.length} pairs, uploaded to ${fileKey}`);
  } catch (err) {
    console.error(`[TrainingExport] generateAndUpload error for export ${exportId}:`, err);
    const db2 = await getDb();
    if (db2) {
      await db2.update(trainingExports)
        .set({ status: "failed" })
        .where(eq(trainingExports.id, exportId));
    }
  }
}

/**
 * List all training exports.
 */
export async function listTrainingExports(): Promise<any[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    return db.select()
      .from(trainingExports)
      .orderBy(desc(trainingExports.createdAt))
      .limit(20);
  } catch (err) {
    console.error("[TrainingExport] listTrainingExports error:", err);
    return [];
  }
}

/**
 * Get a single export by ID.
 */
export async function getTrainingExport(id: number): Promise<any | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const [result] = await db.select()
      .from(trainingExports)
      .where(eq(trainingExports.id, id))
      .limit(1);
    return result || null;
  } catch (err) {
    console.error("[TrainingExport] getTrainingExport error:", err);
    return null;
  }
}
