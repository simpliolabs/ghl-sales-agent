ALTER TABLE `leads` ADD `lastAgentActivityAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `pipelineValue` int DEFAULT 0;