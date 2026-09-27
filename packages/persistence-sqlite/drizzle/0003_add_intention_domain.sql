CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`stage_id` text NOT NULL,
	`title` text NOT NULL,
	`done_when` text NOT NULL,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`blocker_reason` text,
	`blocked_at` text,
	`completed_at` text,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`stage_id`) REFERENCES `stages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `actions_stage_idx` ON `actions` (`stage_id`);--> statement-breakpoint
CREATE TABLE `good_life_conditions` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`position` integer NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intentions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`desired_result` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `season` (
	`id` text PRIMARY KEY NOT NULL,
	`focus` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stages` (
	`id` text PRIMARY KEY NOT NULL,
	`intention_id` text NOT NULL,
	`title` text NOT NULL,
	`position` integer NOT NULL,
	`is_current` integer NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`intention_id`) REFERENCES `intentions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stages_intention_idx` ON `stages` (`intention_id`);