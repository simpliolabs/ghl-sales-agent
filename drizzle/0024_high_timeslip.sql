CREATE TABLE `strategy_adjustments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`weekId` varchar(16) NOT NULL,
	`triggerMetric` varchar(64) NOT NULL,
	`currentValue` varchar(32),
	`previousValue` varchar(32),
	`adjustment` text NOT NULL,
	`appliedTo` varchar(64),
	`status` varchar(16) NOT NULL DEFAULT 'proposed',
	`appliedAt` timestamp,
	`expiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategy_adjustments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `training_exports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`exportName` varchar(128) NOT NULL,
	`format` varchar(16) NOT NULL DEFAULT 'jsonl',
	`totalPairs` int NOT NULL DEFAULT 0,
	`filterCriteria` json,
	`fileUrl` text,
	`fileKey` text,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`generatedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `training_exports_id` PRIMARY KEY(`id`)
);
