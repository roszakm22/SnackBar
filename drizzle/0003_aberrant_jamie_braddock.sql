CREATE TABLE `card_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_card_adjustments_date` ON `card_adjustments` (`occurred_at`);--> statement-breakpoint
PRAGMA optimize;
