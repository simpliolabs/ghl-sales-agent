ALTER TABLE `ai_state` ADD `lastQcScore` int;--> statement-breakpoint
ALTER TABLE `ai_state` ADD `lastStrategyApproach` varchar(32);--> statement-breakpoint
ALTER TABLE `ai_state` ADD `lastResearchSummary` text;--> statement-breakpoint
ALTER TABLE `ai_state` ADD `consecutiveRejects` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `leads` ADD `cadencePosition` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `leads` ADD `reactivationCount` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `leads` ADD `lastReactivationAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `lastSeasonalPushAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `seasonalSegment` varchar(64);--> statement-breakpoint
ALTER TABLE `leads` ADD `lastScoreDecayAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `baseScore` int DEFAULT 50;--> statement-breakpoint
ALTER TABLE `leads` ADD `overrideBy` varchar(128);--> statement-breakpoint
ALTER TABLE `leads` ADD `overrideAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `overrideReason` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `lastQcScore` int;--> statement-breakpoint
ALTER TABLE `leads` ADD `lastStrategyReasoning` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `lastResearchSummary` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `preferredChannel` varchar(32);--> statement-breakpoint
ALTER TABLE `leads` ADD `lastOutboundChannel` varchar(32);