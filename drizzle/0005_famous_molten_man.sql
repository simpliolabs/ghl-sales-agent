CREATE TABLE `brain_council_audit` (
	`id` int AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`leadName` varchar(255),
	`channel` varchar(32),
	`incomingMessage` text,
	`strategyApproach` varchar(64),
	`strategyFramework` varchar(64),
	`strategyReasoning` text,
	`strategyTier` varchar(32),
	`researchSummary` text,
	`composedMessage` text,
	`composerFromName` varchar(128),
	`qcScore` int,
	`qcApproved` tinyint,
	`qcIssues` text,
	`qcFeedback` text,
	`wasRecomposed` tinyint DEFAULT 0,
	`recomposeScore` int,
	`finalMessage` text,
	`messageSent` tinyint DEFAULT 0,
	`sendError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `brain_council_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `webhook_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventType` varchar(64),
	`detectedType` varchar(64),
	`contactId` varchar(128),
	`leadId` int,
	`payloadSummary` text,
	`action` varchar(64),
	`error` text,
	`processingMs` int,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `webhook_logs_id` PRIMARY KEY(`id`)
);
