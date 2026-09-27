CREATE TABLE `change_log` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`actor` text NOT NULL,
	`command_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`summary` text NOT NULL,
	`state_revision` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `change_log_entity_idx` ON `change_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`state_revision` integer NOT NULL,
	CONSTRAINT "meta_single_row" CHECK("meta"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `probes` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
