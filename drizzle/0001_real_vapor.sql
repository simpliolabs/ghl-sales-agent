CREATE TABLE `agent_assignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`agentName` varchar(128) NOT NULL,
	`assignedAt` timestamp NOT NULL DEFAULT (now()),
	`assignmentReason` text,
	CONSTRAINT `agent_assignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_state` (
	`id` int AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`lastAngleUsed` varchar(128),
	`objectionsRaised` json,
	`interestSignals` json,
	`unansweredQuestions` json,
	`extractedDates` json,
	`followupTier` varchar(16) DEFAULT 'none',
	`messageCount` int DEFAULT 0,
	`lastFrameworkUsed` varchar(32),
	`sentimentTrend` varchar(16),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ai_state_id` PRIMARY KEY(`id`),
	CONSTRAINT `ai_state_leadId_unique` UNIQUE(`leadId`)
);
--> statement-breakpoint
CREATE TABLE `ai_tweaks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`adminId` int,
	`tweakInstruction` text NOT NULL,
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`appliedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ai_tweaks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`channel` varchar(32),
	`direction` enum('inbound','outbound') NOT NULL,
	`messageBody` text,
	`senderType` enum('ai','human','lead') NOT NULL,
	`senderName` varchar(128),
	`ghlMessageId` varchar(128),
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_files` (
	`id` int AUTO_INCREMENT NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`fileType` varchar(32) NOT NULL,
	`fileUrl` text,
	`googleSheetUrl` text,
	`contentText` text,
	`lastSyncedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `knowledge_files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ghlContactId` varchar(128),
	`ghlOpportunityId` varchar(128),
	`name` varchar(255),
	`email` varchar(320),
	`phone` varchar(32),
	`businessName` varchar(255),
	`website` varchar(512),
	`source` varchar(64),
	`researchData` json,
	`omnisendSegment` varchar(64),
	`opportunityScore` int DEFAULT 0,
	`assignedAgent` varchar(128),
	`pipelineStage` varchar(64) DEFAULT 'new_lead',
	`opportunityValue` varchar(32) DEFAULT '0',
	`lastMessageAt` timestamp,
	`nextFollowUpAt` timestamp,
	`contextDates` json,
	`humanTakeover` tinyint DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `leads_id` PRIMARY KEY(`id`),
	CONSTRAINT `leads_ghlContactId_unique` UNIQUE(`ghlContactId`)
);
--> statement-breakpoint
CREATE TABLE `pipeline_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`fromStage` varchar(64),
	`toStage` varchar(64) NOT NULL,
	`triggeredBy` enum('ai','human','webhook') NOT NULL,
	`metadata` json,
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pipeline_events_id` PRIMARY KEY(`id`)
);
