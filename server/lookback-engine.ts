/**
 * LOOKBACK ENGINE — Pre-processes all queued leads before the follow-up trigger reaches them.
 * 
 * Uses LLM to analyze each lead's full conversation history and determine:
 * 1. Lead status: should we engage, skip, or proceed with caution?
 * 2. Sentiment: positive, neutral, negative, angry
 * 3. Completed orders: has the lead already paid/picked up/received their order?
 * 4. DNC signals: did they ask to stop, unsubscribe, or express frustration?
 * 5. Key context: what does the AI need to know before engaging?
 * 6. Recommended channel + approach for re-engagement
 * 7. Optimal next follow-up timing based on real conversation data
 * 
 * Also pre-runs the Researcher brain for leads with business names.
 * 
 * RATE LIMITING: Processes leads sequentially (1 at a time) with configurable
 * delays between calls. Supports incremental mode — only processes leads that
 * haven't been analyzed yet (no existing lookback context in AI state).
 * Automatically retries on rate limit errors with exponential backoff.
 */

import { invokeLLM } from "./_core/llm";
import {
  getDb,
  getConversationHistory,
  getAiState,
  updateLeadFields,
  upsertAiState,
} from "./db";
import { runResearcher, emptyResearch } from "./researcher";
import { buildLeadContext } from "./brain-context";
import { calculateNextFollowUp } from "./scheduling-engine";
import { sourceToChannel } from "./webhook-helpers";
import { leads, aiState } from "../drizzle/schema";
import { eq, isNull, and, or, lte, sql, isNotNull } from "drizzle-orm";

// --- Types ---

export interface LookbackResult {
  leadId: number;
  leadName: string;
  status: "engage" | "skip" | "caution" | "human_needed";
  skipReason?: string;
  sentiment: "positive" | "neutral" | "negative" | "angry";
  dormancyDays: number;
  dormancyTier: "active" | "moderate" | "long" | "deep";
  hasCompletedOrder: boolean;
  hasDncSignal: boolean;
  hasUnansweredQuestion: boolean;
  keyContext: string;           // 1-2 sentence summary the AI needs before engaging
  recommendedChannel: string;
  recommendedApproach: string;  // e.g. "win-back", "order follow-up", "new pitch"
  recommendedWaitDays: number;  // how long to wait before engaging
  researchPreFetched: boolean;
  error?: string;
}

export interface LookbackSummary {
  total: number;
  processed: number;
  engage: number;
  skip: number;
  caution: number;
  humanNeeded: number;
  researchFetched: number;
  errors: number;
  rateLimitHits: number;
  results: LookbackResult[];
}

// --- LLM Analysis ---

