ALTER TABLE `brain_council_audit` ADD `emailSubject` varchar(512);--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `modelUsed` varchar(128);--> statement-breakpoint
ALTER TABLE `brain_council_audit` ADD `fineTuningJobId` int;--> statement-breakpoint
ALTER TABLE `message_outcomes` ADD `emailSubject` varchar(512);--> statement-breakpoint
ALTER TABLE `message_outcomes` ADD `emailOpened` tinyint DEFAULT 0;--> statement-breakpoint
ALTER TABLE `message_outcomes` ADD `emailOpenedAt` timestamp;