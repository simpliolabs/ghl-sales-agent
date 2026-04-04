/**
 * Lead Researcher — Real online research pipeline for lead enrichment
 * 
 * Uses LinkedIn Data API + LLM analysis to build rich context about leads
 * before the AI brain engages them. This replaces the fake "generateResearchContext"
 * that just reformatted existing data.
 * 
 * Research sources:
 * 1. LinkedIn Company API — staff count, industry, specialties, description
 * 2. Website domain analysis — inferred from email domain or provided URL
 * 3. LLM synthesis — combines all signals into actionable sales context
 */

import { invokeLLM } from "./_core/llm";
import { callDataApi } from "./_core/dataApi";

export interface ResearchResult {
  summary: string;           // 2-3 sentence executive summary
  businessType: string;      // e.g. "Church/Ministry", "HVAC Contractor", "School"
  staffCount: string;        // e.g. "11-50 employees"
  industry: string;          // from LinkedIn or inferred
  potentialNeeds: string[];  // specific printing needs for this type of org
  eventCalendar: string[];   // likely events/seasons when they'd need printing
  competitorInsight: string; // what similar orgs typically order
  personalAngle: string;     // suggested conversation opener based on research
  confidence: "high" | "medium" | "low"; // how much data we actually found
  sources: string[];         // which sources contributed data
  rawLinkedIn?: Record<string, unknown>; // raw LinkedIn data for reference
}

/**
 * Research a lead using all available online sources
 */
