CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`import_batch_id` text,
	`occurred_at` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`source` text NOT NULL,
	`direction` text NOT NULL,
	`counterparty` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`original_type` text DEFAULT '' NOT NULL,
	`original_status` text DEFAULT '' NOT NULL,
	`classification` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transactions_source_key` ON `transactions` (`source_key`);--> statement-breakpoint
CREATE INDEX `idx_transactions_classification_date` ON `transactions` (`classification`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_transactions_counterparty` ON `transactions` (`counterparty`);--> statement-breakpoint
PRAGMA optimize;
