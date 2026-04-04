/**
 * Lead Researcher — Real online research pipeline for lead enrichment
 * 
 * Genuine data sources (verified available):
 * 1. Google Places API (via Maps proxy) — business details, reviews, ratings, website, hours
 * 2. LinkedIn Company API (via Data API) — staff count, industry, specialties, description
 * 3. Email domain analysis — business vs personal email classification
 * 4. LLM synthesis — combines all real signals into actionable sales context
 * 
 * NOT available (honest disclosure):
 * - No Google web search API
 * - No Facebook/Instagram/Twitter APIs
 * - No Yelp/BBB APIs
 * - No Clearbit/Hunter enrichment APIs
 */

import { invokeLLM } from "./_core/llm";
import { callDataApi } from "./_core/dataApi";
import { makeRequest, type PlacesSearchResult, type PlaceDetailsResult } from "./_core/map";

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
  googlePlacesData?: {       // real Google Places data
    rating?: number;
    totalReviews?: number;
    address?: string;
    phone?: string;
    website?: string;
    businessStatus?: string;
    recentReviews?: Array<{ author: string; rating: number; text: string }>;
    openingHours?: string[];
  };
  rawLinkedIn?: Record<string, unknown>; // raw LinkedIn data for reference
}

// ============================================================================
// STEP 1: Google Places API — Real business lookup
// ============================================================================

interface GooglePlacesInfo {
  found: boolean;
  name?: string;
  address?: string;
  phone?: string;
  website?: string;
  rating?: number;
  totalReviews?: number;
  businessStatus?: string;
  recentReviews?: Array<{ author: string; rating: number; text: string }>;
  openingHours?: string[];
  placeTypes?: string[];
}

async function lookupGooglePlaces(
  businessName: string,
  location?: string,
): Promise<GooglePlacesInfo> {
  try {
    // Search for the business using Google Places Text Search
    const query = location
      ? `${businessName} ${location}`
      : `${businessName} Florida`; // Default to Florida since Adorb is in Hallandale Beach

    const searchResult = await makeRequest<PlacesSearchResult>(
      "/maps/api/place/textsearch/json",
      { query },
    );

    if (searchResult.status !== "OK" || !searchResult.results?.length) {
      return { found: false };
    }

    const topResult = searchResult.results[0];

    // Get detailed info including reviews
    const detailResult = await makeRequest<PlaceDetailsResult>(
      "/maps/api/place/details/json",
      {
        place_id: topResult.place_id,
        fields: "name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,reviews,opening_hours,types,business_status",
      },
    );

    if (detailResult.status !== "OK" || !detailResult.result) {
      // Return basic info from search result
      return {
        found: true,
        name: topResult.name,
        address: topResult.formatted_address,
        rating: topResult.rating,
        totalReviews: topResult.user_ratings_total,
        businessStatus: topResult.business_status,
        placeTypes: topResult.types,
      };
    }

    const detail = detailResult.result;
    return {
      found: true,
      name: detail.name,
      address: detail.formatted_address,
      phone: detail.formatted_phone_number,
      website: detail.website,
      rating: detail.rating,
      totalReviews: detail.user_ratings_total,
      businessStatus: topResult.business_status,
      recentReviews: detail.reviews?.slice(0, 3).map(r => ({
        author: r.author_name,
        rating: r.rating,
        text: r.text?.substring(0, 200) || "",
      })),
      openingHours: detail.opening_hours?.weekday_text,
      placeTypes: topResult.types,
    };
  } catch (err) {
    console.log(`[Researcher] Google Places lookup failed for "${businessName}": ${(err as Error).message}`);
    return { found: false };
  }
}

// ============================================================================
// STEP 2: LinkedIn Company API — Company details
// ============================================================================

interface LinkedInInfo {
  found: boolean;
  data?: Record<string, unknown>;
  summary?: string;
}

async function lookupLinkedIn(businessName: string): Promise<LinkedInInfo> {
  // Try primary username format
  const usernames = [
    normalizeToLinkedInUsername(businessName),
    businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, ""),
  ];

  for (const username of usernames) {
    try {
      const result = await callDataApi("LinkedIn/get_company_details", {
        query: { username },
      }) as Record<string, unknown>;

      if (result && result.success) {
        const data = result.data as Record<string, unknown>;
        if (data) {
          return {
            found: true,
            data,
            summary: buildLinkedInSummary(data),
          };
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429")) {
        console.log("[Researcher] LinkedIn API rate limited — skipping");
        return { found: false };
      }
      // Try next username format
    }
  }

  return { found: false };
}