export async function researchLead(leadData: {
  name?: string;
  businessName?: string;
  website?: string;
  email?: string;
  phone?: string;
  source?: string;
  segment?: string;
  ghlConversationSummary?: string; // summary of GHL conversation history if available
}): Promise<ResearchResult> {
  const sources: string[] = [];
  let linkedInData: Record<string, unknown> | null = null;
  let linkedInSummary = "";

  // --- STEP 1: LinkedIn Company Lookup ---
  if (leadData.businessName) {
    try {
      // Normalize business name to LinkedIn username format
      const username = normalizeToLinkedInUsername(leadData.businessName);
      const result = await callDataApi("LinkedIn/get_company_details", {
        query: { username },
      }) as Record<string, unknown>;

      if (result && (result as Record<string, unknown>).success) {
        const data = (result as Record<string, unknown>).data as Record<string, unknown>;
        if (data) {
          linkedInData = data;
          sources.push("LinkedIn");
          linkedInSummary = buildLinkedInSummary(data);
        }
      }
    } catch (err) {
      console.log(`[Researcher] LinkedIn lookup failed for "${leadData.businessName}": ${(err as Error).message}`);
    }

    // Try alternate name formats if first attempt failed
    if (!linkedInData && leadData.businessName.includes(" ")) {
      try {
        const altUsername = leadData.businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
        const result = await callDataApi("LinkedIn/get_company_details", {
          query: { username: altUsername },
        }) as Record<string, unknown>;

        if (result && (result as Record<string, unknown>).success) {
          const data = (result as Record<string, unknown>).data as Record<string, unknown>;
          if (data) {
            linkedInData = data;
            sources.push("LinkedIn");
            linkedInSummary = buildLinkedInSummary(data);
          }
        }
      } catch {
        // Silent fail on alternate lookup
      }
    }
  }

  // --- STEP 2: Domain/Email Analysis ---
  let domainInsight = "";
  if (leadData.email) {
    const domain = leadData.email.split("@")[1];
    if (domain && !["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com"].includes(domain)) {
      domainInsight = `Business email domain: ${domain} — likely a real business with their own domain.`;
      sources.push("Email domain");
    } else {
      domainInsight = `Personal email (${domain}) — may be a sole proprietor or individual buyer.`;
      sources.push("Email analysis");
    }
  }

  if (leadData.website) {
    domainInsight += ` Website: ${leadData.website}`;
    sources.push("Website");
  }

  // --- STEP 3: LLM Synthesis ---
  // Combine all signals into actionable research context
  const researchPrompt = buildResearchPrompt(leadData, linkedInSummary, domainInsight);

  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a lead research analyst for Adorb Custom Tees, a custom printing company in Hallandale Beach, FL. Your job is to synthesize all available data about a potential customer into actionable sales intelligence.

You specialize in identifying:
- What type of organization this is and what they likely need printed
- When they typically need printing (seasonal events, recurring needs)
- What similar organizations usually order (competitive insight)
- The best conversation angle to open with

Be specific and actionable. Don't be generic. If you have limited data, say so honestly and make your best inference from what's available.

IMPORTANT: For churches — they need event shirts, VBS shirts, retreat shirts, choir robes, welcome packets.
For schools — they need spirit wear, team uniforms, graduation items, fundraiser merch.
For HVAC/contractors — they need work uniforms, branded polos, vehicle wraps, business cards.
For event planners — they need event-specific merch, staff shirts, giveaway items.
For brands — they need branded merchandise, promotional items, packaging.

Return JSON matching the schema exactly.`,
        },
        {
          role: "user",
          content: researchPrompt,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "research_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "2-3 sentence executive summary of who this lead is, what they do, and what they likely need from us" },
              businessType: { type: "string", description: "Specific type of business/organization" },
              staffCount: { type: "string", description: "Estimated staff count or 'Unknown'" },
              industry: { type: "string", description: "Industry classification" },
              potentialNeeds: {
                type: "array",
                items: { type: "string" },
                description: "3-5 specific printing products/services they likely need",
              },
              eventCalendar: {
                type: "array",
                items: { type: "string" },
                description: "Likely events/seasons when they'd need printing (e.g., 'Back-to-school August', 'Easter April')",
              },
              competitorInsight: { type: "string", description: "What similar organizations typically order and how much they spend" },
              personalAngle: { type: "string", description: "Suggested conversation opener that references something specific about them" },
              confidence: { type: "string", description: "high, medium, or low — based on how much real data we found" },
            },
            required: ["summary", "businessType", "staffCount", "industry", "potentialNeeds", "eventCalendar", "competitorInsight", "personalAngle", "confidence"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      return buildFallbackResult(leadData, sources);
    }

    const parsed = JSON.parse(content as string);
    return {
      ...parsed,
      confidence: parsed.confidence as "high" | "medium" | "low",
      sources,
      rawLinkedIn: linkedInData || undefined,
    };
  } catch (err) {
    console.error("[Researcher] LLM synthesis failed:", err);
    return buildFallbackResult(leadData, sources);
  }
}

/**
 * Batch research multiple leads (with rate limiting)
 */
export async function batchResearchLeads(
  leads: Array<{
    id: number;
    name?: string;
    businessName?: string;
    website?: string;
    email?: string;
    source?: string;
    segment?: string;
  }>,
  onProgress?: (completed: number, total: number) => void,
): Promise<Map<number, ResearchResult>> {
  const results = new Map<number, ResearchResult>();
  
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    try {
      const result = await researchLead(lead);
      results.set(lead.id, result);
    } catch (err) {
      console.error(`[Researcher] Failed to research lead ${lead.id}:`, err);
      results.set(lead.id, buildFallbackResult(lead, []));
    }

    if (onProgress) onProgress(i + 1, leads.length);

    // Rate limit: 1 request per second to avoid API throttling
    if (i < leads.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}

// --- HELPERS ---

function normalizeToLinkedInUsername(businessName: string): string {
  return businessName
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/\b(inc|llc|ltd|corp|co|company|the)\b/gi, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+$/, "")
    .replace(/^-+/, "");
}

function buildLinkedInSummary(data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (data.name) parts.push(`Company: ${data.name}`);
  if (data.tagline) parts.push(`Tagline: ${data.tagline}`);
  if (data.staffCount) parts.push(`Staff: ${data.staffCount}`);
  if (data.staffCountRange) parts.push(`Staff Range: ${data.staffCountRange}`);
  if (data.followerCount) parts.push(`LinkedIn Followers: ${data.followerCount}`);
  if (data.website) parts.push(`Website: ${data.website}`);
  
  const industries = data.industries as string[] | undefined;
  if (industries?.length) parts.push(`Industries: ${industries.join(", ")}`);
  
  const specialities = data.specialities as string[] | undefined;
  if (specialities?.length) parts.push(`Specialties: ${specialities.join(", ")}`);
  
  const description = data.description as string | undefined;
  if (description) parts.push(`Description: ${description.substring(0, 300)}`);
  
  return parts.join("\n");
}

function buildResearchPrompt(
  leadData: {
    name?: string;
    businessName?: string;
    website?: string;
    email?: string;
    phone?: string;
    source?: string;
    segment?: string;
    ghlConversationSummary?: string;
  },
  linkedInSummary: string,
  domainInsight: string,
): string {
  const parts: string[] = [];
  
  parts.push("=== LEAD DATA ===");
  if (leadData.name) parts.push(`Contact Name: ${leadData.name}`);
  if (leadData.businessName) parts.push(`Business Name: ${leadData.businessName}`);
  if (leadData.website) parts.push(`Website: ${leadData.website}`);
  if (leadData.email) parts.push(`Email: ${leadData.email}`);
  if (leadData.source) parts.push(`Lead Source: ${leadData.source}`);
  if (leadData.segment) parts.push(`Pre-classified Segment: ${leadData.segment}`);

  if (linkedInSummary) {
    parts.push("\n=== LINKEDIN DATA ===");
    parts.push(linkedInSummary);
  }

  if (domainInsight) {
    parts.push("\n=== DOMAIN ANALYSIS ===");
    parts.push(domainInsight);
  }

  if (leadData.ghlConversationSummary) {
    parts.push("\n=== CONVERSATION HISTORY SUMMARY ===");
    parts.push(leadData.ghlConversationSummary);
  }

  parts.push("\n=== YOUR TASK ===");
  parts.push("Synthesize all the above data into actionable sales intelligence for our custom printing team.");
  parts.push("Be SPECIFIC — don't say 'they might need t-shirts'. Say 'they likely need 50-100 event shirts for their annual retreat based on their church size'.");

  return parts.join("\n");
}

function buildFallbackResult(
  leadData: { name?: string; businessName?: string; source?: string; segment?: string },
  sources: string[],
): ResearchResult {
  return {
    summary: `${leadData.businessName || leadData.name || "Unknown lead"} — limited data available. Source: ${leadData.source || "unknown"}.`,
    businessType: leadData.segment || "Unknown",
    staffCount: "Unknown",
    industry: "Unknown",
    potentialNeeds: ["Custom t-shirts", "Branded merchandise"],
    eventCalendar: [],
    competitorInsight: "Insufficient data to assess typical orders for similar organizations.",
    personalAngle: `Reference their ${leadData.source || "inquiry"} and ask about their specific needs.`,
    confidence: "low",
    sources,
  };
}
