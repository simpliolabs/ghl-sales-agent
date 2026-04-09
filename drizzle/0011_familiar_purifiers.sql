CREATE TABLE `ab_assignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`experimentId` varchar(64) NOT NULL,
	`leadId` int NOT NULL,
	`variant` varchar(1) NOT NULL,
	`assignedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ab_assignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ab_experiments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`experimentId` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`hypothesis` text NOT NULL,
	`variantADescription` text NOT NULL,
	`variantBDescription` text NOT NULL,
	`variantAConfig` json NOT NULL,
	`variantBConfig` json NOT NULL,
	`targetSegment` varchar(64),
	`targetChannel` varchar(32),
	`targetApproach` varchar(64),
	`primaryMetric` varchar(32) NOT NULL DEFAULT 'reply_rate',
	`sampleSizeTarget` int NOT NULL DEFAULT 50,
	`confidenceThreshold` int NOT NULL DEFAULT 95,
	`variantASamples` int DEFAULT 0,
	`variantBSamples` int DEFAULT 0,
	`variantASuccesses` int DEFAULT 0,
	`variantBSuccesses` int DEFAULT 0,
	`winnerVariant` varchar(1),
	`pValue` varchar(16),
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`autoAdopt` tinyint DEFAULT 1,
	`adoptedAt` timestamp,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`endedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ab_experiments_id` PRIMARY KEY(`id`),
	CONSTRAINT `ab_experiments_experimentId_unique` UNIQUE(`experimentId`)
);
--> statement-breakpoint
CREATE TABLE `conversation_outcomes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`ghlContactId` varchar(100) NOT NULL,
	`stateSequence` json NOT NULL,
	`approachesUsed` json NOT NULL,
	`frameworksUsed` json,
	`outcome` varchar(20) NOT NULL,
	`outcomeReason` varchar(255),
	`messageCount` int NOT NULL,
	`daysToOutcome` int NOT NULL,
	`channel` varchar(20) NOT NULL,
	`finalConvState` varchar(30),
	`pipelineValue` int DEFAULT 0,
	`createdAt` bigint NOT NULL,
	CONSTRAINT `conversation_outcomes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `daily_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`snapshotDate` varchar(10) NOT NULL,
	`messagesSent` int DEFAULT 0,
	`repliesReceived` int DEFAULT 0,
	`replyRate` int DEFAULT 0,
	`positiveRate` int DEFAULT 0,
	`conversionRate` int DEFAULT 0,
	`dncRate` int DEFAULT 0,
	`avgReplyMinutes` int DEFAULT 0,
	`frameworkBreakdown` json,
	`channelBreakdown` json,
	`personaBreakdown` json,
	`experimentBreakdown` json,
	`stageAdvances` int DEFAULT 0,
	`leadsWon` int DEFAULT 0,
	`leadsLost` int DEFAULT 0,
	`pipelineValueAdded` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `daily_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `error_memory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`errorSignature` varchar(150) NOT NULL,
	`errorType` varchar(50) NOT NULL,
	`errorMessage` text NOT NULL,
	`rootCause` text,
	`knownFix` text,
	`fixApplied` tinyint DEFAULT 0,
	`occurrenceCount` int DEFAULT 1,
	`lastOccurredAt` bigint NOT NULL,
	`prevention` text,
	`createdAt` bigint NOT NULL,
	`updatedAt` bigint NOT NULL,
	CONSTRAINT `error_memory_id` PRIMARY KEY(`id`),
	CONSTRAINT `error_memory_errorSignature_unique` UNIQUE(`errorSignature`)
);
--> statement-breakpoint
CREATE TABLE `learnings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`patternKey` varchar(100) NOT NULL,
	`category` varchar(30) NOT NULL,
	`description` text NOT NULL,
	`details` text,
	`suggestedAction` text,
	`recurrenceCount` int DEFAULT 1,
	`positiveOutcomes` int DEFAULT 0,
	`negativeOutcomes` int DEFAULT 0,
	`promotedToPrompt` tinyint DEFAULT 0,
	`promotedAt` bigint,
	`priority` varchar(10) DEFAULT 'medium',
	`source` varchar(30) DEFAULT 'auto',
	`createdAt` bigint NOT NULL,
	`updatedAt` bigint NOT NULL,
	CONSTRAINT `learnings_id` PRIMARY KEY(`id`),
	CONSTRAINT `learnings_patternKey_unique` UNIQUE(`patternKey`)
);
--> statement-breakpoint
CREATE TABLE `supervisor_audit` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cycleId` varchar(64) NOT NULL,
	`invariant` varchar(64) NOT NULL,
	`leadId` int,
	`violation` text NOT NULL,
	`correction` text,
	`success` tinyint DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `supervisor_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `system_settings` DROP INDEX `system_settings_settingKey_unique`;--> statement-breakpoint
ALTER TABLE `ai_state` ADD `lastInteractionSummary` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `lastAiSendAttemptAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `dndSms` varchar(32);--> statement-breakpoint
ALTER TABLE `leads` ADD `dndEmail` varchar(32);--> statement-breakpoint
ALTER TABLE `leads` ADD `dndFb` varchar(32);--> statement-breakpoint
ALTER TABLE `leads` ADD `dndWhatsapp` varchar(32);--> statement-breakpoint
ALTER TABLE `leads` ADD `dndGmb` varchar(32);--> statement-breakpoint
ALTER TABLE `leads` ADD `dndSyncedAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `emailOpens` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `leads` ADD `emailClicks` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `leads` ADD `emailBounces` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `leads` ADD `emailUnsubscribed` tinyint DEFAULT 0;--> statement-breakpoint
ALTER TABLE `leads` ADD `lastEmailOpenAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `lastEmailClickAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `nextAppointmentAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `appointmentStatus` varchar(32);--> statement-breakpoint
ALTER TABLE `leads` ADD `appointmentId` varchar(128);--> statement-breakpoint
ALTER TABLE `leads` ADD `lastAgentNote` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `lastAgentNoteAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `convState` varchar(20) DEFAULT 'new_lead';--> statement-breakpoint
ALTER TABLE `leads` ADD `convStateUpdatedAt` bigint;--> statement-breakpoint
ALTER TABLE `leads` ADD `intentHistory` json;--> statement-breakpoint
ALTER TABLE `message_outcomes` ADD `experimentId` varchar(64);--> statement-breakpoint
ALTER TABLE `message_outcomes` ADD `variant` varchar(1);--> statement-breakpoint
ALTER TABLE `message_outcomes` ADD `persona` varchar(64);--> statement-breakpoint
ALTER TABLE `message_outcomes` ADD `dncTriggered` tinyint DEFAULT 0;--> statement-breakpoint
ALTER TABLE `system_settings` ADD `key` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `system_settings` ADD `value` text NOT NULL;--> statement-breakpoint
ALTER TABLE `system_settings` ADD CONSTRAINT `system_settings_key_unique` UNIQUE(`key`);--> statement-breakpoint
ALTER TABLE `system_settings` DROP COLUMN `settingKey`;--> statement-breakpoint
ALTER TABLE `system_settings` DROP COLUMN `settingValue`;