/**
 * TRAINING EXPORT — LoRA Fine-Tuning Data Pipeline (Decision 9)
 *
 * Generates JSONL training pairs from successful conversations for
 * fine-tuning a custom model. Exports system+user→assistant pairs
 * from conversations that resulted in positive outcomes.
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

interface TrainingPair {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

interface ExportFilter {
  minScore?: number;       // Minimum outcome score (1-5)
  frameworks?: string[];   // Only include specific frameworks
  channels?: string[];     // Only include specific channels
  dateRange?: { from: number; to: number }; // Unix ms timestamps
  onlyReplied?: boolean;   // Only include messages that got a reply
  onlyConverted?: boolean; // Only include messages that led to conversion
}

const SYSTEM_PROMPT_TEMPLATE = `You are a sales representative for Adorb Custom Tees, a custom printing company specializing in t-shirts, apparel, and DTF transfers. You communicate in a warm, direct, confident tone — like texting a friend who runs a printing business. You personalize every message based on the lead's context and never send generic templates.`;

/**
 * Generate training pairs from successful conversations.
 */
async function generateTrainingPairs(filter: ExportFilter): Promise<TrainingPair[]> {
  const db = await getDb();
  if (!db) return [];

  const pairs: TrainingPair[] = [];

  try {
    // Build WHERE clauses
    const whereParts: string[] = [
      "(mo.gotReply = 1 OR mo.converted = 1)", // Only successful outcomes
    ];

    if (filter.minScore) {
      // Use QC score from brain_council_audit as quality proxy
      whereParts.push(`bca.qcScore >= ${Number(filter.minScore) * 20}`);
    }
    if (filter.frameworks && filter.frameworks.length > 0) {
      const fwList = filter.frameworks.map(f => `'${f.replace(/'/g, "''")}'`).join(",");
      whereParts.push(`mo.framework IN (${fwList})`);
    }
    if (filter.channels && filter.channels.length > 0) {
      const chList = filter.channels.map(c => `'${c.replace(/'/g, "''")}'`).join(",");
      whereParts.push(`mo.channel IN (${chList})`);
    }
    if (filter.dateRange) {
      whereParts.push(`mo.createdAt >= '${new Date(filter.dateRange.from).toISOString().slice(0, 19)}'`);
      whereParts.push(`mo.createdAt <= '${new Date(filter.dateRange.to).toISOString().slice(0, 19)}'`);
    }
    if (filter.onlyReplied) {
      whereParts.push(`mo.gotReply = 1`);
    }
    if (filter.onlyConverted) {
      whereParts.push(`mo.converted = 1`);
    }

    const whereClause = whereParts.join(" AND ");

    // Get successful message outcomes with the actual sent message from brain_council_audit
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
      WHERE ${whereClause}
      ORDER BY bca.qcScore DESC
      LIMIT 500
    `));

    const rows = Array.isArray((outcomes as any)[0]) ? (outcomes as any)[0] : outcomes;
    if (!Array.isArray(rows) || rows.length === 0) return [];

    // For each successful outcome, build the training pair directly from audit data
    for (const outcome of rows) {
      try {
        const sentMessage = outcome.sentMessage;
        if (!sentMessage || sentMessage.length < 20) continue;

        // Build context from lead info
        const leadContext = [
          outcome.leadName ? `Lead: ${outcome.leadName}` : "",
          outcome.businessName ? `Business: ${outcome.businessName}` : "",
          outcome.omnisendSegment ? `Segment: ${outcome.omnisendSegment}` : "",
          outcome.pipelineStage ? `Stage: ${outcome.pipelineStage}` : "",
          outcome.framework ? `Framework: ${outcome.framework}` : "",
          outcome.channel ? `Channel: ${outcome.channel}` : "",
          outcome.strategyApproach ? `Approach: ${outcome.strategyApproach}` : "",
        ].filter(Boolean).join(", ");

        // Build user message (incoming context + any inbound message that triggered the council)
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
    console.error("[TrainingExport] generateTrainingPairs error:", err);
    return [];
  }
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