const LOOKBACK_PROMPT = `You are an expert sales analyst reviewing a lead's FULL conversation history for Adorb Custom Tees (custom apparel printing).

Analyze this lead and determine:

1. STATUS — Should the AI engage this lead?
   - "engage": Safe to contact, there's a reason to reach out
   - "skip": Do NOT contact (completed order with no new need, explicit DNC, wrong number, spam)
   - "caution": Can contact but needs careful handling (prior complaint, long silence, sensitive situation)
   - "human_needed": Too complex for AI — needs human review (legal issue, refund dispute, VIP)

2. SENTIMENT — Overall sentiment from their last interactions:
   - "positive": Interested, friendly, engaged
   - "neutral": No strong signal either way
   - "negative": Frustrated, disappointed, losing interest
   - "angry": Explicitly upset, complained, threatened

3. COMPLETED ORDER — Has this lead already paid for and received their order? (true/false)
   Look for: "paid", "picked up", "delivered", "received", "completed", invoice paid, etc.

4. DNC SIGNAL — Did they ask to stop being contacted? (true/false)
   Look for: "stop", "unsubscribe", "don't contact", "remove me", "not interested", "leave me alone"

5. UNANSWERED QUESTION — Did the lead ask a question that was never answered? (true/false)

6. KEY CONTEXT — 1-2 sentences the AI MUST know before engaging. What's the story with this lead?
   Example: "Ordered 50 church shirts in Nov 2025, picked up and paid. No current need expressed."
   Example: "Asked about bulk pricing for HVAC uniforms, never got a quote. Still interested."

7. RECOMMENDED CHANNEL — Best channel to re-engage: "Email", "SMS", "WhatsApp"
   - Dormant 30-364 days → Email (less invasive)
   - Dormant 365+ days → SMS (emails are ineffective for deeply dormant leads — SMS gets replies)
   - Active/recent → same channel they last used
   - Has email but no phone → Email
   - Has phone but no email → SMS

8. RECOMMENDED APPROACH — What type of outreach makes sense:
   - "win-back": Dormant lead, needs fresh value proposition
   - "order-follow-up": Had an order, check satisfaction or offer reorder
   - "quote-follow-up": Was quoted but never closed
   - "new-pitch": Never had meaningful interaction, needs intro
   - "question-answer": They asked something that wasn't answered
   - "relationship-nurture": Good relationship, just stay in touch

9. RECOMMENDED WAIT DAYS — How many days from now to wait before engaging (0-30):
   - Angry/negative → 14-30 days
   - Completed order → 7-14 days (check satisfaction)
   - Active interest → 0-1 days
   - Dormant neutral → 1-3 days
   - DNC → 9999 (skip)

Respond in JSON:
{
  "status": "engage|skip|caution|human_needed",
  "skipReason": "reason if skip/human_needed, null otherwise",
  "sentiment": "positive|neutral|negative|angry",
  "hasCompletedOrder": true/false,
  "hasDncSignal": true/false,
  "hasUnansweredQuestion": true/false,
  "keyContext": "1-2 sentence summary",
  "recommendedChannel": "Email|SMS|WhatsApp",
  "recommendedApproach": "win-back|order-follow-up|quote-follow-up|new-pitch|question-answer|relationship-nurture",
  "recommendedWaitDays": number
}`;

