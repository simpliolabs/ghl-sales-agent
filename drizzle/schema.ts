import { int, bigint, mysqlEnum, mysqlTable, text, timestamp, varchar, json, tinyint, uniqueIndex, index, decimal, datetime } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin", "viewer"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const leads = mysqlTable("leads", {
  id: int("id").autoincrement().primaryKey(),
  ghlContactId: varchar("ghlContactId", { length: 128 }).unique(),
  ghlOpportunityId: varchar("ghlOpportunityId", { length: 128 }),
  ghlPipelineId: varchar("ghlPipelineId", { length: 128 }),
  ghlStageId: varchar("ghlStageId", { length: 128 }),
  opportunityStatus: varchar("opportunityStatus", { length: 32 }), // open, won, lost, abandoned
  opportunityName: varchar("opportunityName", { length: 255 }),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 32 }),
  businessName: varchar("businessName", { length: 255 }),
  website: varchar("website", { length: 512 }),
  source: varchar("source", { length: 64 }),
  researchData: json("researchData"),
  omnisendSegment: varchar("omnisendSegment", { length: 64 }),
  opportunityScore: int("opportunityScore").default(0),
  assignedAgent: varchar("assignedAgent", { length: 128 }),
  pipelineStage: varchar("pipelineStage", { length: 64 }).default("new_lead"),
  opportunityValue: varchar("opportunityValue", { length: 32 }).default("0"),
  lastMessageAt: timestamp("lastMessageAt"),
  nextFollowUpAt: timestamp("nextFollowUpAt"),
  contextDates: json("contextDates"),
  humanTakeover: tinyint("humanTakeover").default(0),
  lastAgentActivityAt: timestamp("lastAgentActivityAt"),
  pipelineValue: int("pipelineValue").default(0),
  // Context-aware scheduling fields
  cadencePosition: int("cadencePosition").default(0), // 0=fresh, 1-6=silence cadence steps
  reactivationCount: int("reactivationCount").default(0), // how many quarterly reactivation cycles
  lastReactivationAt: timestamp("lastReactivationAt"),
  lastSeasonalPushAt: timestamp("lastSeasonalPushAt"),
  lastLostNurtureAt: timestamp("lastLostNurtureAt"), // last quarterly re-engagement email sent to a Lost lead
  lastSlaAlertAt: timestamp("lastSlaAlertAt"), // last SLA breach alert sent — DB-backed dedup (survives restarts), 6h minimum
  lastPaymentNotifiedAt: timestamp("lastPaymentNotifiedAt"), // last payment notification fired — dedup, 6h minimum
  lastEventTrigger: varchar("lastEventTrigger", { length: 64 }), // event-driven trigger type that last rescheduled this lead
  lastEventTriggerAt: timestamp("lastEventTriggerAt"), // when the event trigger last fired for this lead
  seasonalSegment: varchar("seasonalSegment", { length: 64 }), // which seasonal campaign last applied
  // Score decay tracking
  lastScoreDecayAt: timestamp("lastScoreDecayAt"),
  baseScore: int("baseScore").default(50), // score before decay
  // Override tracking
  overrideBy: varchar("overrideBy", { length: 128 }), // who overrode the schedule
  overrideAt: timestamp("overrideAt"),
  overrideReason: text("overrideReason"), // why they overrode
  // Brain council metadata
  lastQcScore: int("lastQcScore"),
  lastStrategyReasoning: text("lastStrategyReasoning"),
  lastResearchSummary: text("lastResearchSummary"),
  // Channel preference
  preferredChannel: varchar("preferredChannel", { length: 32 }),
  lastOutboundChannel: varchar("lastOutboundChannel", { length: 32 }),
  // DB-level duplicate send prevention: set BEFORE sending, checked by all senders
  lastAiSendAttemptAt: timestamp("lastAiSendAttemptAt"),
  // DB-level Brain Council processing lock (prevents concurrent runs across webhook + fast scanner + follow-up trigger)
  processingLockedAt: timestamp("processingLockedAt"),
  // GHL DND per-channel status — synced from GHL API dndSettings
  // "active" or "permanent" means blocked; null/empty means allowed
  dndSms: varchar("dndSms", { length: 32 }),
  dndEmail: varchar("dndEmail", { length: 32 }),
  dndFb: varchar("dndFb", { length: 32 }),
  dndWhatsapp: varchar("dndWhatsapp", { length: 32 }),
  dndGmb: varchar("dndGmb", { length: 32 }),
  dndSyncedAt: timestamp("dndSyncedAt"),
  // Email engagement tracking (from GHL email events)
  emailOpens: int("emailOpens").default(0),
  emailClicks: int("emailClicks").default(0),
  emailBounces: int("emailBounces").default(0),
  emailUnsubscribed: tinyint("emailUnsubscribed").default(0),
  lastEmailOpenAt: timestamp("lastEmailOpenAt"),
  lastEmailClickAt: timestamp("lastEmailClickAt"),
  // Appointment tracking (from GHL appointment events)
  nextAppointmentAt: timestamp("nextAppointmentAt"),
  appointmentStatus: varchar("appointmentStatus", { length: 32 }), // scheduled, confirmed, showed, no_show, cancelled
  appointmentId: varchar("appointmentId", { length: 128 }),
  ghlTaskId: varchar("ghlTaskId", { length: 128 }),
  // Agent notes (from GHL note events — latest agent note for context)
  lastAgentNote: text("lastAgentNote"),
  lastAgentNoteAt: timestamp("lastAgentNoteAt"),
  // Migrated contact reactivation flag
  // 0 = still email-only (migrated, not yet re-engaged), 1 = reactivated (inbound message received)
  reactivatedFromMigration: tinyint("reactivatedFromMigration").default(0),
  // DB-level appointment creation lock — set BEFORE creating appointment, cleared after
  // Prevents race condition when contact webhook + message webhook fire simultaneously
  appointmentCreatingAt: timestamp("appointmentCreatingAt"),
  // Conversation State Machine (Phase A)
  convState: varchar("convState", { length: 20 }).default("new_lead"),
  convStateUpdatedAt: bigint("convStateUpdatedAt", { mode: "number" }),
  intentHistory: json("intentHistory"), // last 10 classified intents [{intent, confidence, timestamp}]
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const conversations = mysqlTable("conversations", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  channel: varchar("channel", { length: 32 }),
  direction: mysqlEnum("direction", ["inbound", "outbound"]).notNull(),
  messageBody: text("messageBody"),
  senderType: mysqlEnum("senderType", ["ai", "human", "lead"]).notNull(),
  senderName: varchar("senderName", { length: 128 }),
  ghlMessageId: varchar("ghlMessageId", { length: 128 }),
  emailMessageId: varchar("emailMessageId", { length: 128 }), // GHL email thread ID for reply threading
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

export const aiState = mysqlTable("ai_state", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull().unique(),
  lastAngleUsed: text("lastAngleUsed"),
  objectionsRaised: json("objectionsRaised"),
  interestSignals: json("interestSignals"),
  unansweredQuestions: json("unansweredQuestions"),
  extractedDates: json("extractedDates"),
  followupTier: varchar("followupTier", { length: 16 }).default("none"),
  messageCount: int("messageCount").default(0),
  lastFrameworkUsed: varchar("lastFrameworkUsed", { length: 32 }),
  sentimentTrend: varchar("sentimentTrend", { length: 16 }),
  // Brain council tracking
  lastQcScore: int("lastQcScore"),
  lastStrategyApproach: varchar("lastStrategyApproach", { length: 32 }),
  lastResearchSummary: text("lastResearchSummary"),
  consecutiveRejects: int("consecutiveRejects").default(0), // QC rejections in a row
  lastInteractionSummary: text("lastInteractionSummary"), // 1-sentence summary of last Brain Council interaction for cross-session memory
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const pipelineEvents = mysqlTable("pipeline_events", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  fromStage: varchar("fromStage", { length: 64 }),
  toStage: varchar("toStage", { length: 64 }).notNull(),
  triggeredBy: mysqlEnum("triggeredBy", ["ai", "human", "webhook"]).notNull(),
  metadata: json("metadata"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

export const agentAssignments = mysqlTable("agent_assignments", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  agentName: varchar("agentName", { length: 128 }).notNull(),
  assignedAt: timestamp("assignedAt").defaultNow().notNull(),
  assignmentReason: text("assignmentReason"),
});

export const knowledgeFiles = mysqlTable("knowledge_files", {
  id: int("id").autoincrement().primaryKey(),
  fileName: varchar("fileName", { length: 255 }).notNull(),
  fileType: varchar("fileType", { length: 32 }).notNull(),
  fileUrl: text("fileUrl"),
  googleSheetUrl: text("googleSheetUrl"),
  contentText: text("contentText"),
  lastSyncedAt: timestamp("lastSyncedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const aiTweaks = mysqlTable("ai_tweaks", {
  id: int("id").autoincrement().primaryKey(),
  adminId: int("adminId"),
  tweakInstruction: text("tweakInstruction").notNull(),
  status: mysqlEnum("status", ["active", "archived"]).default("active").notNull(),
  appliedAt: timestamp("appliedAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Lead = typeof leads.$inferSelect;
export type InsertLead = typeof leads.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type AiState = typeof aiState.$inferSelect;
export type PipelineEvent = typeof pipelineEvents.$inferSelect;
export type AgentAssignment = typeof agentAssignments.$inferSelect;
export type KnowledgeFile = typeof knowledgeFiles.$inferSelect;
export const invites = mysqlTable("invites", {
  id: int("id").autoincrement().primaryKey(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  role: mysqlEnum("inviteRole", ["admin", "viewer"]).default("viewer").notNull(),
  createdBy: int("createdBy").notNull(),
  usedBy: int("usedBy"),
  usedAt: timestamp("usedAt"),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Webhook event log — tracks every incoming GHL webhook for diagnostics
export const webhookLogs = mysqlTable("webhook_logs", {
  id: int("id").autoincrement().primaryKey(),
  eventType: varchar("eventType", { length: 64 }), // contact, message, pipeline, task, unknown
  detectedType: varchar("detectedType", { length: 64 }), // what detectEventType returned
  contactId: varchar("contactId", { length: 128 }),
  leadId: int("leadId"),
  payloadSummary: text("payloadSummary"), // truncated JSON of key fields
  action: varchar("action", { length: 64 }), // what we did with it
  error: text("error"), // any error that occurred
  processingMs: int("processingMs"), // how long it took
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
});

// Brain Council audit log — full decision trail for every AI message
export const brainCouncilAudit = mysqlTable("brain_council_audit", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  leadName: varchar("leadName", { length: 255 }),
  channel: varchar("channel", { length: 32 }),
  incomingMessage: text("incomingMessage"), // what triggered the council
  // Strategist output
  strategyApproach: varchar("strategyApproach", { length: 64 }), // first_contact, follow_up, etc.
  strategyFramework: varchar("strategyFramework", { length: 64 }), // HORMOZI_ACA, etc.
  strategyReasoning: text("strategyReasoning"),
  strategyTier: varchar("strategyTier", { length: 32 }),
  // Researcher output
  researchSummary: text("researchSummary"),
  // Composer output
  composedMessage: text("composedMessage"),
  composerFromName: varchar("composerFromName", { length: 128 }),
  emailSubject: varchar("emailSubject", { length: 512 }), // email subject line (for subject-line performance tracking)
  // QC output
  qcScore: int("qcScore"),
  qcApproved: tinyint("qcApproved"),
  qcIssues: text("qcIssues"), // JSON array of issues
  qcFeedback: text("qcFeedback"),
  // Recompose (if QC rejected)
  wasRecomposed: tinyint("wasRecomposed").default(0),
  recomposeScore: int("recomposeScore"),
  finalMessage: text("finalMessage"), // the message that was actually sent
  // Outcome
  messageSent: tinyint("messageSent").default(0),
  sendError: text("sendError"),
  // Accountability
  blocked: tinyint("blocked").default(0), // 1 = message was blocked, never sent
  blockReason: text("blockReason"), // why it was blocked
  violationCategory: varchar("violationCategory", { length: 64 }), // irrelevant_research, form_data_ignored, wrong_business, generic_opener, missing_framework, safety_violation
  ownerNotified: tinyint("ownerNotified").default(0), // 1 = owner was notified about this violation
  fallbackUsed: tinyint("fallbackUsed").default(0), // 1 = safe fallback template was used instead
  fallbackMessage: text("fallbackMessage"), // the fallback message that was sent
  // Auto-correction
  correctionSent: tinyint("correctionSent").default(0), // 1 = apology + correct message was auto-sent
  correctionMessage: text("correctionMessage"), // the correction/apology message that was sent
  correctionReason: text("correctionReason"), // why correction was needed
  // Phase 4: Self-Learning metadata
  experimentId: varchar("experimentId", { length: 64 }),
  variant: varchar("variant", { length: 1 }),
  persona: varchar("persona", { length: 64 }),
  // Module 1: Conversation Stage Detection
  conversationStage: varchar("conversationStage", { length: 32 }),
  // Module 4: Multi-Agent Deliberation
  deliberationUsed: tinyint("deliberationUsed").default(0),
  deliberationNote: text("deliberationNote"),
  // Module 2B: Expert Panel Scoring
  expertPanelBrandScore: int("expertPanelBrandScore"),
  expertPanelConversionScore: int("expertPanelConversionScore"),
  expertPanelComplianceScore: int("expertPanelComplianceScore"),
  expertPanelCompositeScore: int("expertPanelCompositeScore"),
  expertPanelNotes: text("expertPanelNotes"),
  // Module 3A: Skill Catalog
  skillUsed: varchar("skillUsed", { length: 64 }),
  // Fine-tuning A/B tracking
  modelUsed: varchar("modelUsed", { length: 128 }),
  fineTuningJobId: int("fineTuningJobId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Self-learning: Outcome tracking — links each AI message to its measurable result
export const messageOutcomes = mysqlTable("message_outcomes", {
  id: int("id").autoincrement().primaryKey(),
  auditId: int("auditId").notNull(), // FK → brain_council_audit.id (legacy) or 0 for single-brain
  decisionLogId: bigint("decisionLogId", { mode: "number" }), // FK → decision_log.id (single brain)
  leadId: int("leadId").notNull(),
  // What the AI sent
  framework: varchar("framework", { length: 64 }),
  angle: varchar("angle", { length: 128 }),
  approach: varchar("approach", { length: 64 }),
  channel: varchar("channel", { length: 32 }),
  segment: varchar("segment", { length: 64 }),
  agentName: varchar("agentName", { length: 128 }),
  personalizationTier: int("personalizationTier"),
  // A/B experiment tracking
  experimentId: varchar("experimentId", { length: 64 }),
  variant: varchar("variant", { length: 1 }),
  // Persona tracking
  persona: varchar("persona", { length: 64 }),
  // Outcome signals
  gotReply: tinyint("gotReply").default(0), // 1 = lead replied within attribution window
  replyMinutes: int("replyMinutes"), // how fast they replied (null = no reply)
  replySentiment: varchar("replySentiment", { length: 16 }), // positive, neutral, negative
  stageAdvanced: tinyint("stageAdvanced").default(0), // 1 = pipeline moved forward after this message
  toStage: varchar("toStage", { length: 64 }), // which stage they moved to
  scoreChange: int("scoreChange"), // opportunity score delta
  converted: tinyint("converted").default(0), // 1 = reached Paid/Approved/Delivered
  dncTriggered: tinyint("dncTriggered").default(0), // 1 = lead replied with DNC keywords within attribution window
  // Email open tracking
  emailSubject: varchar("emailSubject", { length: 512 }), // subject line used (for A/B testing)
  emailOpened: tinyint("emailOpened").default(0), // 1 = email was opened
  emailOpenedAt: timestamp("emailOpenedAt"), // when the email was first opened
  // Metadata
  attributedAt: timestamp("attributedAt"), // when the outcome was recorded
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type MessageOutcome = typeof messageOutcomes.$inferSelect;
export type InsertMessageOutcome = typeof messageOutcomes.$inferInsert;

export type AiTweak = typeof aiTweaks.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type InsertInvite = typeof invites.$inferInsert;
export type WebhookLog = typeof webhookLogs.$inferSelect;
export type BrainCouncilAuditEntry = typeof brainCouncilAudit.$inferSelect;

// System settings — key-value store for global toggles (e.g., ai_online)
export const systemSettings = mysqlTable("system_settings", {
  id: int("id").autoincrement().primaryKey(),
  settingKey: varchar("key", { length: 64 }).notNull().unique(),
  settingValue: text("value").notNull(),
  updatedBy: varchar("updatedBy", { length: 128 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type SystemSetting = typeof systemSettings.$inferSelect;

// Learning Engine: Conversation-level outcome tracking (full journey per lead)
export const conversationOutcomes = mysqlTable("conversation_outcomes", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  ghlContactId: varchar("ghlContactId", { length: 100 }).notNull(),
  stateSequence: json("stateSequence").notNull(), // array of conv states traversed
  approachesUsed: json("approachesUsed").notNull(), // array of approach types used
  frameworksUsed: json("frameworksUsed"), // array of frameworks used
  outcome: varchar("outcome", { length: 20 }).notNull(), // won, lost, stale, dnc
  outcomeReason: varchar("outcomeReason", { length: 255 }), // e.g., "price_too_high", "no_reply_14d"
  messageCount: int("messageCount").notNull(),
  daysToOutcome: int("daysToOutcome").notNull(),
  channel: varchar("channel", { length: 20 }).notNull(),
  finalConvState: varchar("finalConvState", { length: 30 }),
  pipelineValue: int("pipelineValue").default(0),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
});

export type ConversationOutcome = typeof conversationOutcomes.$inferSelect;
export type InsertConversationOutcome = typeof conversationOutcomes.$inferInsert;

// Learning Engine: Pattern-level learnings with recurrence tracking
export const learnings = mysqlTable("learnings", {
  id: int("id").autoincrement().primaryKey(),
  patternKey: varchar("patternKey", { length: 100 }).notNull().unique(),
  category: varchar("category", { length: 30 }).notNull(), // best_practice, avoid, correction, knowledge_gap
  description: text("description").notNull(),
  details: text("details"), // extended context, examples
  suggestedAction: text("suggestedAction"), // what to do when this pattern is detected
  recurrenceCount: int("recurrenceCount").default(1),
  positiveOutcomes: int("positiveOutcomes").default(0),
  negativeOutcomes: int("negativeOutcomes").default(0),
  promotedToPrompt: tinyint("promotedToPrompt").default(0), // 1 = auto-promoted to Strategist
  promotedAt: bigint("promotedAt", { mode: "number" }),
  priority: varchar("priority", { length: 10 }).default("medium"), // low, medium, high, critical
  source: varchar("source", { length: 30 }).default("auto"), // auto, manual, error_memory
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});

export type Learning = typeof learnings.$inferSelect;
export type InsertLearning = typeof learnings.$inferInsert;

// Learning Engine: Error memory — tracks system errors and known fixes
export const errorMemory = mysqlTable("error_memory", {
  id: int("id").autoincrement().primaryKey(),
  errorSignature: varchar("errorSignature", { length: 150 }).notNull().unique(), // hash of error type + context
  errorType: varchar("errorType", { length: 50 }).notNull(), // ghl_api, llm_hallucination, channel_mismatch, etc.
  errorMessage: text("errorMessage").notNull(),
  rootCause: text("rootCause"),
  knownFix: text("knownFix"), // description of the fix
  fixApplied: tinyint("fixApplied").default(0), // 1 = fix was auto-applied
  occurrenceCount: int("occurrenceCount").default(1),
  lastOccurredAt: bigint("lastOccurredAt", { mode: "number" }).notNull(),
  prevention: text("prevention"), // how to prevent this in the future
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});

export type ErrorMemoryEntry = typeof errorMemory.$inferSelect;
export type InsertErrorMemoryEntry = typeof errorMemory.$inferInsert;
// Supervisor: Audit log for invariant violations and auto-corrections
export const supervisorAudit = mysqlTable("supervisor_audit", {
  id: int("id").autoincrement().primaryKey(),
  cycleId: varchar("cycleId", { length: 64 }).notNull(),
  invariant: varchar("invariant", { length: 64 }).notNull(),
  leadId: int("leadId"),
  violation: text("violation").notNull(),
  correction: text("correction"),
  success: tinyint("success").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ============================================================
// PHASE 4: SELF-LEARNING LOOP
// ============================================================

// A/B Experiments — controlled tests of message variants
export const abExperiments = mysqlTable("ab_experiments", {
  id: int("id").autoincrement().primaryKey(),
  experimentId: varchar("experimentId", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  hypothesis: text("hypothesis").notNull(),
  variantADescription: text("variantADescription").notNull(),
  variantBDescription: text("variantBDescription").notNull(),
  variantAConfig: json("variantAConfig").notNull(),
  variantBConfig: json("variantBConfig").notNull(),
  targetSegment: varchar("targetSegment", { length: 64 }),
  targetChannel: varchar("targetChannel", { length: 32 }),
  targetApproach: varchar("targetApproach", { length: 64 }),
  primaryMetric: varchar("primaryMetric", { length: 32 }).notNull().default("reply_rate"),
  sampleSizeTarget: int("sampleSizeTarget").notNull().default(50),
  confidenceThreshold: int("confidenceThreshold").notNull().default(95),
  variantASamples: int("variantASamples").default(0),
  variantBSamples: int("variantBSamples").default(0),
  variantASuccesses: int("variantASuccesses").default(0),
  variantBSuccesses: int("variantBSuccesses").default(0),
  winnerVariant: varchar("winnerVariant", { length: 1 }),
  pValue: varchar("pValue", { length: 16 }),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  autoAdopt: tinyint("autoAdopt").default(1),
  adoptedAt: timestamp("adoptedAt"),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  endedAt: timestamp("endedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AbExperiment = typeof abExperiments.$inferSelect;
export type InsertAbExperiment = typeof abExperiments.$inferInsert;

// A/B Assignments — which variant each lead is assigned to
export const abAssignments = mysqlTable("ab_assignments", {
  id: int("id").autoincrement().primaryKey(),
  experimentId: varchar("experimentId", { length: 64 }).notNull(),
  leadId: int("leadId").notNull(),
  variant: varchar("variant", { length: 1 }).notNull(),
  assignedAt: timestamp("assignedAt").defaultNow().notNull(),
});

export type AbAssignment = typeof abAssignments.$inferSelect;
export type InsertAbAssignment = typeof abAssignments.$inferInsert;

// Daily Performance Snapshots — time-series outcome tracking
export const dailySnapshots = mysqlTable("daily_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  snapshotDate: varchar("snapshotDate", { length: 10 }).notNull(),
  messagesSent: int("messagesSent").default(0),
  repliesReceived: int("repliesReceived").default(0),
  replyRate: int("replyRate").default(0),
  positiveRate: int("positiveRate").default(0),
  conversionRate: int("conversionRate").default(0),
  dncRate: int("dncRate").default(0),
  avgReplyMinutes: int("avgReplyMinutes").default(0),
  frameworkBreakdown: json("frameworkBreakdown"),
  channelBreakdown: json("channelBreakdown"),
  personaBreakdown: json("personaBreakdown"),
  experimentBreakdown: json("experimentBreakdown"),
  stageAdvances: int("stageAdvances").default(0),
  leadsWon: int("leadsWon").default(0),
  leadsLost: int("leadsLost").default(0),
  pipelineValueAdded: int("pipelineValueAdded").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DailySnapshot = typeof dailySnapshots.$inferSelect;
export type InsertDailySnapshot = typeof dailySnapshots.$inferInsert;

// ============================================================
// HALL OF FAME — Winning messages that got replies / conversions
// ============================================================
export const hallOfFame = mysqlTable("hall_of_fame", {
  id: int("id").autoincrement().primaryKey(),
  auditId: int("auditId").notNull(), // FK → brain_council_audit.id
  leadId: int("leadId").notNull(),
  message: text("message").notNull(),
  framework: varchar("framework", { length: 64 }).notNull(),
  approach: varchar("approach", { length: 64 }),
  channel: varchar("channel", { length: 32 }),
  segment: varchar("segment", { length: 64 }),
  persona: varchar("persona", { length: 64 }),
  replyMinutes: int("replyMinutes"), // how fast the lead replied
  replySentiment: varchar("replySentiment", { length: 16 }), // positive, neutral
  stageAdvanced: tinyint("stageAdvanced").default(0),
  converted: tinyint("converted").default(0),
  pipelineValue: int("pipelineValue").default(0),
  // Why it was promoted
  promotionReason: varchar("promotionReason", { length: 128 }).notNull(), // fast_reply, positive_reply, conversion, stage_advance
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type HallOfFameEntry = typeof hallOfFame.$inferSelect;
export type InsertHallOfFameEntry = typeof hallOfFame.$inferInsert;

// ============================================================
// CHANNEL PERFORMANCE — Per-lead channel success tracking
// ============================================================
export const channelPerformance = mysqlTable("channel_performance", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  channel: varchar("channel", { length: 32 }).notNull(),
  messagesSent: int("messagesSent").default(0),
  repliesReceived: int("repliesReceived").default(0),
  avgReplyMinutes: int("avgReplyMinutes"), // average reply speed
  positiveReplies: int("positiveReplies").default(0),
  stageAdvances: int("stageAdvances").default(0),
  lastSentAt: timestamp("lastSentAt"),
  lastReplyAt: timestamp("lastReplyAt"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ChannelPerformanceEntry = typeof channelPerformance.$inferSelect;
export type InsertChannelPerformanceEntry = typeof channelPerformance.$inferInsert;

// ============================================================
// SEASONAL CAMPAIGNS — Admin-triggered bulk push campaigns
// ============================================================
export const seasonalCampaigns = mysqlTable("seasonal_campaigns", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  angle: text("angle").notNull(), // the messaging angle for this campaign
  targetSegments: json("targetSegments"), // array of segment strings, or ["all"]
  startDate: timestamp("startDate").notNull(),
  endDate: timestamp("endDate").notNull(),
  maxLeadsPerDay: int("maxLeadsPerDay").default(50),
  totalSent: int("totalSent").default(0),
  totalReplies: int("totalReplies").default(0),
  status: varchar("status", { length: 16 }).default("draft").notNull(), // draft, active, paused, completed
  createdBy: int("createdBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type SeasonalCampaign = typeof seasonalCampaigns.$inferSelect;
export type InsertSeasonalCampaign = typeof seasonalCampaigns.$inferInsert;

// ============================================================
// POST-DELIVERY SEQUENCES — Multi-step follow-up after fulfillment
// ============================================================
export const postDeliverySequences = mysqlTable("post_delivery_sequences", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  step: int("step").notNull().default(1), // 1=satisfaction, 2=review request, 3=upsell
  stepType: varchar("stepType", { length: 32 }).default("satisfaction_check").notNull(), // satisfaction_check, review_request, upsell_referral
  scheduledAt: timestamp("scheduledAt").notNull(),
  sentAt: timestamp("sentAt"),
  status: varchar("status", { length: 16 }).default("pending").notNull(), // pending, sent, skipped, replied
  channel: varchar("channel", { length: 32 }),
  auditId: int("auditId"), // FK → brain_council_audit.id (when sent)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PostDeliverySequence = typeof postDeliverySequences.$inferSelect;
export type InsertPostDeliverySequence = typeof postDeliverySequences.$inferInsert;

// ============================================================
// DEFERRED RESPONSES — Agent-first delay for new leads during business hours
// ============================================================
export const deferredResponses = mysqlTable("deferred_responses", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  ghlContactId: varchar("ghlContactId", { length: 128 }).notNull(),
  channel: varchar("channel", { length: 32 }).notNull(), // SMS, Email, FB, etc.
  messageBody: text("messageBody").notNull(),
  emailSubject: varchar("emailSubject", { length: 512 }),
  emailHtml: text("emailHtml"),
  fromName: varchar("fromName", { length: 128 }),
  sendAt: timestamp("sendAt").notNull(), // When the AI should send if no agent responds
  status: varchar("status", { length: 16 }).default("pending").notNull(), // pending, sent, cancelled
  cancelReason: varchar("cancelReason", { length: 128 }), // agent_responded, humanTakeover, etc.
  brainCouncilOutput: json("brainCouncilOutput"), // Full BC output for post-send processing
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  processedAt: timestamp("processedAt"),
});
export type DeferredResponse = typeof deferredResponses.$inferSelect;
export type InsertDeferredResponse = typeof deferredResponses.$inferInsert;

// ============================================================
// LEAD MEMORY — Module 5B: Continuous Private Memory per lead
// ============================================================
export const leadMemory = mysqlTable("lead_memory", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  factKey: varchar("factKey", { length: 128 }).notNull(), // e.g., "prefers_email", "budget_signal", "event_date"
  factValue: text("factValue").notNull(),                 // e.g., "prefers email over SMS", "$300 budget mentioned"
  confidence: varchar("confidence", { length: 16 }).default("medium").notNull(), // high, medium, low
  source: varchar("source", { length: 32 }).default("brain_council").notNull(),  // brain_council, manual
  learnedAt: bigint("learnedAt", { mode: "number" }).notNull(),
  lastConfirmedAt: bigint("lastConfirmedAt", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type LeadMemoryEntry = typeof leadMemory.$inferSelect;
export type InsertLeadMemoryEntry = typeof leadMemory.$inferInsert;

// ============================================================
// SKILL PROPOSALS — Module 3B: Auto-Skill Hunter proposals
// ============================================================
export const skillProposals = mysqlTable("skill_proposals", {
  id: int("id").autoincrement().primaryKey(),
  violationCategory: varchar("violationCategory", { length: 64 }).notNull(),
  occurrenceCount: int("occurrenceCount").default(0).notNull(),
  proposedSkillId: varchar("proposedSkillId", { length: 64 }).notNull(), // e.g., "church_pricing_objection"
  proposedSkillName: varchar("proposedSkillName", { length: 128 }).notNull(),
  proposedPrompt: text("proposedPrompt").notNull(),
  triggerConditions: json("triggerConditions"),  // { segment?, approach?, conversationStage? }
  exampleMessages: json("exampleMessages"),       // array of 2-3 example outputs
  status: varchar("status", { length: 16 }).default("pending_review").notNull(), // pending_review, approved, rejected
  reviewedAt: timestamp("reviewedAt"),
  reviewNote: text("reviewNote"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type SkillProposal = typeof skillProposals.$inferSelect;
export type InsertSkillProposal = typeof skillProposals.$inferInsert;


// ============================================================
// STRATEGY ADJUSTMENTS — Autonomous strategy review log (Decision 11)
// ============================================================
export const strategyAdjustments = mysqlTable("strategy_adjustments", {
  id: int("id").autoincrement().primaryKey(),
  weekId: varchar("weekId", { length: 16 }).notNull(), // ISO week e.g. "2025-W18"
  triggerMetric: varchar("triggerMetric", { length: 64 }).notNull(), // e.g. "replyRate_declining"
  currentValue: varchar("currentValue", { length: 32 }),
  previousValue: varchar("previousValue", { length: 32 }),
  adjustment: text("adjustment").notNull(), // LLM-generated strategy adjustment
  appliedTo: varchar("appliedTo", { length: 64 }), // e.g. "strategist_prompt", "channel_weights"
  status: varchar("status", { length: 16 }).default("proposed").notNull(), // proposed, applied, rejected, expired
  appliedAt: timestamp("appliedAt"),
  expiresAt: timestamp("expiresAt"), // auto-expire after 7 days
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type StrategyAdjustment = typeof strategyAdjustments.$inferSelect;
export type InsertStrategyAdjustment = typeof strategyAdjustments.$inferInsert;

// ============================================================
// TRAINING EXPORTS — LoRA fine-tuning data export tracking (Decision 9)
// ============================================================
export const trainingExports = mysqlTable("training_exports", {
  id: int("id").autoincrement().primaryKey(),
  exportName: varchar("exportName", { length: 128 }).notNull(),
  format: varchar("format", { length: 16 }).default("jsonl").notNull(), // jsonl, csv
  totalPairs: int("totalPairs").default(0).notNull(),
  filterCriteria: json("filterCriteria"), // { minScore?, frameworks?, channels?, dateRange? }
  fileUrl: text("fileUrl"), // S3 URL of the exported file
  fileKey: text("fileKey"), // S3 key
  status: varchar("status", { length: 16 }).default("pending").notNull(), // pending, generating, completed, failed
  generatedAt: timestamp("generatedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type TrainingExport = typeof trainingExports.$inferSelect;
export type InsertTrainingExport = typeof trainingExports.$inferInsert;

// ============================================================
// FINE-TUNING JOBS — OpenAI LoRA training job tracking
// ============================================================
export const fineTuningJobs = mysqlTable("fine_tuning_jobs", {
  id: int("id").autoincrement().primaryKey(),
  openaiJobId: varchar("openaiJobId", { length: 64 }), // ft-xxx from OpenAI
  openaiFileId: varchar("openaiFileId", { length: 64 }), // file-xxx from OpenAI
  baseModel: varchar("baseModel", { length: 64 }).default("gpt-4.1-mini-2025-04-14").notNull(),
  fineTunedModel: varchar("fineTunedModel", { length: 128 }), // ft:gpt-4.1-mini:org:suffix
  trainingExportId: int("trainingExportId"), // FK to training_exports
  trainingPairs: int("trainingPairs").default(0).notNull(),
  epochs: int("epochs").default(3).notNull(),
  status: varchar("status", { length: 24 }).default("pending").notNull(), // pending, uploading, training, succeeded, failed, cancelled
  abTestActive: tinyint("abTestActive").default(0).notNull(), // 1 = currently being A/B tested
  abTrafficPercent: int("abTrafficPercent").default(20).notNull(), // % of traffic routed to fine-tuned model
  abStartedAt: timestamp("abStartedAt"),
  abWins: int("abWins").default(0).notNull(), // messages with positive outcome from fine-tuned
  abLosses: int("abLosses").default(0).notNull(), // messages with negative outcome from fine-tuned
  baseWins: int("baseWins").default(0).notNull(), // messages with positive outcome from base
  baseLosses: int("baseLosses").default(0).notNull(), // messages with negative outcome from base
  promoted: tinyint("promoted").default(0).notNull(), // 1 = promoted to production
  promotedAt: timestamp("promotedAt"),
  error: text("error"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
});
export type FineTuningJob = typeof fineTuningJobs.$inferSelect;
export type InsertFineTuningJob = typeof fineTuningJobs.$inferInsert;

// ─── Phase 1: Outbox (single message queue) ──────────────────────────────────
export const outbox = mysqlTable("outbox", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  idemKey: varchar("idemKey", { length: 64 }).notNull(),
  source: mysqlEnum("source", ["webhook", "responder", "follow_up", "manual", "nurture", "correction", "first_contact", "self_review", "fast_scan", "deferred"]).notNull(),
  payload: json("payload").notNull(), // { trigger, channelHint, draftMessage?, systemLeakRetry?, ... }
  status: mysqlEnum("outbox_status", ["pending", "claimed", "sent", "failed", "skipped"]).default("pending").notNull(),
  claimedBy: varchar("claimedBy", { length: 64 }),
  claimedAt: timestamp("claimedAt"),
  scheduledAt: timestamp("scheduledAt").notNull(),
  sentAt: timestamp("sentAt"),
  error: text("error"),
  retryCount: int("retryCount").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type OutboxRow = typeof outbox.$inferSelect;
export type InsertOutboxRow = typeof outbox.$inferInsert;

// ─── Phase 1: Decision Log (audit trail for every outbox decision) ───────────
export const decisionLog = mysqlTable("decision_log", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  outboxId: bigint("outboxId", { mode: "number" }),
  leadId: int("leadId").notNull(),
  trigger: varchar("trigger", { length: 64 }).notNull(), // inbound_reply, proactive_follow_up, first_contact, nurture, correction
  brainReasoning: text("brainReasoning"), // LLM reasoning / draft message
  promptVersion: varchar("promptVersion", { length: 20 }),
  channel: varchar("channel", { length: 32 }),
  inputGuardResult: varchar("inputGuardResult", { length: 32 }), // pass, block:reason, defer:reason
  outputGuardResult: varchar("outputGuardResult", { length: 255 }), // pass, block:reason, error:message
  durationMs: int("durationMs"), // total processing time
  flaggedForReview: tinyint("flaggedForReview").default(0), // 1 = flagged for human review
  flagReason: varchar("flagReason", { length: 255 }), // why it was flagged
  flagAcknowledged: tinyint("flagAcknowledged").default(0), // 1 = reviewed/dismissed by human
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type DecisionLogRow = typeof decisionLog.$inferSelect;
export type InsertDecisionLogRow = typeof decisionLog.$inferInsert;

// ─── Phase 2: Prompt Versions (track every system prompt iteration) ───────────
export const promptVersions = mysqlTable("prompt_versions", {
  id: int("id").autoincrement().primaryKey(),
  version: varchar("version", { length: 20 }).notNull().unique(), // e.g. "v2.0", "v2.1"
  systemPromptHash: varchar("systemPromptHash", { length: 64 }).notNull(), // SHA-256 of the full system prompt
  description: text("description"), // human-readable changelog
  abTrafficPercent: int("abTrafficPercent").default(0), // 0-100, % of traffic routed to this version
  isActive: tinyint("isActive").default(1), // 1 = active, 0 = retired
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PromptVersionRow = typeof promptVersions.$inferSelect;
export type InsertPromptVersionRow = typeof promptVersions.$inferInsert;

// ─── Phase 4: Quotes (persist getQuote results for tracking + follow-up) ──────
export const quotes = mysqlTable("quotes", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  product: varchar("product", { length: 128 }).notNull(), // product key e.g. "tshirt_gildan_3000"
  productName: varchar("productName", { length: 255 }).notNull(), // human-readable name
  qty: int("qty").notNull(),
  sides: int("sides").notNull(), // 1 or 2
  perUnit: int("perUnit"), // cents (null if callForQuote)
  perUnitRangeLow: int("perUnitRangeLow"), // cents (for range products)
  perUnitRangeHigh: int("perUnitRangeHigh"), // cents (for range products)
  subtotal: int("subtotal"), // cents
  rushFee: int("rushFee"), // cents
  setupFee: int("setupFee").default(0), // cents
  total: int("total"), // cents (null if callForQuote)
  rush: tinyint("rush").default(0), // 1 = rush order
  status: mysqlEnum("status", ["sent", "approved", "declined", "expired", "call_for_quote"]).default("sent").notNull(),
  breakdown: text("breakdown"), // human-readable pricing breakdown
  callForQuote: tinyint("callForQuote").default(0), // 1 = needs manual quote
  sentAt: timestamp("sentAt").defaultNow().notNull(),
  expiresAt: timestamp("expiresAt"), // quote validity window
  approvedAt: timestamp("approvedAt"),
  declinedAt: timestamp("declinedAt"),
  decisionLogId: int("decisionLogId"), // link back to the AI decision that generated this quote
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type QuoteRow = typeof quotes.$inferSelect;
export type InsertQuoteRow = typeof quotes.$inferInsert;

// ─── Phase 5: Segment Weights (adaptive learning from outcome data) ───────────
export const segmentWeights = mysqlTable("segment_weights", {
  id: int("id").autoincrement().primaryKey(),
  segment: varchar("segment", { length: 64 }).notNull(), // persona segment e.g. "small_business_owner"
  channel: varchar("channel", { length: 32 }).notNull(), // SMS, Email, FB, IG
  stage: varchar("stage", { length: 64 }).notNull(), // pipeline stage
  approach: varchar("approach", { length: 255 }).notNull(), // approach label e.g. "direct_cta", "social_proof"
  wins: int("wins").default(0).notNull(),
  losses: int("losses").default(0).notNull(),
  winRate: decimal("winRate", { precision: 5, scale: 4 }).default("0.0000").notNull(), // 0.0000 - 1.0000
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  uniqueCombo: uniqueIndex("uq_segment_channel_stage_approach").on(table.segment, table.channel, table.stage, table.approach),
}));
export type SegmentWeightRow = typeof segmentWeights.$inferSelect;
export type InsertSegmentWeightRow = typeof segmentWeights.$inferInsert;

// Foundation A: send_attempts table for audit-logging non-delivered send attempts.
// See ARCHITECTURAL_DEBT_INVENTORY_2026-05-18.md Section 2 item 2.
export const sendAttempts = mysqlTable("send_attempts", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  leadId: int("leadId").notNull(),
  channel: varchar("channel", { length: 32 }).notNull(),
  outcomeKind: varchar("outcomeKind", { length: 32 }).notNull(), // 'phantom' | 'failed' | 'blocked'
  reason: text("reason").notNull(),
  errorType: varchar("errorType", { length: 64 }),
  attemptedAt: timestamp("attemptedAt").notNull().defaultNow(),
  trigger: varchar("trigger", { length: 64 }).notNull(),
  payload: text("payload"), // JSON string with request/response/error details
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});
export type SendAttemptRow = typeof sendAttempts.$inferSelect;
export type InsertSendAttemptRow = typeof sendAttempts.$inferInsert;

// Foundation D: compose lock table for multi-fire deduplication
export const composeLocks = mysqlTable("compose_locks", {
  id:        bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  leadId:    int("leadId").notNull(),
  eventKey:  varchar("eventKey", { length: 64 }).notNull(),
  source:    varchar("source", { length: 50 }).notNull(),
  lockedAt:  datetime("lockedAt", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  expiresAt: datetime("expiresAt", { fsp: 3 }).notNull(),
}, (t) => ({
  uqLock:    uniqueIndex("uq_compose_lock").on(t.leadId, t.eventKey),
  idxExpiry: index("idx_compose_expires").on(t.expiresAt),
}));

export type ComposeLock = typeof composeLocks.$inferSelect;
