CREATE TABLE `household_items` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`source_capture_id` text,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`source_capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "household_items_status" CHECK("household_items"."status" IN ('active', 'done'))
);
--> statement-breakpoint
CREATE INDEX `household_items_status_idx` ON `household_items` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `household_items_source_capture_idx` ON `household_items` (`source_capture_id`) WHERE "household_items"."source_capture_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `selected_intention_id` text;--> statement-breakpoint
ALTER TABLE `stages` ADD `archived_at` text;