async function analyzeLead(
  leadId: number,
  leadName: string,
  businessName: string | null,
  email: string | null,
  phone: string | null,
  pipelineStage: string,
  conversationHistory: string,
  daysSinceLastActivity: number
): Promise<Omit<LookbackResult, "leadId" | "leadName" | "dormancyDays" | "dormancyTier" | "researchPreFetched">> {
  const leadSummary = [
    `Lead: ${leadName}`,
    businessName ? `Business: ${businessName}` : null,
    `Pipeline Stage: ${pipelineStage}`,
    `Has Email: ${email ? "yes" : "no"}`,
    `Has Phone: ${phone ? "yes" : "no"}`,
    `Days Since Last Activity: ${Math.round(daysSinceLastActivity)}`,
  ].filter(Boolean).join("\n");

  const response = await invokeLLM({
    messages: [
      { role: "system", content: LOOKBACK_PROMPT },
      { role: "user", content: `${leadSummary}\n\n=== FULL CONVERSATION HISTORY ===\n${conversationHistory || "(no conversation history)"}` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "lookback_analysis",
        strict: true,
        schema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["engage", "skip", "caution", "human_needed"] },
            skipReason: { type: ["string", "null"] },
            sentiment: { type: "string", enum: ["positive", "neutral", "negative", "angry"] },
            hasCompletedOrder: { type: "boolean" },
            hasDncSignal: { type: "boolean" },
            hasUnansweredQuestion: { type: "boolean" },
            keyContext: { type: "string" },
            recommendedChannel: { type: "string", enum: ["Email", "SMS", "WhatsApp"] },
            recommendedApproach: { type: "string", enum: ["win-back", "order-follow-up", "quote-follow-up", "new-pitch", "question-answer", "relationship-nurture"] },
            recommendedWaitDays: { type: "integer" },
          },
          required: ["status", "skipReason", "sentiment", "hasCompletedOrder", "hasDncSignal", "hasUnansweredQuestion", "keyContext", "recommendedChannel", "recommendedApproach", "recommendedWaitDays"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response");
  return JSON.parse(content as string);
}

// --- Rate-limited retry wrapper ---

async function analyzeLeadWithRetry(
  leadId: number,
  leadName: string,
  businessName: string | null,
  email: string | null,
  phone: string | null,
  pipelineStage: string,
  conversationHistory: string,
  daysSinceLastActivity: number,
  maxRetries: number = 3,
): Promise<{ result: Omit<LookbackResult, "leadId" | "leadName" | "dormancyDays" | "dormancyTier" | "researchPreFetched">; rateLimitHit: boolean }> {
  let rateLimitHit = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await analyzeLead(leadId, leadName, businessName, email, phone, pipelineStage, conversationHistory, daysSinceLastActivity);
      return { result, rateLimitHit };
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      const isRateLimit = errMsg.includes("429") || errMsg.includes("rate") || errMsg.includes("exhausted") || errMsg.includes("412");
      if (isRateLimit && attempt < maxRetries) {
        rateLimitHit = true;
        const backoffMs = Math.min(30000, 5000 * Math.pow(2, attempt)); // 5s, 10s, 20s, max 30s
        console.log(`[Lookback] Rate limit hit for lead ${leadId}, retry ${attempt + 1}/${maxRetries} in ${backoffMs / 1000}s...`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      throw err; // Non-rate-limit error or max retries exceeded
    }
  }
  throw new Error("Max retries exceeded"); // Should not reach here
}

// --- Main Lookback Runner (Rate-Limited + Incremental) ---

export async function runLookback(options?: {
  batchSize?: number;          // IGNORED for rate limiting — always sequential. Kept for API compat.
  onlyUnprocessed?: boolean;   // Only process leads without existing lookback data (default: true)
  pipelineStages?: string[];
  maxLeads?: number;           // Max leads to process in this run
  delayBetweenMs?: number;     // Delay between each lead (default: 3000ms = 3s)
  skipResearch?: boolean;      // Skip researcher pre-fetch to save API calls (default: false)
}): Promise<LookbackSummary> {
  const maxLeads = options?.maxLeads ?? 50;  // Default to 50 per run (conservative)
  const delayMs = options?.delayBetweenMs ?? 3000; // 3 seconds between leads
  const onlyUnprocessed = options?.onlyUnprocessed ?? true;
  const skipResearch = options?.skipResearch ?? false;
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Get leads to process
  // If onlyUnprocessed, skip leads that already have lookback context in AI state
  let allLeads: any[];

  if (onlyUnprocessed) {
    // Get leads that DON'T have "[LOOKBACK]" in their lastResearchSummary (our marker)
    allLeads = await db.select().from(leads).where(
      and(
        eq(leads.humanTakeover, 0),
        sql`COALESCE(${leads.pipelineStage}, 'new_lead') NOT IN ('not_qualified', 'lost')`,
        // HARD GATE 1 — Source-based: Skip imported/transferred contacts until they send an inbound message
        sql`NOT (
          COALESCE(${leads.source}, '') IN ('transferred_contact', 'r', 'n', 'bulk_import', 'Facebook', 'ghl', 'fb')
          AND COALESCE(${leads.reactivatedFromMigration}, 0) = 0
        )`,
        // HARD GATE 2 — Age-based: Skip ANY lead older than 90 days with no inbound reply
        sql`NOT (
          ${leads.createdAt} < DATE_SUB(NOW(), INTERVAL 90 DAY)
          AND COALESCE(${leads.reactivatedFromMigration}, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM conversations c
            WHERE c.leadId = ${leads.id}
            AND c.direction = 'inbound'
          )
        )`,
        or(
          isNull(leads.lastResearchSummary),
          sql`${leads.lastResearchSummary} NOT LIKE '%[LOOKBACK]%'`
        )
      )
    ).orderBy(leads.nextFollowUpAt).limit(maxLeads);
  } else {
    allLeads = await db.select().from(leads).where(
      and(
        eq(leads.humanTakeover, 0),
        sql`COALESCE(${leads.pipelineStage}, 'new_lead') NOT IN ('not_qualified', 'lost')`,
        // HARD GATE 1 — Source-based: Skip imported/transferred contacts until they send an inbound message
        sql`NOT (
          COALESCE(${leads.source}, '') IN ('transferred_contact', 'r', 'n', 'bulk_import', 'Facebook', 'ghl', 'fb')
          AND COALESCE(${leads.reactivatedFromMigration}, 0) = 0
        )`,
        // HARD GATE 2 — Age-based: Skip ANY lead older than 90 days with no inbound reply
        sql`NOT (
          ${leads.createdAt} < DATE_SUB(NOW(), INTERVAL 90 DAY)
          AND COALESCE(${leads.reactivatedFromMigration}, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM conversations c
            WHERE c.leadId = ${leads.id}
            AND c.direction = 'inbound'
          )
        )`,
        leads.nextFollowUpAt ? lte(leads.nextFollowUpAt, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)) : undefined,
      )
    ).orderBy(leads.nextFollowUpAt).limit(maxLeads);
  }

  console.log(`[Lookback] Starting RATE-LIMITED analysis of ${allLeads.length} leads (${delayMs}ms delay, incremental=${onlyUnprocessed})`);

  const summary: LookbackSummary = {
    total: allLeads.length,
    processed: 0,
    engage: 0,
    skip: 0,
    caution: 0,
    humanNeeded: 0,
    researchFetched: 0,
    errors: 0,
    rateLimitHits: 0,
    results: [],
  };

  // Process SEQUENTIALLY — one lead at a time with delays
  for (let i = 0; i < allLeads.length; i++) {
    const lead = allLeads[i];
    const leadId = lead.id;
    const leadName = lead.name || `Lead #${leadId}`;

    try {
      // Progress log every 10 leads
      if (i % 10 === 0 && i > 0) {
        console.log(`[Lookback] Progress: ${i}/${allLeads.length} (${summary.engage} engage, ${summary.skip} skip, ${summary.errors} errors, ${summary.rateLimitHits} rate limits)`);
      }

      // Get full conversation history
      const convHistory = await getConversationHistory(leadId, 100);
      const historyStr = convHistory.length > 0
        ? convHistory.map((c: any) =>
            `[${new Date(c.timestamp).toLocaleString()}] [${c.direction}/${c.senderType}/${c.channel || "?"}] ${c.messageBody || "(no body)"}`
          ).join("\n")
        : "";

      // Calculate dormancy
      const lastActivityAt = convHistory.length > 0
        ? new Date(convHistory[0].timestamp).getTime()
        : (lead.createdAt ? new Date(lead.createdAt).getTime() : 0);
      const daysSinceLastActivity = lastActivityAt
        ? (Date.now() - lastActivityAt) / (1000 * 60 * 60 * 24)
        : 999;
      const dormancyTier = daysSinceLastActivity >= 180 ? "deep" as const
        : daysSinceLastActivity >= 90 ? "long" as const
        : daysSinceLastActivity >= 30 ? "moderate" as const
        : "active" as const;

      // Run LLM analysis WITH retry
      const { result: analysis, rateLimitHit } = await analyzeLeadWithRetry(
        leadId, leadName, lead.businessName, lead.email, lead.phone,
        lead.pipelineStage || "new_lead", historyStr, daysSinceLastActivity
      );
      if (rateLimitHit) summary.rateLimitHits++;

      const result: LookbackResult = {
        leadId,
        leadName,
        ...analysis,
        dormancyDays: Math.round(daysSinceLastActivity),
        dormancyTier,
        researchPreFetched: false,
      };

      // --- Apply results to database ---

      // 1. Skip leads: set humanTakeover or push far into future
      if (analysis.status === "skip") {
        if (analysis.hasDncSignal) {
          await updateLeadFields(leadId, { humanTakeover: 1 });
          console.log(`[Lookback] SKIP (DNC) lead ${leadId} ${leadName}: ${analysis.skipReason}`);
        } else {
          // Reactivate 90 days from LAST CONTACT — not from today
          // If last contact was 60 days ago, they get reactivated in 30 days (not 90 days from now)
          const lastContactMs = lastActivityAt || Date.now();
          const futureDate = new Date(lastContactMs);
          futureDate.setDate(futureDate.getDate() + 90);
          // If that date is already in the past (last contact was >90 days ago), schedule for tomorrow
          if (futureDate.getTime() < Date.now()) {
            futureDate.setTime(Date.now() + 24 * 60 * 60 * 1000);
          }
          await updateLeadFields(leadId, { nextFollowUpAt: futureDate });
          const daysFromNow = Math.round((futureDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          console.log(`[Lookback] SKIP lead ${leadId} ${leadName}: ${analysis.skipReason} (reactivate in ${daysFromNow}d = 90d from last contact)`);
        }
      }

      // 2. Human needed: flag for human review
      if (analysis.status === "human_needed") {
        await updateLeadFields(leadId, { humanTakeover: 1 });
        console.log(`[Lookback] HUMAN NEEDED lead ${leadId} ${leadName}: ${analysis.keyContext}`);
      }

      // 3. Caution/Engage: update schedule based on recommended wait
      if (analysis.status === "engage" || analysis.status === "caution") {
        const newFollowUp = new Date();
        newFollowUp.setDate(newFollowUp.getDate() + analysis.recommendedWaitDays);
        if (newFollowUp.getFullYear() > 2029) newFollowUp.setFullYear(2029);
        // Only push forward, never pull back (don't accelerate past current schedule)
        const currentFollowUp = lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt).getTime() : 0;
        if (newFollowUp.getTime() > currentFollowUp) {
          await updateLeadFields(leadId, { nextFollowUpAt: newFollowUp });
        }
        // Update preferred channel based on analysis
        // SOURCE-BASED CHANNEL OVERRIDE: If the lead has no conversation history (never messaged)
        // and their source indicates Facebook/IG, use that channel instead of SMS.
        // This prevents historical Facebook leads from being contacted via SMS when they
        // originally came through a Facebook lead form.
        let resolvedChannel = analysis.recommendedChannel;
        // DEEP DORMANT OVERRIDE: 365+ day leads should use SMS (emails are ineffective)
        if (resolvedChannel === 'Email' && daysSinceLastActivity >= 365 && lead.phone) {
          console.log(`[Lookback] DEEP DORMANT CHANNEL OVERRIDE for lead ${leadId}: ${Math.round(daysSinceLastActivity)}d dormant — Email → SMS (emails ineffective for 1yr+ leads)`);
          resolvedChannel = 'SMS';
        }
        if (!historyStr && lead.source) {
          // Use the centralised sourceToChannel() — single source of truth in webhook-helpers
          const srcChannel = sourceToChannel(lead.source as string);
          if (srcChannel !== "SMS") {
            resolvedChannel = srcChannel;
            console.log(`[Lookback] SOURCE CHANNEL OVERRIDE for lead ${leadId}: source='${lead.source}' → channel=${srcChannel} (no conversation history)`);
          }
        }
        await updateLeadFields(leadId, { preferredChannel: resolvedChannel });
      }

      // 4. Store key context in AI state for the Brain Council to use
      await upsertAiState(leadId, {
        sentimentTrend: analysis.sentiment,
        lastResearchSummary: `[LOOKBACK] ${analysis.keyContext} | Status: ${analysis.status} | Approach: ${analysis.recommendedApproach}`,
      });

      // 5. Store key context in lead's research summary (also serves as "processed" marker)
      await updateLeadFields(leadId, {
        lastStrategyReasoning: `[LOOKBACK] ${analysis.recommendedApproach} | ${analysis.keyContext}`,
        lastResearchSummary: `[LOOKBACK] ${analysis.keyContext}`,
      });

      // 6. Pre-run Researcher for leads with business names (optional)
      if (
        !skipResearch &&
        lead.businessName &&
        (analysis.status === "engage" || analysis.status === "caution") &&
        !lead.researchData
      ) {
        try {
          const context = await buildLeadContext(leadId);
          const fakeStrategy = {
            approach: "reactivation" as const,
            channel: analysis.recommendedChannel,
            angle: analysis.recommendedApproach,
            framework: "HORMOZI_ACA" as const,
            personalizationTier: 2 as const,
            toneDirective: "warm and professional",
            maxLength: 200,
            keyPoints: [],
            avoidPoints: [],
            nextEngagementHours: analysis.recommendedWaitDays * 24,
            reasoning: "lookback pre-fetch",
          };
          const research = await runResearcher(
            { leadId, incomingMessage: "Pre-fetch research for lookback", channel: analysis.recommendedChannel },
            context,
            fakeStrategy
          );
          if (research.summary && research.summary !== "No research available") {
            await updateLeadFields(leadId, { researchData: research as any });
            result.researchPreFetched = true;
            summary.researchFetched++;
            console.log(`[Lookback] Research pre-fetched for lead ${leadId} ${leadName}: ${research.summary.substring(0, 80)}...`);
          }
          // Extra delay after research (uses LLM too)
          await new Promise(r => setTimeout(r, delayMs));
        } catch (err) {
          console.error(`[Lookback] Research pre-fetch failed for lead ${leadId}:`, err);
        }
      }

      // Update counters
      summary.processed++;
      if (analysis.status === "engage") summary.engage++;
      else if (analysis.status === "skip") summary.skip++;
      else if (analysis.status === "caution") summary.caution++;
      else if (analysis.status === "human_needed") summary.humanNeeded++;
      summary.results.push(result);

      console.log(`[Lookback] ✅ ${i + 1}/${allLeads.length} Lead ${leadId} (${leadName}): ${analysis.status} | ${analysis.sentiment} | ${analysis.recommendedApproach} via ${analysis.recommendedChannel}`);

    } catch (err: any) {
      summary.errors++;
      summary.processed++;
      const errMsg = String(err?.message || err);
      const isRateLimit = errMsg.includes("429") || errMsg.includes("rate") || errMsg.includes("exhausted") || errMsg.includes("412");

      if (isRateLimit) {
        summary.rateLimitHits++;
        console.log(`[Lookback] ⚠️ Rate limit exhausted at lead ${i + 1}/${allLeads.length}. Stopping run. Resume later — incremental mode will pick up where we left off.`);
        break; // Stop the entire run — resume later
      }

      const errorResult: LookbackResult = {
        leadId: lead.id,
        leadName: lead.name || `Lead #${lead.id}`,
        status: "caution",
        sentiment: "neutral",
        dormancyDays: 0,
        dormancyTier: "active",
        hasCompletedOrder: false,
        hasDncSignal: false,
        hasUnansweredQuestion: false,
        keyContext: "Lookback analysis failed — proceed with caution",
        recommendedChannel: "Email",
        recommendedApproach: "win-back",
        recommendedWaitDays: 3,
        researchPreFetched: false,
        error: String(err),
      };
      summary.results.push(errorResult);
      console.error(`[Lookback] Error analyzing lead ${lead.id}:`, err);
    }

    // Delay between leads to stay under rate limits
    if (i < allLeads.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`[Lookback] Complete: ${summary.processed} processed, ${summary.engage} engage, ${summary.skip} skip, ${summary.caution} caution, ${summary.humanNeeded} human_needed, ${summary.researchFetched} researched, ${summary.errors} errors, ${summary.rateLimitHits} rate limit hits`);
  return summary;
}
