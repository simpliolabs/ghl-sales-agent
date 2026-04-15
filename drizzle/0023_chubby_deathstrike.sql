CREATE TABLE `lead_memory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`factKey` varchar(128) NOT NULL,
	`factValue` text NOT NULL,
	`confidence` varchar(16) NOT NULL DEFAULT 'medium',
	`source` varchar(32) NOT NULL DEFAULT 'brain_council',
	`learnedAt` bigint NOT NULL,
	`lastConfirmedAt` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `lead_memory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `skill_proposals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`violationCategory` varchar(64) NOT NULL,
	`occurrenceCount` int NOT NULL DEFAULT 0,
	`proposedSkillId` varchar(64) NOT NULL,
	`proposedSkillName` varchar(128) NOT NULL,
	`proposedPrompt` text NOT NULL,
	`triggerConditions` json,
	`exampleMessages` json,
	`status` varchar(16) NOT NULL DEFAULT 'pending_review',
	`reviewedAt` timestamp,
	`reviewNote` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `skill_proposals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `expertPanelBrandScore` int;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `expertPanelConversionScore` int;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `expertPanelComplianceScore` int;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `expertPanelCompositeScore` int;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `expertPanelNotes` text;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `skillUsed` varchar(64);