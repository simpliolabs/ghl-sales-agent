ALTER TABLE `ai_state` MODIFY COLUMN `lastAngleUsed` text;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `blocked` tinyint DEFAULT 0;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `blockReason` text;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `violationCategory` varchar(64);--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `ownerNotified` tinyint DEFAULT 0;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `fallbackUsed` tinyint DEFAULT 0;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `fallbackMessage` text;