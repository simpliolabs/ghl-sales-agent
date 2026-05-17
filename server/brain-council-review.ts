/**
 * BRAIN COUNCIL SELF-REVIEW — Autonomous mistake detection and recovery
 *
 * The Council reviews its own output and the follow-up trigger's output for:
 * 1. Duplicate messages (same message sent 2+ times to same lead within 24h)
 * 2. Leads that replied but never got a Brain Council response (missed reply)
 * 3. Leads with unanswered questions in their last inbound message
 *
 * For each issue found, the Council runs a full Brain Council cycle with
 * the mistake context passed as overrideReason, so the Strategist knows
 * it's in recovery mode and must compose a message that:
 * - Acknowledges the issue naturally (without being robotic)
 * - Moves the conversation forward
 * - Answers any unanswered questions from the lead
 *
 * This runs every 30 minutes via the cron timer in webhooks.ts
 */

import { getDb, isAiOffline } from "./db";
import { leads, conversations, brainCouncilAudit } from "../drizzle/schema";
import { formatEmailHtml } from "./webhook-helpers";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { runBrainCouncil } from "./brain-council-orchestrator";
import { sendMessage, fetchGhlConversationHistory } from "./ghl";
import { addConversation, updateLeadFields, getConversationHistory } from "./db";
import { notifyOwner } from "./_core/notification";

const REVIEW_WINDOW_HOURS = 24; // Look back 24 hours for issues
const MAX_REVIEWS_PER_CYCLE = 5; // Max leads to review per cycle (LLM credit guard)

interface ReviewIssue {
  leadId: number;
  contactId: string;
  leadName: string;
  channel: string;
  issueType: "duplicate_send" | "missed_reply" | "unanswered_question";
  issueDetail: string;
  lastInboundMessage?: string;
}

/**
 * Detect leads that received the same message 2+ times within 24 hours
 */
async function detectDuplicateSends(): Promise<ReviewIssue[]> {
  const db = await getDb();
  if (!db) return [];

  const cutoff = new Date(Date.now() - REVIEW_WINDOW_HOURS * 60 * 60 * 1000);

  // Find leads with duplicate outbound messages in the window
  const dupes = await db.execute(sql`
    SELECT 
      c.leadId,
      l.ghlContactId,
      l.name as leadName,
      c.channel,
      c.messageBody,
      COUNT(*) as sendCount
    FROM conversations c
    JOIN leads l ON l.id = c.leadId
    WHERE c.direction = 'outbound'
      AND c.senderType = 'ai'
      AND c.timestamp >= ${cutoff}
    GROUP BY c.leadId, c.channel, c.messageBody
    HAVING COUNT(*) >= 2
    LIMIT 20
  `);

  const issues: ReviewIssue[] = [];
  const seen = new Set<number>();

  const dupeRows = (dupes as any[])[0] as any[];
  for (const row of dupeRows) {
    if (seen.has(row.leadId)) continue; // One issue per lead
    seen.add(row.leadId);

    // Check if we already sent a recovery message for this lead recently
    const recentRecovery = await db.select()
      .from(brainCouncilAudit)
      .where(and(
        eq(brainCouncilAudit.leadId, row.leadId),
        gte(brainCouncilAudit.createdAt, cutoff),
        sql`${brainCouncilAudit.strategyApproach} = 'recovery'`
      ))
      .limit(1);

    if (recentRecovery.length > 0) continue; // Already recovered

    issues.push({
      leadId: row.leadId,
      contactId: row.ghlContactId,
      leadName: row.leadName || `Lead #${row.leadId}`,
      channel: row.channel || "SMS",
      issueType: "duplicate_send",
      issueDetail: `The system sent the same message ${row.sendCount} times: "${String(row.messageBody).substring(0, 100)}..."`,
    });
  }

  return issues;
}

/**
 * Detect leads that sent an inbound message but never got a Brain Council reply
 * (i.e., the follow-up trigger sent a template instead of the Council responding)
 */
