CREATE TABLE `segment_weights` (
	`id` int AUTO_INCREMENT NOT NULL,
	`segment` varchar(64) NOT NULL,
	`channel` varchar(32) NOT NULL,
	`stage` varchar(64) NOT NULL,
	`approach` varchar(255) NOT NULL,
	`wins` int NOT NULL DEFAULT 0,
	`losses` int NOT NULL DEFAULT 0,
	`winRate` decimal(5,4) NOT NULL DEFAULT '0.0000',
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `segment_weights_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_segment_channel_stage_approach` UNIQUE(`segment`,`channel`,`stage`,`approach`)
);
