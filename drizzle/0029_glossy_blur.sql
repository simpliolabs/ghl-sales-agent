CREATE TABLE `prompt_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`version` varchar(20) NOT NULL,
	`systemPromptHash` varchar(64) NOT NULL,
	`description` text,
	`abTrafficPercent` int DEFAULT 0,
	`isActive` tinyint DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `prompt_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `prompt_versions_version_unique` UNIQUE(`version`)
);
