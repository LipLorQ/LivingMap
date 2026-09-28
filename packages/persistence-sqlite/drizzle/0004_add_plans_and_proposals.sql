CREATE TABLE `ordered_action_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`intention_id` text NOT NULL,
	`ordered_action_ids` text NOT NULL,
	`rationale` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer NOT NULL,
	`source_revision` integer NOT NULL,
	FOREIGN KEY (`intention_id`) REFERENCES `intentions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ordered_action_plans_intention_idx` ON `ordered_action_plans` (`intention_id`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`base_revision` integer NOT NULL,
	`base_fingerprint` text NOT NULL,
	`affected_entity_ids` text NOT NULL,
	`payload` text NOT NULL,
	`rationale` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `proposals_status_idx` ON `proposals` (`status`);