async function detectMissedReplies(): Promise<ReviewIssue[]> {
  const db = await getDb();
  if (!db) return [];

  const cutoff = new Date(Date.now() - REVIEW_WINDOW_HOURS * 60 * 60 * 1000);

  // Find leads with recent inbound messages that have NO brain council audit entry after them
  const missed = await db.execute(sql`
    SELECT 
      c.leadId,
      l.ghlContactId,
      l.name as leadName,
      c.channel,
      c.messageBody as lastInbound,
      c.timestamp as inboundAt
    FROM conversations c
    JOIN leads l ON l.id = c.leadId
    WHERE c.direction = 'inbound'
      AND c.timestamp >= ${cutoff}
      AND l.humanTakeover = 0
      AND NOT EXISTS (
        SELECT 1 FROM brain_council_audit bca 
        WHERE bca.leadId = c.leadId 
          AND bca.createdAt > c.timestamp
          AND bca.messageSent = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM conversations c2
        WHERE c2.leadId = c.leadId
          AND c2.direction = 'outbound'
          AND c2.senderType = 'ai'
          AND c2.timestamp > c.timestamp
      )
    ORDER BY c.timestamp ASC
    LIMIT 10
  `);

  const issues: ReviewIssue[] = [];
  const seen = new Set<number>();

  const missedRows = (missed as any[])[0] as any[];
  for (const row of missedRows) {
    if (seen.has(row.leadId)) continue;
    seen.add(row.leadId);

    issues.push({
      leadId: row.leadId,
      contactId: row.ghlContactId,
      leadName: row.leadName || `Lead #${row.leadId}`,
      channel: row.channel || "SMS",
      issueType: "missed_reply",
      issueDetail: `Lead sent a message but never received a Brain Council response.`,
      lastInboundMessage: row.lastInbound,
    });
  }

  return issues;
}

/**
 * Build the override reason string that tells the Strategist brain it's in recovery mode
 */
function buildRecoveryContext(issue: ReviewIssue): string {
  switch (issue.issueType) {
    case "duplicate_send":
      return `RECOVERY MODE: ${issue.issueDetail} This was a system error — the lead received duplicate messages. Your job is to compose a recovery message that: (1) acknowledges the glitch naturally and briefly without being overly apologetic, (2) pivots to actually helping them, (3) answers any questions they had. Do NOT send another copy of the duplicate message. Use approach "recovery" and pick the most appropriate framework to move the conversation forward.`;

    case "missed_reply":
      return `RECOVERY MODE: The lead sent a message but our system failed to respond via the Brain Council — they only received an automated template (or nothing). Their message was: "${issue.lastInboundMessage}". Your job is to compose a genuine, personalized response that actually addresses what they said. Use approach "follow_up" and treat their message as the incoming message.`;

    default:
      return `RECOVERY MODE: Review the conversation and compose the most appropriate recovery message.`;
  }
}

/**
 * Run the Brain Council Self-Review cycle
 * Called every 30 minutes by the cron timer
 */
