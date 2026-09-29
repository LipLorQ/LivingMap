CREATE TABLE `captures` (
	`id` text PRIMARY KEY NOT NULL,
	`raw_text` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer NOT NULL,
	`last_error` text,
	`result` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `captures_state_idx` ON `captures` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `captures_created_idx` ON `captures` (`created_at`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`source_capture_id` text,
	`linked_entity_ids` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memories_source_capture_idx` ON `memories` (`source_capture_id`);