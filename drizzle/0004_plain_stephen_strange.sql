CREATE TABLE `outlook_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`target_date` text NOT NULL,
	`target_cents` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_outlook_targets_date` ON `outlook_targets` (`target_date`);