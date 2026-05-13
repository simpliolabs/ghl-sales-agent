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
import { trainingExports, conversations, messageOutcomes, leads } from "../drizzle/schema";
import { eq, and, sql, desc, gte } from "drizzle-orm";
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
    // Build query conditions
    const conditions: any[] = [
      sql`mo.gotReply = 1 OR mo.converted = 1`, // Only successful outcomes
    ];

    if (filter.minScore) {
      conditions.push(sql`mo.outcomeScore >= ${filter.minScore}`);
    }
    if (filter.frameworks && filter.frameworks.length > 0) {
      const fwList = filter.frameworks.map(f => `'${f}'`).join(",");
      conditions.push(sql`mo.framework IN (${sql.raw(fwList)})`);
    }
    if (filter.channels && filter.channels.length > 0) {
      const chList = filter.channels.map(c => `'${c}'`).join(",");
      conditions.push(sql`mo.channel IN (${sql.raw(chList)})`);
    }
    if (filter.dateRange) {
      conditions.push(sql`mo.createdAt >= ${new Date(filter.dateRange.from)}`);
      conditions.push(sql`mo.createdAt <= ${new Date(filter.dateRange.to)}`);
    }
    if (filter.onlyReplied) {
      conditions.push(sql`mo.gotReply = 1`);
    }
    if (filter.onlyConverted) {
      conditions.push(sql`mo.converted = 1`);
    }

    // Get successful message outcomes with their conversation context
    const outcomes = await db.execute(sql`
      SELECT
        mo.leadId,
        mo.conversationId,
        mo.framework,
        mo.channel,
        mo.outcomeScore,
        l.name as leadName,
        l.businessName,
        l.omnisendSegment,
        l.pipelineStage
      FROM message_outcomes mo
      JOIN leads l ON l.id = mo.leadId
      WHERE ${sql.raw(conditions.map(c => `(${c.queryChunks?.map((ch: any) => ch.value || ch).join("") || c})`).join(" AND "))}
      ORDER BY mo.outcomeScore DESC
      LIMIT 500
    `);

    const rows = Array.isArray((outcomes as any)[0]) ? (outcomes as any)[0] : outcomes;
    if (!Array.isArray(rows) || rows.length === 0) return [];

    // For each successful outcome, build the training pair
    for (const outcome of rows) {
      try {
        // Get the conversation messages around this outcome
        const convMessages = await db.select({
          direction: conversations.direction,
          messageBody: conversations.messageBody,
          senderType: conversations.senderType,
          channel: conversations.channel,
          timestamp: conversations.timestamp,
        })
          .from(conversations)
          .where(eq(conversations.leadId, outcome.leadId))
          .orderBy(conversations.timestamp)
          .limit(20);

        if (convMessages.length < 2) continue;

        // Find the AI outbound message and the preceding context
        const aiMessages = convMessages.filter(m => m.senderType === "ai" && m.direction === "outbound");
        const leadMessages = convMessages.filter(m => m.direction === "inbound");

        if (aiMessages.length === 0) continue;

        // Build context from lead info
        const leadContext = [
          outcome.leadName ? `Lead: ${outcome.leadName}` : "",
          outcome.businessName ? `Business: ${outcome.businessName}` : "",
          outcome.omnisendSegment ? `Segment: ${outcome.omnisendSegment}` : "",
          outcome.pipelineStage ? `Stage: ${outcome.pipelineStage}` : "",
          outcome.framework ? `Framework: ${outcome.framework}` : "",
          outcome.channel ? `Channel: ${outcome.channel}` : "",
        ].filter(Boolean).join(", ");

        // Build user message (incoming context)
        const lastInbound = leadMessages[leadMessages.length - 1];
        const userContent = lastInbound?.messageBody
          ? `[Context: ${leadContext}]\n\nIncoming message: ${lastInbound.messageBody}`
          : `[Context: ${leadContext}]\n\nGenerate an outreach message for this lead.`;

        // Build assistant message (the successful AI response)
        // Use the most recent AI message as the training target
        const bestAiMessage = aiMessages[aiMessages.length - 1];
        if (!bestAiMessage?.messageBody || bestAiMessage.messageBody.length < 20) continue;

        pairs.push({
          messages: [
            { role: "system", content: SYSTEM_PROMPT_TEMPLATE },
            { role: "user", content: userContent },
            { role: "assistant", content: bestAiMessage.messageBody },
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
