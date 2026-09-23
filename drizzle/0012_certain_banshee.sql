CREATE TABLE `teams_notification_events` (
	`transaction_id` text PRIMARY KEY NOT NULL,
	`queued_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `teams_notification_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`delivered_at` integer NOT NULL
);
