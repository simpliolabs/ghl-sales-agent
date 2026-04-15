CREATE TABLE `deferred_responses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`leadId` int NOT NULL,
	`ghlContactId` varchar(128) NOT NULL,
	`channel` varchar(32) NOT NULL,
	`messageBody` text NOT NULL,
	`emailSubject` varchar(512),
	`emailHtml` text,
	`fromName` varchar(128),
	`sendAt` timestamp NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`cancelReason` varchar(128),
	`brainCouncilOutput` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	CONSTRAINT `deferred_responses_id` PRIMARY KEY(`id`)
);
