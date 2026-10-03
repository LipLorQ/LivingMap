CREATE TABLE `course_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`level` text NOT NULL,
	`target_id` text NOT NULL,
	`summary` text NOT NULL,
	`changed_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE INDEX `course_changes_open_idx` ON `course_changes` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `decade_plan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`start_year` integer NOT NULL,
	`end_year` integer NOT NULL,
	`statement` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "decade_range" CHECK("decade_plan_items"."end_year" >= "decade_plan_items"."start_year")
);
--> statement-breakpoint
CREATE INDEX `decade_plan_items_start_idx` ON `decade_plan_items` (`start_year`);--> statement-breakpoint
CREATE TABLE `routine_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`position` integer NOT NULL,
	`active` integer NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `routine_items_kind_idx` ON `routine_items` (`kind`,`position`);--> statement-breakpoint
CREATE TABLE `season_history` (
	`id` text PRIMARY KEY NOT NULL,
	`focus` text NOT NULL,
	`why_it_matters` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `three_year_horizon` (
	`id` text PRIMARY KEY NOT NULL,
	`start_year` integer NOT NULL,
	`end_year` integer NOT NULL,
	`direction` text NOT NULL,
	`why_it_matters` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "horizon_span" CHECK("three_year_horizon"."end_year" = "three_year_horizon"."start_year" + 2)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `three_year_horizon_single_idx` ON `three_year_horizon` ((1));--> statement-breakpoint
CREATE TABLE `year_direction` (
	`id` text PRIMARY KEY NOT NULL,
	`year` integer NOT NULL,
	`direction` text NOT NULL,
	`why_it_matters` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `year_direction_single_idx` ON `year_direction` ((1));--> statement-breakpoint
ALTER TABLE `intentions` ADD `why_it_matters` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `intentions` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `intentions` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `intentions` ADD `closed_at` text;--> statement-breakpoint
ALTER TABLE `season` ADD `why_it_matters` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `season` ADD `started_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Custom SQL (Stage 8, ADR-0009): backfills for rows that predate the new columns. Nothing is invented:
-- the existing Season keeps its real start (the last owner-declared season change, else when it was created);
-- an existing Intention was "the active Intention" of Stages 2-7, so it stays active and gets order 1.
UPDATE `season` SET `started_at` = COALESCE((SELECT MAX(`timestamp`) FROM `change_log` WHERE `command_type` = 'season.changeSeason'), `created_at`);--> statement-breakpoint
UPDATE `intentions` SET `position` = (SELECT COUNT(*) FROM `intentions` AS `other` WHERE `other`.`created_at` < `intentions`.`created_at` OR (`other`.`created_at` = `intentions`.`created_at` AND `other`.`rowid` <= `intentions`.`rowid`));--> statement-breakpoint
-- The active-project limit is a database fact like captures.raw_text (migration 0011): no writer — Electron,
-- MCP or a future one — can ever put a fourth Intention into the active state. MUST match MAX_ACTIVE_INTENTIONS.
CREATE TRIGGER `intentions_active_limit_insert` BEFORE INSERT ON `intentions`
WHEN NEW.`status` = 'active' AND (SELECT COUNT(*) FROM `intentions` WHERE `status` = 'active') >= 3
BEGIN
  SELECT RAISE(ABORT, 'at most 3 active intentions');
END;--> statement-breakpoint
CREATE TRIGGER `intentions_active_limit_update` BEFORE UPDATE OF `status` ON `intentions`
WHEN NEW.`status` = 'active' AND OLD.`status` <> 'active' AND (SELECT COUNT(*) FROM `intentions` WHERE `status` = 'active') >= 3
BEGIN
  SELECT RAISE(ABORT, 'at most 3 active intentions');
END;
