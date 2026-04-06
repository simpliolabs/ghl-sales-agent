/**
 * BRAIN COUNCIL — Shared types for the multi-brain architecture
 */

export interface BrainCouncilInput {
  leadId: number;
  incomingMessage: string;
  channel: string;
  externalHistory?: string;
  formData?: Array<{ label: string; value: string }>;
  overrideReason?: string;
}

export interface StrategyDecision {
  approach: "first_contact" | "follow_up" | "reactivation" | "post_delivery" | "seasonal" | "value_add" | "recovery";
  channel: string;
  angle: string;
  framework: "PAS" | "BAB" | "AIDA" | "HORMOZI_ACA" | "HORMOZI_INDIRECT" | "SOCIAL_PROOF" | "CASE_STUDY" | "SOAP_OPERA" | "EMB_WELCOME" | "EMB_WINBACK" | "EMB_POST_PURCHASE" | "EMB_COLD";
  personalizationTier: 1 | 2 | 3;
  toneDirective: string;
  maxLength: number;
  keyPoints: string[];
  avoidPoints: string[];
  nextEngagementHours: number;
  reasoning: string;
}

export interface ResearchResult {
  companyInfo: string;
  recentActivity: string;
  likelyPainPoints: string[];
  connectionPoints: string[];
  competitorInsights: string;
  seasonalRelevance: string;
  summary: string;
}

export interface ComposedMessage {
  message: string;
  fromName: string;
  subject?: string;
  internalNotes: string;
}

export interface QCVerdict {
  approved: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
  revisedMessage?: string;
}

export interface BrainCouncilOutput {
  message: string;
  fromName: string;
  subject?: string;
  framework: string;
  angle: string;
  channel: string; // Strategist's chosen channel — callers should use this for sending
  extractedDates: string[];
  score: number;
  segment: string;
  nextEngagementHours: number;
  qcScore: number;
  strategyReasoning: string;
  researchSummary: string;
  blocked: boolean;
  blockReason?: string;
  violationCategory?: string;
  fallbackUsed: boolean;
  fallbackMessage?: string;
}

export type ViolationCategory = "irrelevant_research" | "form_data_ignored" | "wrong_business" | "generic_opener" | "missing_framework" | "safety_violation";

export type LeadContext = {
  lead: any;
  convHistory: any[];
  state: any;
  tweakInstructions: string;
  kbContent: string;
  historyStr: string;
  isFirstResponse: boolean;
  priorOutbound: any[];
  leadAgeDays: number;
  urgencyStage: string;
  unansweredCount: number;
};
