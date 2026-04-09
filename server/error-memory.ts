/**
 * ERROR MEMORY — Self-healing error pattern detection for Adorb Outreach
 * 
 * Implements the memory-self-heal pattern from ClawHub:
 * - Records system errors with signatures for dedup
 * - Tracks known fixes for recurring errors
 * - Before retrying, checks if the error has a known fix
 * - Auto-applies known fixes when possible
 * 
 * Error types:
 * - ghl_api: GHL API failures (rate limits, auth, timeouts)
 * - llm_hallucination: LLM produced invalid/unsafe content
 * - channel_mismatch: Tried to send on wrong channel
 * - webhook_parse: Failed to parse webhook payload
 * - db_error: Database query failures
 * - send_failure: Message send failed (email/SMS/chat)
 * - state_invalid: Invalid state transition attempted
 */

import { eq, sql, desc } from "drizzle-orm";
import { getDb } from "./db";
import { errorMemory, type InsertErrorMemoryEntry } from "../drizzle/schema";
import { createHash } from "crypto";

// --- TYPES ---
export type ErrorType =
  | "ghl_api"
  | "llm_hallucination"
  | "channel_mismatch"
  | "webhook_parse"
  | "db_error"
  | "send_failure"
  | "state_invalid"
  | "rate_limit"
  | "auth_failure"
  | "unknown";

export interface ErrorRecord {
  errorType: ErrorType;
  errorMessage: string;
  context?: string;          // Additional context (e.g., contactId, channel, endpoint)
  rootCause?: string;        // Known root cause
  knownFix?: string;         // Description of the fix
  prevention?: string;       // How to prevent in future
}

export interface ErrorLookupResult {
  found: boolean;
  signature: string;
  occurrenceCount: number;
  knownFix: string | null;
  rootCause: string | null;
  prevention: string | null;
  fixApplied: boolean;
}

// --- CONSTANTS ---
const MAX_ERROR_MESSAGE_LENGTH = 500;
const STALE_ERROR_DAYS = 90; // Errors older than 90 days without recurrence can be pruned

// =================================================================
// 1. RECORD — Log an error with its signature
// =================================================================

/**
 * Record a system error. If the same error signature already exists,
 * increment the occurrence count instead of creating a new record.
 */
export async function recordError(record: ErrorRecord): Promise<ErrorLookupResult> {
  const signature = generateSignature(record.errorType, record.errorMessage, record.context);
  const db = await getDb();

  if (!db) {
    return { found: false, signature, occurrenceCount: 0, knownFix: null, rootCause: null, prevention: null, fixApplied: false };
  }

  const now = Date.now();

  try {
    // Check if this error signature already exists
    const [existing] = await db.select()
      .from(errorMemory)
      .where(eq(errorMemory.errorSignature, signature))
      .limit(1);

    if (existing) {
      // Update occurrence count and timestamp
      await db.update(errorMemory)
        .set({
          occurrenceCount: sql`${errorMemory.occurrenceCount} + 1`,
          lastOccurredAt: now,
          updatedAt: now,
          // Update root cause / fix if provided and not already set
          ...(record.rootCause && !existing.rootCause ? { rootCause: record.rootCause } : {}),
          ...(record.knownFix && !existing.knownFix ? { knownFix: record.knownFix } : {}),
          ...(record.prevention && !existing.prevention ? { prevention: record.prevention } : {}),
        })
        .where(eq(errorMemory.id, existing.id));

      console.log(`[ErrorMemory] Recurring error: ${signature} (${(existing.occurrenceCount || 0) + 1}x) type=${record.errorType}`);

      return {
        found: true,
        signature,
        occurrenceCount: (existing.occurrenceCount || 0) + 1,
        knownFix: existing.knownFix || record.knownFix || null,
        rootCause: existing.rootCause || record.rootCause || null,
        prevention: existing.prevention || record.prevention || null,
        fixApplied: existing.fixApplied === 1,
      };
    }

    // New error — create record
    const truncatedMessage = record.errorMessage.length > MAX_ERROR_MESSAGE_LENGTH
      ? record.errorMessage.substring(0, MAX_ERROR_MESSAGE_LENGTH) + "..."
      : record.errorMessage;

    const newRecord: InsertErrorMemoryEntry = {
      errorSignature: signature,
      errorType: record.errorType,
      errorMessage: truncatedMessage,
      rootCause: record.rootCause || null,
      knownFix: record.knownFix || null,
      prevention: record.prevention || null,
      occurrenceCount: 1,
      lastOccurredAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(errorMemory).values(newRecord);
    console.log(`[ErrorMemory] New error recorded: ${signature} type=${record.errorType}`);

    return {
      found: false,
      signature,
      occurrenceCount: 1,
      knownFix: record.knownFix || null,
      rootCause: record.rootCause || null,
      prevention: record.prevention || null,
      fixApplied: false,
    };
  } catch (err) {
    // Ignore duplicate key errors (race condition safe)
    if ((err as any)?.message?.includes("Duplicate")) {
      return { found: true, signature, occurrenceCount: 1, knownFix: null, rootCause: null, prevention: null, fixApplied: false };
    }
    console.error("[ErrorMemory] Error recording:", err);
    return { found: false, signature, occurrenceCount: 0, knownFix: null, rootCause: null, prevention: null, fixApplied: false };
  }
}

// =================================================================
// 2. LOOKUP — Check if an error has a known fix before retrying
// =================================================================

/**
 * Before retrying an operation, check if this error type has a known fix.
 * Returns the fix description if one exists.
 */
export async function getKnownFix(errorType: ErrorType, errorMessage: string, context?: string): Promise<ErrorLookupResult> {
  const signature = generateSignature(errorType, errorMessage, context);
  const db = await getDb();

  if (!db) {
    return { found: false, signature, occurrenceCount: 0, knownFix: null, rootCause: null, prevention: null, fixApplied: false };
  }

  try {
    const [existing] = await db.select()
      .from(errorMemory)
      .where(eq(errorMemory.errorSignature, signature))
      .limit(1);

    if (!existing) {
      return { found: false, signature, occurrenceCount: 0, knownFix: null, rootCause: null, prevention: null, fixApplied: false };
    }

    return {
      found: true,
      signature,
      occurrenceCount: existing.occurrenceCount || 0,
      knownFix: existing.knownFix,
      rootCause: existing.rootCause,
      prevention: existing.prevention,
      fixApplied: existing.fixApplied === 1,
    };
  } catch (err) {
    console.error("[ErrorMemory] Lookup error:", err);
    return { found: false, signature, occurrenceCount: 0, knownFix: null, rootCause: null, prevention: null, fixApplied: false };
  }
}

// =================================================================
// 3. APPLY FIX — Mark a fix as applied
// =================================================================

/**
 * After successfully applying a known fix, mark it in the database.
 */
export async function markFixApplied(signature: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    await db.update(errorMemory)
      .set({ fixApplied: 1, updatedAt: Date.now() })
      .where(eq(errorMemory.errorSignature, signature));
    console.log(`[ErrorMemory] Fix applied for: ${signature}`);
  } catch (err) {
    console.error("[ErrorMemory] Error marking fix:", err);
  }
}

