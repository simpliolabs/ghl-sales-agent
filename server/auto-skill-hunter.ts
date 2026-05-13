/**
 * AUTO-SKILL HUNTER — Module 3B
 *
 * Watches the brain_council_audit table for recurring violation patterns.
 * When the same violation category fires 3+ times in 7 days, it:
 *   1. Queries the LLM to propose a new Skill that would prevent the pattern
 *   2. Inserts the proposal into the `skill_proposals` table with status='pending_review'
 *   3. Notifies the owner so they can review and approve/reject
 *
 * Approved proposals are manually added to skill-registry.ts by the developer.
 * This module does NOT auto-add skills — it surfaces opportunities for human review.
 *
 * Runs on a timer (every 6 hours) via the scheduler in server/index.ts.
 * Also exposed as a tRPC mutation for manual triggering from the dashboard.
 *
 * Connected to:
 *   - /self-learning → "Skill Proposals" tab (shows pending/approved/rejected proposals)
 *   - /ai-performance → "Skill Usage" panel (shows which skills fired and their outcomes)
 */

import { invokeLLM } from "./_core/llm";
import { notifyOwner } from "./_core/notification";
import { getDb } from "./db";
import { brainCouncilAudit, skillProposals } from "../drizzle/schema";
import { eq, and, gte, sql, desc, isNull } from "drizzle-orm";
import { getAllSkills } from "./skill-registry";

const VIOLATION_THRESHOLD = 3;      // Min occurrences to trigger proposal
const LOOKBACK_DAYS = 7;            // Days to look back for pattern detection
const PROPOSAL_COOLDOWN_DAYS = 14;  // Don't re-propose same category within 14 days

export interface SkillProposal {
  violationCategory: string;
  occurrenceCount: number;
  proposedSkillId: string;
  proposedSkillName: string;
  proposedPrompt: string;
  triggerConditions: Record<string, any>;
  exampleMessages: string[];
}

// ─── Pattern Detection ─────────────────────────────────────────────────────

/**
 * Query the last 7 days of audit log for recurring violation categories.
 * Returns categories that fired >= VIOLATION_THRESHOLD times.
 */
export async function detectViolationPatterns(): Promise<Array<{
  category: string;
  count: number;
  sampleMessages: string[];
}>> {
  const db = await getDb();
  if (!db) return [];

  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  try {
    const rows = await db.select({
      category: brainCouncilAudit.violationCategory,
      count: sql<number>`COUNT(*)`,
    })
      .from(brainCouncilAudit)
      .where(
        and(
          gte(brainCouncilAudit.createdAt, new Date(cutoff)),
          sql`${brainCouncilAudit.violationCategory} IS NOT NULL`,
          sql`${brainCouncilAudit.violationCategory} != ''`,
        )
      )
      .groupBy(brainCouncilAudit.violationCategory)
      .having(sql`COUNT(*) >= ${VIOLATION_THRESHOLD}`)
      .orderBy(desc(sql`COUNT(*)`));

    // For each pattern, get 3 sample composed messages for context
    const patterns = await Promise.all(rows.map(async (row) => {
      const samples = await db.select({ msg: brainCouncilAudit.composedMessage })
        .from(brainCouncilAudit)
        .where(
          and(
            eq(brainCouncilAudit.violationCategory, row.category!),
            gte(brainCouncilAudit.createdAt, new Date(cutoff)),
          )
        )
        .orderBy(desc(brainCouncilAudit.createdAt))
        .limit(3);

      return {
        category: row.category!,
        count: Number(row.count),
        sampleMessages: samples.map(s => (s.msg || "").substring(0, 200)),
      };
    }));

    return patterns;
  } catch (err) {
    console.error("[AutoSkillHunter] Pattern detection failed:", err);
    return [];
  }
}

// ─── Cooldown Check ────────────────────────────────────────────────────────

/**
 * Check if a proposal for this violation category was already created recently.
 */
