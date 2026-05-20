CREATE TABLE `compose_locks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`eventKey` varchar(64) NOT NULL,
	`source` varchar(50) NOT NULL,
	`lockedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`expiresAt` datetime(3) NOT NULL,
	CONSTRAINT `compose_locks_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_compose_lock` UNIQUE(`leadId`,`eventKey`)
);
--> statement-breakpoint
CREATE TABLE `send_attempts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`channel` varchar(32) NOT NULL,
	`outcomeKind` varchar(32) NOT NULL,
	`reason` text NOT NULL,
	`errorType` varchar(64),
	`attemptedAt` timestamp NOT NULL DEFAULT (now()),
	`trigger` varchar(64) NOT NULL,
	`payload` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `send_attempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_compose_expires` ON `compose_locks` (`expiresAt`);