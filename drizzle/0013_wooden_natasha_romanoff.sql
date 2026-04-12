CREATE TABLE `channel_performance` (
	`id` int AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`channel` varchar(32) NOT NULL,
	`messagesSent` int DEFAULT 0,
	`repliesReceived` int DEFAULT 0,
	`avgReplyMinutes` int,
	`positiveReplies` int DEFAULT 0,
	`stageAdvances` int DEFAULT 0,
	`lastSentAt` timestamp,
	`lastReplyAt` timestamp,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `channel_performance_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `hall_of_fame` (
	`id` int AUTO_INCREMENT NOT NULL,
	`auditId` int NOT NULL,
	`leadId` int NOT NULL,
	`message` text NOT NULL,
	`framework` varchar(64) NOT NULL,
	`approach` varchar(64),
	`channel` varchar(32),
	`segment` varchar(64),
	`persona` varchar(64),
	`replyMinutes` int,
	`replySentiment` varchar(16),
	`stageAdvanced` tinyint DEFAULT 0,
	`converted` tinyint DEFAULT 0,
	`pipelineValue` int DEFAULT 0,
	`promotionReason` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `hall_of_fame_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `post_delivery_sequences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`step` int NOT NULL DEFAULT 1,
	`scheduledAt` timestamp NOT NULL,
	`sentAt` timestamp,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`channel` varchar(32),
	`auditId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `post_delivery_sequences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `seasonal_campaigns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`angle` text NOT NULL,
	`targetSegments` json,
	`startDate` timestamp NOT NULL,
	`endDate` timestamp NOT NULL,
	`maxLeadsPerDay` int DEFAULT 50,
	`totalSent` int DEFAULT 0,
	`totalReplies` int DEFAULT 0,
	`status` varchar(16) NOT NULL DEFAULT 'draft',
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `seasonal_campaigns_id` PRIMARY KEY(`id`)
);
