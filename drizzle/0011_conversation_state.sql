ALTER TABLE `leads` ADD `convState` varchar(20) DEFAULT 'new_lead';--> statement-breakpoint
ALTER TABLE `leads` ADD `convStateUpdatedAt` bigint;--> statement-breakpoint
ALTER TABLE `leads` ADD `intentHistory` json;
