/**
 * BRAIN 2: RESEARCHER — Gathers context about the lead for personalization
 * NOTE: Only runs on follow-ups/reactivation. First contact uses locked template.
 */

import { invokeLLM } from "./_core/llm";
import type { BrainCouncilInput, StrategyDecision, ResearchResult, LeadContext } from "./brain-types";

const RESEARCHER_PROMPT = `You are the RESEARCHER brain for Adorb Custom Tees' AI outreach system.

Your job is to synthesize all available information about a lead into actionable research context. You analyze:
- Their business name and what it suggests
- Their website (if available)
- Their source channel and what it implies
- Their conversation history for clues
- Their segment and what that segment typically needs
- Seasonal relevance (current date, upcoming events/holidays)

You produce a research brief that helps the Composer write a highly personalized message.

=== ADORB'S SEGMENTS AND TYPICAL NEEDS ===
- Church/Ministry: Sunday shirts, VBS, retreats, choir, youth group, missions trips
- Sports Team: Uniforms, fan gear, tournament shirts, spirit wear
- School: Spirit wear, fundraisers, clubs, graduation, teacher appreciation
- HVAC/Trades: Work uniforms, branded polos, truck decals
- Event Planner: Corporate events, galas, conferences, team building
- Brand/Business: Merch, uniforms, promotional items, grand opening
- Nonprofit: Fundraiser shirts, awareness campaigns, volunteer gear
- Other: Personal events (reunions, birthdays, bachelorette)

=== SEASONAL CALENDAR ===
- Jan-Feb: New Year resolutions, Valentine's Day, Super Bowl
- Mar-Apr: Spring break, Easter, March Madness, prom
- May-Jun: Graduation, Mother's/Father's Day, end of school, summer camps
- Jul-Aug: Back to school, summer events, 4th of July
- Sep-Oct: Fall sports, homecoming, Halloween, Hispanic Heritage Month
- Nov-Dec: Thanksgiving, Christmas, holiday parties, year-end gifts

=== CRITICAL RULES ===
- ONLY use information from the lead's form data, conversation history, and database fields
- Do NOT make up facts about the lead's business
- Do NOT reference external reviews or activities unless they are in the lead's data
- If you don't have enough info, say so — "Insufficient data" is better than wrong data
- Form data is GROUND TRUTH — never contradict it with inferred information

Be concise and actionable. Focus on what helps write a better message.`;

export async function runResearcher(input: BrainCouncilInput, context: LeadContext, strategy: StrategyDecision): Promise<ResearchResult> {
  const { lead, historyStr } = context;

  const researchInput = `
LEAD DATA:
- Name: ${lead.name || "Unknown"}
- Business: ${lead.businessName || "Unknown"}
- Website: ${lead.website || "N/A"}
- Email: ${lead.email || "N/A"}
- Source: ${lead.source || "Unknown"}
- Segment: ${lead.omnisendSegment || "Unclassified"}
- Existing Research: ${JSON.stringify(lead.researchData || {})}

STRATEGY CONTEXT:
- Approach: ${strategy.approach}
- Angle: ${strategy.angle}
- Personalization Tier: ${strategy.personalizationTier}

CONVERSATION HISTORY:
${input.externalHistory ? input.externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

FORM DATA:
${input.formData?.map(f => `- ${f.label}: ${f.value}`).join("\n") || "None"}

Current date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

Produce your research brief now.`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: RESEARCHER_PROMPT },
      { role: "user", content: researchInput },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "research_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            companyInfo: { type: "string", description: "What we know/infer about their organization" },
            recentActivity: { type: "string", description: "Any recent signals from conversation or data" },
            likelyPainPoints: { type: "array", items: { type: "string" }, description: "Their probable pain points" },
            connectionPoints: { type: "array", items: { type: "string" }, description: "Specific things to reference for personalization" },
            competitorInsights: { type: "string", description: "What alternatives they might be considering" },
            seasonalRelevance: { type: "string", description: "Any seasonal hooks relevant right now" },
            summary: { type: "string", description: "1-2 sentence research summary for the composer" },
          },
          required: ["companyInfo", "recentActivity", "likelyPainPoints", "connectionPoints", "competitorInsights", "seasonalRelevance", "summary"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) return {
    companyInfo: "Unknown", recentActivity: "None", likelyPainPoints: [],
    connectionPoints: [], competitorInsights: "Unknown", seasonalRelevance: "None",
    summary: "Insufficient data for research",
  };
  return JSON.parse(content as string);
}

/** Returns a minimal empty research result — used when research is skipped (e.g. first contact) */
export function emptyResearch(): ResearchResult {
  return {
    companyInfo: "N/A — first contact, research skipped",
    recentActivity: "None",
    likelyPainPoints: [],
    connectionPoints: [],
    competitorInsights: "N/A",
    seasonalRelevance: "None",
    summary: "Research skipped for first contact — using form data only",
  };
}
