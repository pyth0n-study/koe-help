CREATE TABLE `station_status` (
	`station_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`requested_at` integer,
	`claimed_at` integer,
	`responder` text,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `status_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_status_events_station_created` ON `status_events` (`station_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`response_ms` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_events_station_created` ON `activity_events` (`station_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `processed_mutations` (
	`mutation_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `station_settings` (
	`station_id` text PRIMARY KEY NOT NULL,
	`busy_warning_minutes` integer DEFAULT 10 NOT NULL,
	`urgent_warning_minutes` integer DEFAULT 5 NOT NULL,
	`updated_at` integer NOT NULL
);

