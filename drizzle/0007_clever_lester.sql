ALTER TABLE `brain_council_audit` ADD `correctionSent` tinyint DEFAULT 0;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `correctionMessage` text;--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `correctionReason` text;