export async function runBrainCouncilSelfReview(): Promise<{
  reviewed: number;
  recovered: number;
  skipped: number;
  errors: number;
}> {
  const stats = { reviewed: 0, recovered: 0, skipped: 0, errors: 0 };

  // Check if AI is offline before running self-review
  if (await isAiOffline()) {
    console.log(`[CouncilReview] AI offline — skipping self-review`);
    return stats;
  }

  try {
    // Collect all issues
    const [dupeIssues, missedIssues] = await Promise.all([
      detectDuplicateSends(),
      // detectMissedReplies() — DISABLED: Fast Scanner (every 2 min) is the sole handler for missed replies.
      // Enabling this caused triple-duplicate messages (webhook + fast scanner + self-review all firing simultaneously).
      Promise.resolve([]),
    ]);

    const allIssues = [...dupeIssues, ...missedIssues];

    if (allIssues.length === 0) {
      console.log("[CouncilReview] No issues found — all clear.");
      return stats;
    }

    console.log(`[CouncilReview] Found ${allIssues.length} issue(s): ${dupeIssues.length} duplicates, ${missedIssues.length} missed replies`);

    // Process up to MAX_REVIEWS_PER_CYCLE
    const batch = allIssues.slice(0, MAX_REVIEWS_PER_CYCLE);

    for (const issue of batch) {
      stats.reviewed++;
      console.log(`[CouncilReview] Processing ${issue.issueType} for lead ${issue.leadId} (${issue.leadName})`);

      try {
        // Run the Brain Council with recovery context
        const recoveryContext = buildRecoveryContext(issue);
        const incomingMessage = issue.lastInboundMessage || 
          `[System: ${issue.issueDetail} Please compose a recovery message.]`;

        // Fetch GHL external history so Brain Council has full conversation context
        let externalHistory = "";
        try {
          const localHistory = await getConversationHistory(issue.leadId, 20);
          externalHistory = localHistory.map((c: any) => `[${c.senderType}/${c.channel}] ${c.messageBody}`).join("\n");
          if (issue.contactId) {
            const ghlHistory = await fetchGhlConversationHistory(issue.contactId);
            if (ghlHistory && ghlHistory.length > 0) {
              const ghlHistoryStr = ghlHistory.filter((m: any) => m.body && m.body.trim())
                .map((m: any) => `[${m.direction === "outbound" ? "agent" : "lead"}/${String(m.type || "msg")}] ${m.body}`).join("\n");
              if (ghlHistoryStr) externalHistory = `--- Full GHL conversation history ---\n${ghlHistoryStr}\n--- Recent local messages ---\n${externalHistory}`;
            }
          }
        } catch (histErr) {
          console.error(`[CouncilReview] Failed to fetch history for lead ${issue.leadId}:`, histErr);
        }

        const result = await runBrainCouncil({
          leadId: issue.leadId,
          incomingMessage,
          channel: issue.channel,
          externalHistory,
          overrideReason: recoveryContext,
          isInboundReply: true, // Recovery is responding to a missed inbound
        });

        if (result.blocked) {
          console.log(`[CouncilReview] Council blocked recovery for lead ${issue.leadId}: ${result.blockReason}`);
          stats.skipped++;
          continue;
        }

        // Send the recovery message
        const sendOpts = buildSendOpts(result.channel || issue.channel, result.message, result.fromName, { leadName: issue.leadName });
        const sendResult = await sendMessage(issue.contactId, sendOpts);

        if (sendResult.success) {
          // Log to conversations
          await addConversation({
            leadId: issue.leadId,
            channel: result.channel || issue.channel,
            direction: "outbound",
            messageBody: result.message,
            senderType: "ai",
            senderName: result.fromName,
          });

          // Update lead's lastMessageAt
          await updateLeadFields(issue.leadId, { lastMessageAt: new Date() });

          console.log(`[CouncilReview] ✅ Recovery sent to ${issue.leadName} (lead ${issue.leadId}): "${result.message.substring(0, 80)}..."`);
          stats.recovered++;

          // Notify owner of the recovery
          await notifyOwner({
            title: `🔄 Council Self-Review: Recovery Sent to ${issue.leadName}`,
            content: `Issue: ${issue.issueType}\nDetail: ${issue.issueDetail}\n\nRecovery message sent:\n"${result.message}"\n\nFramework: ${result.framework} | QC Score: ${result.qcScore}`,
            priority: "standard",
          });
        } else {
          console.error(`[CouncilReview] Failed to send recovery to lead ${issue.leadId}: ${sendResult.error}`);
          stats.errors++;
        }

        // Small delay between sends
        await new Promise(r => setTimeout(r, 3000));

      } catch (err) {
        console.error(`[CouncilReview] Error processing issue for lead ${issue.leadId}:`, err);
        stats.errors++;
      }
    }

    console.log(`[CouncilReview] Cycle complete: ${stats.reviewed} reviewed, ${stats.recovered} recovered, ${stats.skipped} skipped, ${stats.errors} errors`);
  } catch (err) {
    console.error("[CouncilReview] Fatal error:", err);
  }

  return stats;
}

// Helper: build send options per channel
function buildSendOpts(channel: string, message: string, fromName: string, lead?: { leadName?: string; businessName?: string | null }) {
  const agentFirst = (fromName || "Abby").split(" ")[0];
  let subject = `${agentFirst} from Adorb Custom Tees`;
  if (lead?.businessName) {
    subject = `${lead.businessName} — ${agentFirst} from Adorb`;
  } else if (lead?.leadName) {
    const firstName = lead.leadName.split(" ")[0];
    subject = `${firstName} — ${agentFirst} from Adorb`;
  }
  switch (channel) {
    case "Email":
      return { type: "Email" as const, subject, html: formatEmailHtml(message), fromName };
    case "FB":
      return { type: "FB" as const, message };
    case "IG":
      return { type: "IG" as const, message };
    case "WhatsApp":
      return { type: "WhatsApp" as const, message };
    default:
      return { type: "SMS" as const, message };
  }
}

/**
 * FAST MISSED-REPLY SCANNER — Runs every 2 minutes to catch unanswered messages
 * within a 5-minute window, ensuring the Council responds like a live agent within 3 minutes.
 * Only processes leads that sent an inbound message in the last 5 minutes with no AI reply.
 */
