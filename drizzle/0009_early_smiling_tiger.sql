CREATE TABLE `plaid_connections` (
	`kind` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`encrypted_token` text NOT NULL,
	`account_ids_json` text NOT NULL,
	`cursor` text,
	`connected_at` integer NOT NULL,
	`last_synced_at` integer,
	`last_error` text
);
