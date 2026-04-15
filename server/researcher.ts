/**
 * BRAIN 2: RESEARCHER — Gathers context about the lead for personalization
 * NOTE: Only runs on follow-ups/reactivation. First contact uses locked template.
 */

import { invokeLLM } from "./_core/llm";
import type { BrainCouncilInput, StrategyDecision, ResearchResult, LeadContext } from "./brain-types";

const RESEARCHER_PROMPT = `You are the RESEARCHER brain for Adorb Custom Tees' AI outreach system.

Your job is to synthesize all available information about a lead into an actionable
research brief. You do NOT write the message. You produce the intelligence that makes
the message feel like it came from someone who actually paid attention.

=== HARD CONSTRAINTS — READ FIRST, OVERRIDE EVERYTHING ===

1. NEVER invent facts. If you don't have data, say "Unknown" — do not guess.
2. NEVER contradict form data. Form data is ground truth. If the form says
   "100 t-shirts for a church retreat", that is the reality — do not infer otherwise.
3. ALWAYS flag repeated questions. If the conversation history shows a prior outbound
   message asking about quantity, print type, sizes, colors, timeline, or budget —
   flag it explicitly: "⚠️ ALREADY ASKED: [question]". The Composer must not ask it again.
4. ALWAYS compute and report: sentToday, totalOutboundCount, daysSinceLastOutbound,
   unansweredCount. These numbers directly control what the Strategist is allowed to do.
5. ALWAYS flag warm leads. If totalOutboundCount > 0, mark "WARM LEAD — prior contact
   exists. Cold intro is FORBIDDEN."

=== YOUR OUTPUT FORMAT ===

Produce a structured research brief with these exact sections:

LEAD IDENTITY
- Name, Business, Persona, Source channel, Pipeline stage

WHAT THEY WANT (from form data + conversation — ground truth only)
- Product, Quantity, Event/Purpose, Timeline/Deadline, Budget, Design status,
  Print type, Sizes/colors (use "Unknown" for anything not explicitly stated)

CONVERSATION INTELLIGENCE
- Total outbound messages sent: [sentToday today, totalOutboundCount total]
- Days since last outbound: [daysSinceLastOutbound]
- Consecutive unanswered: [unansweredCount]
- Last inbound message: [summary or "None"]
- Lead status: [WARM | COLD | RESPONSIVE | DORMANT]

PERSONALIZATION HOOKS (2-4 specific, concrete details to reference)

SEASONAL RELEVANCE (upcoming holidays/events relevant to this lead's segment)

RISK FLAGS (frustrated tone, competitor mention, price objection, DNC request,
  complex order, high value >$5K, reseller inquiry — or "None detected")

=== ADORB SEGMENTS AND TYPICAL NEEDS ===

Church/Ministry: Sunday shirts, VBS, retreats, choir, youth group, missions trips,
  baptism events, pastor appreciation. Reorder potential: HIGH.
Sports Team: Uniforms, fan gear, tournament shirts, spirit wear, coach polos.
  Reorder potential: VERY HIGH (every season).
School: Spirit wear, fundraisers, clubs, graduation, teacher appreciation,
  class trips, prom. Reorder potential: VERY HIGH.
HVAC/Trades: Work uniforms, branded polos, safety vests, truck decals.
  Reorder potential: HIGH (as team grows).
Event Planner: Corporate events, galas, conferences, team building,
  charity walks, 5Ks. Reorder potential: HIGH (annual events).
Brand/Business: Merch, uniforms, promotional items, grand opening,
  trade show swag. Reorder potential: MODERATE-HIGH.
Nonprofit: Fundraiser shirts, awareness campaigns, volunteer gear,
  walk/run events. Reorder potential: HIGH (annual campaigns).
Individual: Reunions, birthdays, bachelorette, personal gifts,
  memorial shirts. Reorder potential: LOW (but referral potential HIGH).
Reseller/Bulk: High-volume orders for distribution or resale.
  Reorder potential: VERY HIGH (ongoing relationship).

=== SEASONAL CALENDAR ===

Jan-Feb: New Year campaigns, Valentine's Day, Super Bowl watch parties,
  winter fundraisers, Black History Month (Feb)
Mar-Apr: Spring break, Easter, March Madness, prom season,
  spring sports, tax season (accountants/financial firms)
May-Jun: Graduation (peak season), Mother's/Father's Day,
  end of school, summer camps, VBS season, Juneteenth (Jun 19)
Jul-Aug: Back to school (peak), summer events, 4th of July,
  fall sports prep, Hispanic Heritage Month prep
Sep-Oct: Fall sports (peak), homecoming, Halloween,
  Hispanic Heritage Month, Breast Cancer Awareness (Oct pink)
Nov-Dec: Thanksgiving, Christmas (peak), holiday parties,
  year-end gifts, New Year's Eve events, Hanukkah

=== PERSONA INTELLIGENCE ===

CHURCH/MINISTRY persona:
  Typical order: 50-300 tees. Decision maker: Pastor, administrator, women's ministry leader.
  Timeline: Event-driven, 2-6 weeks. Price sensitivity: MODERATE.
  Key motivators: Unity, faith representation, community pride.
  Reorder trigger: Annual events, new sermon series, youth group growth.

SMALL BUSINESS persona:
  Typical order: 24-100 tees. Decision maker: Owner or marketing manager.
  Timeline: Varies. Price sensitivity: HIGH.
  Key motivators: Professional image, team unity, brand visibility, ROI.
  Reorder trigger: Team growth, new location, seasonal campaign.

EVENT PLANNER persona:
  Typical order: 100-500+. Decision maker: Event coordinator or committee.
  Timeline: 3-6 months in advance (LONG-LEAD). Price sensitivity: MODERATE.
  Key motivators: On-time delivery, quality, easy process, no surprises.
  Reorder trigger: Annual event cycle.

SCHOOL/SPORTS persona:
  Typical order: 20-100 per team/class. Decision maker: Coach, teacher, PTA, athletic director.
  Timeline: Seasonal. Price sensitivity: HIGH (fundraiser-funded).
  Key motivators: Team spirit, affordability, quick turnaround.
  Reorder trigger: Every season, every sport, every class.

CORPORATE/ENTERPRISE persona:
  Typical order: 200-2000+. Decision maker: HR, marketing, or procurement.
  Timeline: Planned, 4-8 weeks. Price sensitivity: LOW.
  Key motivators: Professional quality, brand consistency, easy reordering.
  Reorder trigger: New hires, quarterly events, annual conference.

NONPROFIT/CHARITY persona:
  Typical order: 50-300. Decision maker: Director, volunteer coordinator, board member.
  Timeline: Event-driven, 2-6 weeks. Price sensitivity: VERY HIGH.
  Key motivators: Cause representation, affordability, community impact.
  Reorder trigger: Annual events, new campaigns.

Be concise and actionable. Your brief should be scannable in 10 seconds.
Focus on what helps write a better, more personalized message.`;

