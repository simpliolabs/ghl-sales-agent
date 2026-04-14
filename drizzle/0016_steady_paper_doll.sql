ALTER TABLE `leads` ADD `reactivatedFromMigration` tinyint DEFAULT 0;--> statement-breakpoint
ALTER TABLE `leads` ADD `appointmentCreatingAt` timestamp;