ALTER TABLE `brain_council_audit` ADD `experimentId` varchar(64);--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `variant` varchar(1);--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `persona` varchar(64);--> statement-breakpoint
ALTER TABLE `conversations` ADD `emailMessageId` varchar(128);