// =================================================================
// 4. ADD FIX — Record a known fix for an error pattern
// =================================================================

/**
 * Add or update a known fix for an error signature.
 * Can be called manually or by the self-healing system.
 */
export async function addKnownFix(opts: {
  errorType: ErrorType;
  errorMessage: string;
  context?: string;
  rootCause: string;
  knownFix: string;
  prevention?: string;
}): Promise<void> {
  const signature = generateSignature(opts.errorType, opts.errorMessage, opts.context);
  const db = await getDb();
  if (!db) return;

  const now = Date.now();

  try {
    const [existing] = await db.select()
      .from(errorMemory)
      .where(eq(errorMemory.errorSignature, signature))
      .limit(1);

    if (existing) {
      await db.update(errorMemory)
        .set({
          rootCause: opts.rootCause,
          knownFix: opts.knownFix,
          prevention: opts.prevention || existing.prevention,
          updatedAt: now,
        })
        .where(eq(errorMemory.id, existing.id));
    } else {
      await db.insert(errorMemory).values({
        errorSignature: signature,
        errorType: opts.errorType,
        errorMessage: opts.errorMessage.substring(0, MAX_ERROR_MESSAGE_LENGTH),
        rootCause: opts.rootCause,
        knownFix: opts.knownFix,
        prevention: opts.prevention || null,
        occurrenceCount: 0,
        lastOccurredAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    console.log(`[ErrorMemory] Fix added for: ${signature}`);
  } catch (err) {
    if (!(err as any)?.message?.includes("Duplicate")) {
      console.error("[ErrorMemory] Error adding fix:", err);
    }
  }
}

// =================================================================
// 5. SEED — Pre-populate known error patterns and fixes
// =================================================================

/**
 * Seed the error memory with known error patterns and their fixes.
 * Called once at startup or when the system is first deployed.
 */
export async function seedKnownErrors(): Promise<number> {
  const knownErrors: Array<{
    errorType: ErrorType;
    errorMessage: string;
    context?: string;
    rootCause: string;
    knownFix: string;
    prevention: string;
  }> = [
    {
      errorType: "ghl_api",
      errorMessage: "Request failed with status code 429",
      rootCause: "GHL API rate limit exceeded (100 requests/minute)",
      knownFix: "Wait 60 seconds before retrying. Implement exponential backoff.",
      prevention: "Batch API calls and space them 600ms apart. Use queue for bulk operations.",
    },
    {
      errorType: "ghl_api",
      errorMessage: "Request failed with status code 401",
      rootCause: "GHL API key expired or invalid",
      knownFix: "Check GHL_API_KEY environment variable. Regenerate key in GHL settings.",
      prevention: "Monitor API key expiration. Set up key rotation alerts.",
    },
    {
      errorType: "channel_mismatch",
      errorMessage: "Cannot send SMS to email-only contact",
      rootCause: "Contact has no phone number but SMS channel was selected",
      knownFix: "Fall back to email channel. Check contact.phone before SMS send.",
      prevention: "Always verify channel availability before attempting send.",
    },
    {
      errorType: "llm_hallucination",
      errorMessage: "LLM generated pricing not in approved list",
      rootCause: "LLM invented pricing instead of using the pricing lookup table",
      knownFix: "Re-run with explicit pricing instruction: 'ONLY use prices from the provided pricing table'",
      prevention: "Include pricing table in every prompt that might discuss costs.",
    },
    {
      errorType: "send_failure",
      errorMessage: "Email send failed: invalid recipient",
      rootCause: "Lead email address is malformed or bounced",
      knownFix: "Mark email as invalid. Fall back to SMS or chat channel.",
      prevention: "Validate email format on lead creation. Track bounce rates.",
    },
    {
      errorType: "rate_limit",
      errorMessage: "LLM rate limit exceeded",
      rootCause: "Too many concurrent LLM calls",
      knownFix: "Queue LLM calls with 500ms spacing. Retry after 30 seconds.",
      prevention: "Implement LLM call queue with concurrency limit of 3.",
    },
  ];

  let seeded = 0;
  for (const err of knownErrors) {
    try {
      await addKnownFix(err);
      seeded++;
    } catch {
      // Ignore duplicates
    }
  }

  console.log(`[ErrorMemory] Seeded ${seeded} known error patterns`);
  return seeded;
}

// =================================================================
// 6. SWEEP — Periodic cleanup and stats
// =================================================================

/**
 * Get error memory stats for the dashboard.
 */
export async function getErrorStats(): Promise<{
  totalErrors: number;
  uniqueSignatures: number;
  withFixes: number;
  fixesApplied: number;
  topErrors: Array<{ errorType: string; occurrenceCount: number; knownFix: string | null }>;
}> {
  const db = await getDb();
  const empty = { totalErrors: 0, uniqueSignatures: 0, withFixes: 0, fixesApplied: 0, topErrors: [] };
  if (!db) return empty;

  try {
    const [stats] = await db.select({
      uniqueSignatures: sql<number>`COUNT(*)`,
      totalErrors: sql<number>`SUM(${errorMemory.occurrenceCount})`,
      withFixes: sql<number>`SUM(CASE WHEN ${errorMemory.knownFix} IS NOT NULL THEN 1 ELSE 0 END)`,
      fixesApplied: sql<number>`SUM(CASE WHEN ${errorMemory.fixApplied} = 1 THEN 1 ELSE 0 END)`,
    }).from(errorMemory);

    const topErrors = await db.select({
      errorType: errorMemory.errorType,
      occurrenceCount: errorMemory.occurrenceCount,
      knownFix: errorMemory.knownFix,
    })
      .from(errorMemory)
      .orderBy(desc(errorMemory.occurrenceCount))
      .limit(10);

    return {
      totalErrors: stats.totalErrors || 0,
      uniqueSignatures: stats.uniqueSignatures || 0,
      withFixes: stats.withFixes || 0,
      fixesApplied: stats.fixesApplied || 0,
      topErrors: topErrors.map(e => ({
        errorType: e.errorType,
        occurrenceCount: e.occurrenceCount || 0,
        knownFix: e.knownFix,
      })),
    };
  } catch (err) {
    console.error("[ErrorMemory] Stats error:", err);
    return empty;
  }
}

// =================================================================
// HELPERS
// =================================================================

/**
 * Generate a stable signature for an error.
 * Signature = hash of (errorType + normalized error message + context).
 * Normalizes dynamic parts (IDs, timestamps) to group similar errors.
 */
export function generateSignature(errorType: string, errorMessage: string, context?: string): string {
  // Normalize: remove UUIDs, numbers, timestamps from message
  const normalized = errorMessage
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    .replace(/\b\d{10,13}\b/g, "<TIMESTAMP>")
    .replace(/\b\d+\b/g, "<NUM>")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200);

  const raw = `${errorType}:${normalized}${context ? `:${context}` : ""}`;
  return createHash("sha256").update(raw).digest("hex").substring(0, 32);
}