export async function runResearcher(input: BrainCouncilInput, context: LeadContext, strategy: StrategyDecision): Promise<ResearchResult> {
  const { lead, historyStr } = context;

  // Compute sentToday, totalOutboundCount, daysSinceLastOutbound for the prompt
  const now = new Date();
  const todayET = now.toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const outboundMessages = context.priorOutbound || [];
  const sentToday = outboundMessages.filter((m: any) => {
    const msgDate = new Date(m.createdAt || m.timestamp || 0);
    return msgDate.toLocaleDateString("en-US", { timeZone: "America/New_York" }) === todayET;
  }).length;
  const totalOutboundCount = outboundMessages.length;
  const lastOutbound = outboundMessages[outboundMessages.length - 1];
  const daysSinceLastOutbound = lastOutbound
    ? Math.floor((now.getTime() - new Date(lastOutbound.createdAt || lastOutbound.timestamp || 0).getTime()) / (1000 * 60 * 60 * 24))
    : -1;

  // Sanitize researchData before injecting into the LLM prompt.
  // The old GHL sub-account had internal project management fields (Project Name, Project Business Name,
  // etc.) with value "The CEO Store" that got migrated to ALL imported contacts. Strip these so the
  // LLM doesn't infer them as the lead's business name.
  const ADORB_INTERNAL_FIELDS_R = new Set([
    'Project Name', 'Project Business Name', 'Project Business Email',
    'Project Business Phone Number', 'Project Business Point Of Contact',
    'Project City', 'Project Full Address', 'Project State', 'Project SOP Link',
  ]);
  // Also strip the raw oldGhlCustomFields array — it contains unmapped field IDs with values like
  // "The CEO Store" that the LLM will misinterpret as the lead's business name.
  const sanitizedResearchData = (() => {
    const rd = (lead.researchData as Record<string, unknown>) || {};
    const tc = (rd.transferredContact as Record<string, unknown>) || {};
    const resolvedRaw = (tc.resolvedCustomFields as Record<string, unknown>) || {};
    const resolvedClean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resolvedRaw)) {
      if (!ADORB_INTERNAL_FIELDS_R.has(k)) resolvedClean[k] = v;
    }
    // Build a clean copy of transferredContact without oldGhlCustomFields (raw unmapped fields)
    const tcClean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tc)) {
      if (k !== 'oldGhlCustomFields') tcClean[k] = v;
    }
    tcClean.resolvedCustomFields = resolvedClean;
    return { ...rd, transferredContact: tcClean };
  })();

  const researchInput = `
LEAD DATA:
- Name: ${lead.name || "Unknown"}
- Business: ${lead.businessName || "Unknown"}
- Website: ${lead.website || "N/A"}
- Email: ${lead.email || "N/A"}
- Source: ${lead.source || "Unknown"}
- Segment: ${lead.omnisendSegment || "Unclassified"}
- Pipeline stage: ${lead.pipelineStage || "Unknown"}
- Existing Research: ${JSON.stringify(sanitizedResearchData)}

COMPUTED METRICS (ground truth — use these exactly):
- sentToday: ${sentToday}
- totalOutboundCount: ${totalOutboundCount}
- daysSinceLastOutbound: ${daysSinceLastOutbound === -1 ? "N/A (no prior outbound)" : daysSinceLastOutbound}
- unansweredCount: ${context.unansweredCount}
- leadAgeDays: ${context.leadAgeDays}

STRATEGY CONTEXT:
- Approach: ${strategy.approach}
- Angle: ${strategy.angle}
- Personalization Tier: ${strategy.personalizationTier}

CONVERSATION HISTORY:
${input.externalHistory ? input.externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

FORM DATA:
${input.formData?.map(f => `- ${f.label}: ${f.value}`).join("\n") || "None"}

Current date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

Produce your research brief now. Pay special attention to:
1. List ALL questions already asked in prior outbound messages in the alreadyAsked array.
2. Set leadStatus to WARM if totalOutboundCount > 0, COLD if 0, RESPONSIVE if lead replied recently, DORMANT if no reply in 7+ days.`;

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
            alreadyAsked: { type: "array", items: { type: "string" }, description: "Questions already asked in prior outbound messages — Composer must NOT repeat these. Include the exact question text." },
            leadStatus: { type: "string", enum: ["WARM", "COLD", "RESPONSIVE", "DORMANT"], description: "WARM if totalOutboundCount > 0, COLD if 0, RESPONSIVE if lead replied recently, DORMANT if no reply in 7+ days" },
            dataConfidence: { type: "string", enum: ["verified", "inferred", "insufficient"], description: "'verified' if all facts from form data/conversation history; 'inferred' if any facts are LLM inferences from business name/segment; 'insufficient' if not enough data" },
          },
          required: ["companyInfo", "recentActivity", "likelyPainPoints", "connectionPoints", "competitorInsights", "seasonalRelevance", "summary", "alreadyAsked", "leadStatus", "dataConfidence"],
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
    alreadyAsked: [],
    leadStatus: "COLD",
    dataConfidence: "insufficient" as const,
  };
  const parsed = JSON.parse(content as string);
  // Ensure fields are always set — older LLM responses may omit them
  if (!parsed.dataConfidence) parsed.dataConfidence = "inferred";
  if (!parsed.alreadyAsked) parsed.alreadyAsked = [];
  if (!parsed.leadStatus) parsed.leadStatus = totalOutboundCount > 0 ? "WARM" : "COLD";
  return parsed;
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
    alreadyAsked: [],
    leadStatus: "COLD",
    dataConfidence: "verified", // first contact uses only form data (ground truth)
  };
}
