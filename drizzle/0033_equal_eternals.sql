ALTER TABLE `decision_log` ADD `flaggedForReview` tinyint DEFAULT 0;--> statement-breakpoint
ALTER TABLE `decision_log` ADD `flagReason` varchar(255);--> statement-breakpoint
ALTER TABLE `decision_log` ADD `flagAcknowledged` tinyint DEFAULT 0;