export async function runFastMissedReplyScanner(): Promise<number> {
  // Check if AI is offline before scanning
  if (await isAiOffline()) {
    console.log(`[FastScan] AI offline — skipping scan`);
    return 0;
  }

  const db = await getDb();
  if (!db) return 0;

  // Only look at messages from the last 5 minutes with no AI reply
  // ALSO exclude leads that have an active processing lock or recent AI send attempt
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  const missed = await db.execute(sql`
    SELECT 
      c.leadId,
      l.ghlContactId,
      l.name as leadName,
      c.channel,
      c.messageBody as lastInbound,
      c.timestamp as inboundAt
    FROM conversations c
    JOIN leads l ON l.id = c.leadId
    WHERE c.direction = 'inbound'
      AND c.senderType = 'lead'
      AND c.timestamp >= ${fiveMinAgo}
      AND l.humanTakeover = 0
      AND (l.lastAiSendAttemptAt IS NULL OR l.lastAiSendAttemptAt < DATE_SUB(NOW(), INTERVAL 90 SECOND))
      AND (l.processingLockedAt IS NULL OR l.processingLockedAt < DATE_SUB(NOW(), INTERVAL 300 SECOND))
      AND NOT EXISTS (
        SELECT 1 FROM conversations c2
        WHERE c2.leadId = c.leadId
          AND c2.direction = 'outbound'
          AND c2.senderType = 'ai'
          AND c2.timestamp > c.timestamp
      )
      AND NOT EXISTS (
        SELECT 1 FROM brain_council_audit bca
        WHERE bca.leadId = c.leadId
          AND bca.createdAt > c.timestamp
          AND bca.blocked = 0
      )
    ORDER BY c.timestamp ASC
    LIMIT 5
  `);

  const rows = ((missed as any[])[0] as any[]) || [];
  if (rows.length === 0) return 0;

  console.log(`[FastScan] Found ${rows.length} unanswered message(s) in 5-min window`);
  let recovered = 0;
  const seen = new Set<number>();

  // All pre-flight checks (offline, lock, humanTakeover, dedup) are handled inside runBrainCouncil
  for (const row of rows) {
    if (seen.has(row.leadId)) continue;
    seen.add(row.leadId);

    try {
      // Fetch GHL external history so Brain Council has full conversation context
      let externalHistory = "";
      try {
        const localHistory = await getConversationHistory(row.leadId, 20);
        externalHistory = localHistory.map((c: any) => `[${c.senderType}/${c.channel}] ${c.messageBody}`).join("\n");
        if (row.ghlContactId) {
          const ghlHistory = await fetchGhlConversationHistory(row.ghlContactId);
          if (ghlHistory && ghlHistory.length > 0) {
            const ghlHistoryStr = ghlHistory.filter((m: any) => m.body && m.body.trim())
              .map((m: any) => `[${m.direction === "outbound" ? "agent" : "lead"}/${String(m.type || "msg")}] ${m.body}`).join("\n");
            if (ghlHistoryStr) externalHistory = `--- Full GHL conversation history ---\n${ghlHistoryStr}\n--- Recent local messages ---\n${externalHistory}`;
          }
        }
      } catch (histErr) {
        console.error(`[FastScan] Failed to fetch history for lead ${row.leadId}:`, histErr);
      }

      const result = await runBrainCouncil({
        leadId: row.leadId,
        incomingMessage: row.lastInbound,
        channel: row.channel || "SMS",
        externalHistory,
        overrideReason: "FAST_SCAN: Lead sent a message and received no reply within 3 minutes. Respond immediately.",
        isInboundReply: true,
      });

      if (!result.blocked && result.message) {
        const sendOpts = buildSendOpts(result.channel || row.channel || "SMS", result.message, result.fromName, { leadName: row.leadName || undefined });
        const sendResult = await sendMessage(row.ghlContactId, sendOpts);
        if (sendResult) {
          await addConversation({
            leadId: row.leadId,
            channel: result.channel || row.channel || "SMS",
            direction: "outbound",
            messageBody: result.message,
            senderType: "ai",
            senderName: result.fromName,
          });
          await updateLeadFields(row.leadId, { lastMessageAt: new Date() });
          console.log(`[FastScan] ✅ Responded to ${row.leadName} (lead ${row.leadId}) within 3-min window`);
          recovered++;
        }
      }
      // Small delay between sends
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[FastScan] Error responding to lead ${row.leadId}:`, err);
    } finally {
    }
  }

  return recovered;
}