async function isOnCooldown(violationCategory: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const cutoff = Date.now() - PROPOSAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  try {
    const existing = await db.select({ id: skillProposals.id })
      .from(skillProposals)
      .where(
        and(
          eq(skillProposals.violationCategory, violationCategory),
          gte(skillProposals.createdAt, new Date(cutoff)),
        )
      )
      .limit(1);
    return existing.length > 0;
  } catch {
    return false;
  }
}

// ─── Proposal Generation ───────────────────────────────────────────────────

/**
 * Call LLM to propose a new Skill based on a recurring violation pattern.
 */
async function generateSkillProposal(
  violationCategory: string,
  occurrenceCount: number,
  sampleMessages: string[],
): Promise<SkillProposal | null> {
  const existingSkills = getAllSkills();
  const existingSkillIds = existingSkills.map(s => s.id).join(", ");

  const prompt = `You are an AI sales system architect for Adorb Custom Tees, a custom apparel company.

The AI message composer has repeatedly violated the rule: "${violationCategory}"
This happened ${occurrenceCount} times in the last 7 days.

Sample messages that triggered this violation:
${sampleMessages.map((m, i) => `${i + 1}. "${m}"`).join("\n")}

Existing skills in the registry: ${existingSkillIds}

Your task: Propose a NEW Composer Skill that would prevent this violation pattern.
A Skill is a system prompt overlay injected into the Composer for specific trigger conditions.

Requirements:
1. The skill must directly address the root cause of the "${violationCategory}" violation
2. The skill should be reusable across multiple leads (not a one-off fix)
3. The triggerConditions should be specific enough to not fire on every message
4. The proposedPrompt should be a clear, actionable system prompt overlay (100-300 words)
5. The skillId must be unique, snake_case, and descriptive (e.g., "urgency_objection_handler")

Respond with a JSON object:
{
  "proposedSkillId": "snake_case_id",
  "proposedSkillName": "Human Readable Name",
  "proposedPrompt": "=== SKILL: NAME ===\\n...full system prompt overlay...",
  "triggerConditions": {
    "approaches": ["approach1", "approach2"],
    "conversationStages": ["stage1"],
    "segments": ["segment1"]
  },
  "exampleMessages": ["Example output 1", "Example output 2"]
}`;

  try {
    const response = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "skill_proposal",
          strict: true,
          schema: {
            type: "object",
            properties: {
              proposedSkillId: { type: "string" },
              proposedSkillName: { type: "string" },
              proposedPrompt: { type: "string" },
              triggerConditions: {
                type: "object",
                properties: {
                  approaches: { type: "array", items: { type: "string" } },
                  conversationStages: { type: "array", items: { type: "string" } },
                  segments: { type: "array", items: { type: "string" } },
                  channels: { type: "array", items: { type: "string" } },
                },
                required: [],
                additionalProperties: false,
              },
              exampleMessages: { type: "array", items: { type: "string" } },
            },
            required: ["proposedSkillId", "proposedSkillName", "proposedPrompt", "triggerConditions", "exampleMessages"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response?.choices?.[0]?.message?.content;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

    if (!parsed?.proposedSkillId || !parsed?.proposedPrompt) return null;

    return {
      violationCategory,
      occurrenceCount,
      proposedSkillId: String(parsed.proposedSkillId).replace(/[^a-z0-9_]/g, "_").substring(0, 64),
      proposedSkillName: String(parsed.proposedSkillName).substring(0, 128),
      proposedPrompt: String(parsed.proposedPrompt).substring(0, 5000),
      triggerConditions: parsed.triggerConditions || {},
      exampleMessages: (parsed.exampleMessages || []).slice(0, 3),
    };
  } catch (err) {
    console.error("[AutoSkillHunter] Proposal generation failed:", err);
    return null;
  }
}

// ─── Main Run ──────────────────────────────────────────────────────────────

/**
 * Main Auto-Skill Hunter run. Detects patterns, generates proposals, stores them.
 * Returns a summary of what was found and proposed.
 */
export async function runAutoSkillHunter(): Promise<{
  patternsFound: number;
  proposalsCreated: number;
  skippedCooldown: number;
  details: Array<{ category: string; count: number; action: "proposed" | "cooldown" | "failed" }>;
}> {
  console.log("[AutoSkillHunter] Starting run...");
  const db = await getDb();
  if (!db) return { patternsFound: 0, proposalsCreated: 0, skippedCooldown: 0, details: [] };

  const patterns = await detectViolationPatterns();
  console.log(`[AutoSkillHunter] Found ${patterns.length} violation patterns`);

  let proposalsCreated = 0;
  let skippedCooldown = 0;
  const details: Array<{ category: string; count: number; action: "proposed" | "cooldown" | "failed" }> = [];

  for (const pattern of patterns) {
    // Check cooldown
    const onCooldown = await isOnCooldown(pattern.category);
    if (onCooldown) {
      console.log(`[AutoSkillHunter] Skipping ${pattern.category} — on cooldown`);
      skippedCooldown++;
      details.push({ category: pattern.category, count: pattern.count, action: "cooldown" });
      continue;
    }

    // Generate proposal
    const proposal = await generateSkillProposal(
      pattern.category,
      pattern.count,
      pattern.sampleMessages,
    );

    if (!proposal) {
      details.push({ category: pattern.category, count: pattern.count, action: "failed" });
      continue;
    }

    // Store proposal
    try {
      await db.insert(skillProposals).values({
        violationCategory: proposal.violationCategory,
        occurrenceCount: proposal.occurrenceCount,
        proposedSkillId: proposal.proposedSkillId,
        proposedSkillName: proposal.proposedSkillName,
        proposedPrompt: proposal.proposedPrompt,
        triggerConditions: proposal.triggerConditions,
        exampleMessages: proposal.exampleMessages,
        status: "pending_review",
        createdAt: new Date(),
      });
      proposalsCreated++;
      details.push({ category: pattern.category, count: pattern.count, action: "proposed" });
      console.log(`[AutoSkillHunter] Proposed skill "${proposal.proposedSkillId}" for violation "${pattern.category}"`);
    } catch (err) {
      console.error(`[AutoSkillHunter] Failed to store proposal:`, err);
      details.push({ category: pattern.category, count: pattern.count, action: "failed" });
    }
  }

  // Notify owner if any proposals were created
  if (proposalsCreated > 0) {
    try {
      await notifyOwner({
        title: `🧠 Auto-Skill Hunter: ${proposalsCreated} new skill proposal${proposalsCreated > 1 ? "s" : ""}`,
        content: `The Auto-Skill Hunter detected recurring violation patterns and proposed ${proposalsCreated} new skill${proposalsCreated > 1 ? "s" : ""}:\n\n${details.filter(d => d.action === "proposed").map(d => `• ${d.category} (${d.count}x in 7 days)`).join("\n")}\n\nReview and approve at /self-learning → Skill Proposals tab.`,
      });
    } catch (notifyErr) {
      console.error("[AutoSkillHunter] Owner notification failed:", notifyErr);
    }
  }

  console.log(`[AutoSkillHunter] Complete: ${proposalsCreated} proposed, ${skippedCooldown} on cooldown`);
  return { patternsFound: patterns.length, proposalsCreated, skippedCooldown, details };
}

// ─── Proposal Management ───────────────────────────────────────────────────

/**
 * Get all skill proposals (for dashboard display).
 */
export async function getSkillProposals(status?: "pending_review" | "approved" | "rejected"): Promise<Array<{
  id: number;
  violationCategory: string;
  occurrenceCount: number;
  proposedSkillId: string;
  proposedSkillName: string;
  proposedPrompt: string;
  triggerConditions: any;
  exampleMessages: any;
  status: string;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
}>> {
  const db = await getDb();
  if (!db) return [];
  try {
    const query = db.select().from(skillProposals).orderBy(desc(skillProposals.createdAt));
    if (status) {
      return db.select().from(skillProposals)
        .where(eq(skillProposals.status, status))
        .orderBy(desc(skillProposals.createdAt));
    }
    return query;
  } catch (err) {
    console.error("[AutoSkillHunter] getSkillProposals failed:", err);
    return [];
  }
}

/**
 * Approve or reject a skill proposal.
 */
export async function reviewSkillProposal(
  id: number,
  action: "approved" | "rejected",
  reviewNote?: string,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    await db.update(skillProposals)
      .set({
        status: action,
        reviewedAt: new Date(),
        reviewNote: reviewNote || null,
      })
      .where(eq(skillProposals.id, id));
    return true;
  } catch (err) {
    console.error("[AutoSkillHunter] reviewSkillProposal failed:", err);
    return false;
  }
}

/**
 * AUTO-ADOPT MATURE PROPOSALS (Decision 7)
 * 
 * Proposals that have been approved AND whose violation category has
 * continued to fire (proving the pattern is persistent) get auto-adopted
 * into the active skill set.
 * 
 * Criteria for auto-adoption:
 * - Status = 'approved'
 * - Approved at least 7 days ago (maturation period)
 * - The violation category has fired 5+ times total since approval
 * 
 * Auto-adopted proposals get their status changed to 'adopted' and
 * their prompt is injected into the Composer context.
 */
const ADOPT_MATURATION_DAYS = 7;
const ADOPT_VIOLATION_THRESHOLD = 5;

export async function autoAdoptMatureProposals(): Promise<{ adopted: number; checked: number }> {
  const db = await getDb();
  if (!db) return { adopted: 0, checked: 0 };

  try {
    // Find approved proposals that are old enough
    const maturationDate = new Date(Date.now() - ADOPT_MATURATION_DAYS * 24 * 60 * 60 * 1000);
    const approvedProposals = await db.select()
      .from(skillProposals)
      .where(and(
        eq(skillProposals.status, "approved"),
        sql`${skillProposals.reviewedAt} < ${maturationDate}`,
      ));

    let adopted = 0;
    for (const proposal of approvedProposals) {
      // Check if the violation category has continued to fire
      const [countResult] = await db.execute(sql`
        SELECT COUNT(*) as cnt FROM brain_council_audit
        WHERE JSON_CONTAINS(violationCategories, ${JSON.stringify(proposal.violationCategory)})
        AND createdAt > ${proposal.reviewedAt}
      `);
      const violationCount = (countResult as any)?.cnt || 0;

      if (violationCount >= ADOPT_VIOLATION_THRESHOLD) {
        // Auto-adopt: change status to 'adopted'
        await db.update(skillProposals)
          .set({ status: "adopted", reviewNote: `Auto-adopted: ${violationCount} violations since approval (threshold: ${ADOPT_VIOLATION_THRESHOLD})` })
          .where(eq(skillProposals.id, proposal.id));
        adopted++;
        console.log(`[AutoSkillHunter] Auto-adopted skill "${proposal.proposedSkillName}" (${violationCount} violations since approval)`);
      }
    }

    return { adopted, checked: approvedProposals.length };
  } catch (err) {
    console.error("[AutoSkillHunter] autoAdoptMatureProposals failed:", err);
    return { adopted: 0, checked: 0 };
  }
}

/**
 * Get all adopted/approved skill prompts for injection into Composer context.
 * Returns a formatted block that can be appended to the Composer system prompt.
 */
export async function getApprovedSkillsBlock(): Promise<string> {
  const db = await getDb();
  if (!db) return '';

  try {
    const adoptedSkills = await db.select({
      proposedSkillName: skillProposals.proposedSkillName,
      proposedPrompt: skillProposals.proposedPrompt,
      violationCategory: skillProposals.violationCategory,
    })
      .from(skillProposals)
      .where(sql`${skillProposals.status} IN ('approved', 'adopted')`)
      .orderBy(desc(skillProposals.createdAt))
      .limit(10); // Cap to avoid prompt bloat

    if (adoptedSkills.length === 0) return '';

    const lines = ['=== ADOPTED SKILLS (from violation pattern learning) ==='];
    for (const skill of adoptedSkills) {
      lines.push(`[${skill.proposedSkillName}] (prevents: ${skill.violationCategory})`);
      lines.push(skill.proposedPrompt);
      lines.push('');
    }
    return lines.join('\n');
  } catch (err) {
    console.error("[AutoSkillHunter] getApprovedSkillsBlock failed:", err);
    return '';
  }
}
