CREATE TABLE `calendar_snapshot` (
	`id` integer PRIMARY KEY NOT NULL,
	`connected` integer NOT NULL,
	`synced_at` text,
	`source` text,
	`time_zone` text,
	`events` text NOT NULL,
	`last_error` text,
	CONSTRAINT "calendar_snapshot_single_row" CHECK("calendar_snapshot"."id" = 1)
);
