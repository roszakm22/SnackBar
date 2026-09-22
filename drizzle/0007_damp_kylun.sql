CREATE TABLE `forecast_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`target_cents` integer NOT NULL,
	`starting_balance_cents` integer NOT NULL,
	`daily_revenue_cents` integer NOT NULL,
	`weekday_paces_json` text DEFAULT '[]' NOT NULL,
	`projected_date` text NOT NULL,
	`closures_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
