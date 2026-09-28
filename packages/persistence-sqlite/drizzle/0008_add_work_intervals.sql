CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`daily_work_target_minutes` integer NOT NULL,
	CONSTRAINT "settings_single_row" CHECK("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `work_intervals` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`last_heartbeat_at` text NOT NULL,
	`time_zone` text NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_intervals_action_idx` ON `work_intervals` (`action_id`);--> statement-breakpoint
CREATE INDEX `work_intervals_started_idx` ON `work_intervals` (`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_intervals_one_running_idx` ON `work_intervals` ((1)) WHERE "work_intervals"."ended_at" IS NULL;