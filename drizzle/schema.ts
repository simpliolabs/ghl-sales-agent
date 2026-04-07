import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, json, tinyint } from "drizzle-orm/mysql-core";

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
  // Outcome signals
  gotReply: tinyint("gotReply").default(0), // 1 = lead replied within attribution window
  replyMinutes: int("replyMinutes"), // how fast they replied (null = no reply)
  replySentiment: varchar("replySentiment", { length: 16 }), // positive, neutral, negative
  stageAdvanced: tinyint("stageAdvanced").default(0), // 1 = pipeline moved forward after this message
  toStage: varchar("toStage", { length: 64 }), // which stage they moved to
  scoreChange: int("scoreChange"), // opportunity score delta
  converted: tinyint("converted").default(0), // 1 = reached Paid/Approved/Delivered
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