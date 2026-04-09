-- Phase D: Learning Engine tables
-- conversation_outcomes: Full journey tracking per lead
-- learnings: Pattern-level insights with recurrence tracking
-- error_memory: System error tracking with known fixes

CREATE TABLE IF NOT EXISTS `conversation_outcomes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `leadId` int NOT NULL,
  `ghlContactId` varchar(100) NOT NULL,
  `stateSequence` json NOT NULL,
  `approachesUsed` json NOT NULL,
  `frameworksUsed` json,
  `outcome` varchar(20) NOT NULL,
  `outcomeReason` varchar(255),
  `messageCount` int NOT NULL,
  `daysToOutcome` int NOT NULL,
  `channel` varchar(20) NOT NULL,
  `finalConvState` varchar(30),
  `pipelineValue` int DEFAULT 0,
  `createdAt` bigint NOT NULL,
  CONSTRAINT `conversation_outcomes_id` PRIMARY KEY(`id`),
  INDEX `idx_co_outcome` (`outcome`),
  INDEX `idx_co_channel` (`channel`),
  INDEX `idx_co_lead` (`leadId`)
);

CREATE TABLE IF NOT EXISTS `learnings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `patternKey` varchar(100) NOT NULL,
  `category` varchar(30) NOT NULL,
  `description` text NOT NULL,
  `details` text,
  `suggestedAction` text,
  `recurrenceCount` int DEFAULT 1,
  `positiveOutcomes` int DEFAULT 0,
  `negativeOutcomes` int DEFAULT 0,
  `promotedToPrompt` tinyint DEFAULT 0,
  `promotedAt` bigint,
  `priority` varchar(10) DEFAULT 'medium',
  `source` varchar(30) DEFAULT 'auto',
  `createdAt` bigint NOT NULL,
  `updatedAt` bigint NOT NULL,
  CONSTRAINT `learnings_id` PRIMARY KEY(`id`),
  CONSTRAINT `learnings_patternKey_unique` UNIQUE(`patternKey`)
);

CREATE TABLE IF NOT EXISTS `error_memory` (
  `id` int AUTO_INCREMENT NOT NULL,
  `errorSignature` varchar(150) NOT NULL,
  `errorType` varchar(50) NOT NULL,
  `errorMessage` text NOT NULL,
  `rootCause` text,
  `knownFix` text,
  `fixApplied` tinyint DEFAULT 0,
  `occurrenceCount` int DEFAULT 1,
  `lastOccurredAt` bigint NOT NULL,
  `prevention` text,
  `createdAt` bigint NOT NULL,
  `updatedAt` bigint NOT NULL,
  CONSTRAINT `error_memory_id` PRIMARY KEY(`id`),
  CONSTRAINT `error_memory_errorSignature_unique` UNIQUE(`errorSignature`)
);
