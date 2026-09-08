CREATE TABLE `card_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`checked_at` integer NOT NULL,
	`actual_balance_cents` integer NOT NULL,
	`expected_balance_cents` integer NOT NULL,
	`variance_cents` integer NOT NULL,
	`ledger_movement_cents` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_card_audits_date` ON `card_audits` (`checked_at`);--> statement-breakpoint
CREATE TABLE `cash_box_events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`event_type` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`calculated_change_cents` integer DEFAULT 0 NOT NULL,
	`ledger_transaction_id` text,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ledger_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_cash_box_events_date` ON `cash_box_events` (`occurred_at`);--> statement-breakpoint
PRAGMA optimize;
