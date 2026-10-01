CREATE TABLE `patterns` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern_key` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`evidence_finding_ids` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `patterns_status_idx` ON `patterns` (`status`);--> statement-breakpoint
CREATE INDEX `patterns_key_idx` ON `patterns` (`pattern_key`);--> statement-breakpoint
CREATE TABLE `planning_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`source_pattern_id` text NOT NULL,
	`created_at` text NOT NULL,
	`deactivated_at` text,
	FOREIGN KEY (`source_pattern_id`) REFERENCES `patterns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `planning_rules_status_idx` ON `planning_rules` (`status`);--> statement-breakpoint
CREATE TABLE `review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`text` text NOT NULL,
	`evidence_refs` text NOT NULL,
	`suggestion` text,
	`pattern_key` text,
	`status` text NOT NULL,
	`corrected_text` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_findings_review_idx` ON `review_findings` (`review_id`);--> statement-breakpoint
CREATE INDEX `review_findings_pattern_key_idx` ON `review_findings` (`pattern_key`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`time_zone` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_type_period_idx` ON `reviews` (`type`,`period_start`,`period_end`);--> statement-breakpoint
CREATE INDEX `reviews_type_status_idx` ON `reviews` (`type`,`status`);