import { int, bigint, mysqlEnum, mysqlTable, text, timestamp, varchar, json, tinyint } from "drizzle-orm/mysql-core";

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
  // Agent notes (from GHL note events — latest agent note for context)
  lastAgentNote: text("lastAgentNote"),
  lastAgentNoteAt: timestamp("lastAgentNoteAt"),
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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Self-learning: Outcome tracking — links each AI message to its measurable result
export const messageOutcomes = mysqlTable("message_outcomes", {
  id: int("id").autoincrement().primaryKey(),
  auditId: int("auditId").notNull(), // FK → brain_council_audit.id
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