// ============================================================================
// STEP 3: Email Domain Analysis
// ============================================================================

const PERSONAL_DOMAINS = [
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
  "icloud.com", "mail.com", "protonmail.com", "live.com", "msn.com",
  "comcast.net", "att.net", "verizon.net", "bellsouth.net",
];

function analyzeEmailDomain(email?: string): { insight: string; isBusinessEmail: boolean } {
  if (!email) return { insight: "", isBusinessEmail: false };

  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return { insight: "", isBusinessEmail: false };

  if (PERSONAL_DOMAINS.includes(domain)) {
    return {
      insight: `Personal email (${domain}) — likely a sole proprietor, individual buyer, or small operation without a business domain.`,
      isBusinessEmail: false,
    };
  }

  return {
    insight: `Business email domain: ${domain} — established organization with their own domain. Website likely at https://${domain}`,
    isBusinessEmail: true,
  };
}

// ============================================================================
// MAIN: Research a lead using all available sources
// ============================================================================

export async function researchLead(leadData: {
  name?: string;
  businessName?: string;
  website?: string;
  email?: string;
  phone?: string;
  source?: string;
  segment?: string;
  ghlConversationSummary?: string;
}): Promise<ResearchResult> {
  const sources: string[] = [];
  
  // --- Run all lookups in parallel for speed ---
  const [googlePlaces, linkedIn] = await Promise.all([
    leadData.businessName
      ? lookupGooglePlaces(leadData.businessName)
      : Promise.resolve({ found: false } as GooglePlacesInfo),
    leadData.businessName
      ? lookupLinkedIn(leadData.businessName)
      : Promise.resolve({ found: false } as LinkedInInfo),
  ]);

  // Track which sources returned real data
  if (googlePlaces.found) sources.push("Google Places");
  if (linkedIn.found) sources.push("LinkedIn");

  const emailAnalysis = analyzeEmailDomain(leadData.email);
  if (emailAnalysis.insight) sources.push("Email domain analysis");

  if (leadData.website) sources.push("Provided website");
  if (leadData.ghlConversationSummary) sources.push("GHL conversation history");

  // --- Build the research prompt with ONLY real data ---
  const promptParts: string[] = [];

  promptParts.push("=== LEAD BASIC INFO ===");
  if (leadData.name) promptParts.push(`Contact Name: ${leadData.name}`);
  if (leadData.businessName) promptParts.push(`Business Name: ${leadData.businessName}`);
  if (leadData.website) promptParts.push(`Website: ${leadData.website}`);
  if (leadData.email) promptParts.push(`Email: ${leadData.email}`);
  if (leadData.source) promptParts.push(`Lead Source: ${leadData.source}`);
  if (leadData.segment) promptParts.push(`Pre-classified Segment: ${leadData.segment}`);

  if (googlePlaces.found) {
    promptParts.push("\n=== GOOGLE PLACES DATA (VERIFIED) ===");
    if (googlePlaces.name) promptParts.push(`Business Name: ${googlePlaces.name}`);
    if (googlePlaces.address) promptParts.push(`Address: ${googlePlaces.address}`);
    if (googlePlaces.phone) promptParts.push(`Phone: ${googlePlaces.phone}`);
    if (googlePlaces.website) promptParts.push(`Website: ${googlePlaces.website}`);
    if (googlePlaces.rating) promptParts.push(`Google Rating: ${googlePlaces.rating}/5 (${googlePlaces.totalReviews || 0} reviews)`);
    if (googlePlaces.businessStatus) promptParts.push(`Business Status: ${googlePlaces.businessStatus}`);
    if (googlePlaces.placeTypes?.length) promptParts.push(`Place Types: ${googlePlaces.placeTypes.join(", ")}`);
    if (googlePlaces.openingHours?.length) promptParts.push(`Hours: ${googlePlaces.openingHours.join("; ")}`);
    if (googlePlaces.recentReviews?.length) {
      promptParts.push("Recent Reviews:");
      for (const review of googlePlaces.recentReviews) {
        promptParts.push(`  - ${review.author} (${review.rating}/5): "${review.text}"`);
      }
    }
  }

  if (linkedIn.found && linkedIn.summary) {
    promptParts.push("\n=== LINKEDIN DATA (VERIFIED) ===");
    promptParts.push(linkedIn.summary);
  }

  if (emailAnalysis.insight) {
    promptParts.push("\n=== EMAIL DOMAIN ANALYSIS ===");
    promptParts.push(emailAnalysis.insight);
  }

  if (leadData.ghlConversationSummary) {
    promptParts.push("\n=== PRIOR CONVERSATION HISTORY ===");
    promptParts.push(leadData.ghlConversationSummary);
  }

  promptParts.push(`\n=== DATA SOURCES USED: ${sources.length > 0 ? sources.join(", ") : "NONE — only basic lead info available"} ===`);
  promptParts.push("\n=== YOUR TASK ===");
  promptParts.push("Synthesize ONLY the data above into actionable sales intelligence for Adorb Custom Tees.");
  promptParts.push("Be SPECIFIC — don't say 'they might need t-shirts'. Say 'they likely need 50-100 event shirts for their annual retreat based on their church size of 200+ members'.");
  promptParts.push("If a data source is missing, say so. Do NOT fabricate information. Mark confidence accordingly.");

  // --- LLM Synthesis ---
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a lead research analyst for Adorb Custom Tees, a custom printing company in Hallandale Beach, FL. Your job is to synthesize VERIFIED data about a potential customer into actionable sales intelligence.

CRITICAL RULES:
1. Only reference data that was actually provided in the research input
2. If Google Places data is available, use the REAL rating, reviews, and address — do not make up numbers
3. If LinkedIn data is available, use the REAL staff count and industry — do not estimate
4. If data is missing, explicitly say "Unknown — no data available" rather than guessing
5. Your confidence level MUST reflect actual data availability:
   - "high" = Google Places + LinkedIn both found real data
   - "medium" = One source found real data
   - "low" = No external sources found data, working from basic lead info only

INDUSTRY-SPECIFIC KNOWLEDGE for printing needs:
- Churches: event shirts, VBS shirts, retreat shirts, choir robes, welcome packets, holiday event merch
- Schools: spirit wear, team uniforms, graduation items, fundraiser merch, club shirts
- HVAC/Contractors: work uniforms, branded polos, vehicle wraps, business cards, safety vests
- Event planners: event-specific merch, staff shirts, giveaway items, branded bags
- Restaurants/Bars: staff uniforms, branded merch, promotional items
- Nonprofits: fundraiser merch, volunteer shirts, awareness campaign items
- Sports teams: jerseys, practice shirts, fan merch, tournament shirts

Return JSON matching the schema exactly.`,
        },
        { role: "user", content: promptParts.join("\n") },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "research_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "2-3 sentence executive summary based ONLY on verified data" },
              businessType: { type: "string", description: "Specific type of business/organization" },
              staffCount: { type: "string", description: "From LinkedIn if available, otherwise 'Unknown'" },
              industry: { type: "string", description: "From LinkedIn/Google Places if available" },
              potentialNeeds: {
                type: "array",
                items: { type: "string" },
                description: "3-5 specific printing products/services they likely need based on their business type",
              },
              eventCalendar: {
                type: "array",
                items: { type: "string" },
                description: "Likely events/seasons when they'd need printing (e.g., 'Back-to-school August', 'Easter April')",
              },
              competitorInsight: { type: "string", description: "What similar organizations typically order and how much they spend" },
              personalAngle: { type: "string", description: "Suggested conversation opener that references something REAL from the data (a review, their rating, their location, their specialty)" },
              confidence: { type: "string", description: "high, medium, or low" },
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
      googlePlacesData: googlePlaces.found
        ? {
            rating: googlePlaces.rating,
            totalReviews: googlePlaces.totalReviews,
            address: googlePlaces.address,
            phone: googlePlaces.phone,
            website: googlePlaces.website,
            businessStatus: googlePlaces.businessStatus,
            recentReviews: googlePlaces.recentReviews,
            openingHours: googlePlaces.openingHours,
          }
        : undefined,
      rawLinkedIn: linkedIn.data || undefined,
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

    // Rate limit: 1.5 seconds between leads to avoid Google Places throttling
    if (i < leads.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
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

function buildFallbackResult(
  leadData: { name?: string; businessName?: string; source?: string; segment?: string },
  sources: string[],
): ResearchResult {
  return {
    summary: `${leadData.businessName || leadData.name || "Unknown lead"} — limited data available from ${sources.length} source(s). No Google Places or LinkedIn data found.`,
    businessType: leadData.segment || "Unknown",
    staffCount: "Unknown — no LinkedIn data",
    industry: "Unknown — no external data",
    potentialNeeds: ["Custom t-shirts", "Branded merchandise"],
    eventCalendar: [],
    competitorInsight: "Insufficient data — no external sources available to assess typical orders.",
    personalAngle: `Reference their ${leadData.source || "inquiry"} and ask about their specific needs.`,
    confidence: "low",
    sources,
  };
}
