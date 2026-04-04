import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, json, tinyint } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const leads = mysqlTable("leads", {
  id: int("id").autoincrement().primaryKey(),
  ghlContactId: varchar("ghlContactId", { length: 128 }).unique(),
  ghlOpportunityId: varchar("ghlOpportunityId", { length: 128 }),
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
  lastAngleUsed: varchar("lastAngleUsed", { length: 128 }),
  objectionsRaised: json("objectionsRaised"),
  interestSignals: json("interestSignals"),
  unansweredQuestions: json("unansweredQuestions"),
  extractedDates: json("extractedDates"),
  followupTier: varchar("followupTier", { length: 16 }).default("none"),
  messageCount: int("messageCount").default(0),
  lastFrameworkUsed: varchar("lastFrameworkUsed", { length: 32 }),
  sentimentTrend: varchar("sentimentTrend", { length: 16 }),
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
export type AiTweak = typeof aiTweaks.$inferSelect;