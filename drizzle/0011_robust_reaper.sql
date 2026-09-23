ALTER TABLE `card_audits` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `plaid_connections` ADD `balance_cents` integer;--> statement-breakpoint
ALTER TABLE `plaid_connections` ADD `balance_checked_at` integer;