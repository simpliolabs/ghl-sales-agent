CREATE TABLE `decision_log` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`outboxId` bigint,
	`leadId` int NOT NULL,
	`trigger` varchar(64) NOT NULL,
	`brainReasoning` text,
	`promptVersion` varchar(20),
	`channel` varchar(32),
	`inputGuardResult` varchar(32),
	`outputGuardResult` varchar(32),
	`durationMs` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `decision_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`idemKey` varchar(64) NOT NULL,
	`source` enum('webhook','responder','follow_up','manual','nurture','correction','first_contact') NOT NULL,
	`payload` json NOT NULL,
	`outbox_status` enum('pending','claimed','sent','failed','skipped') NOT NULL DEFAULT 'pending',
	`claimedBy` varchar(64),
	`claimedAt` timestamp,
	`scheduledAt` timestamp NOT NULL,
	`sentAt` timestamp,
	`error` text,
	`retryCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `outbox_id` PRIMARY KEY(`id`)
);
