CREATE TABLE `card_outflow_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`applied_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_card_outflow_transaction` ON `card_outflow_applications` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_card_outflow_applied_at` ON `card_outflow_applications` (`applied_at`);