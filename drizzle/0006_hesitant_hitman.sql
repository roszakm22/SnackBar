CREATE TABLE `forecast_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`semester_start` text NOT NULL,
	`closures_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL
);
