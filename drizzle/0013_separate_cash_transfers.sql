ALTER TABLE `card_adjustments` ADD `kind` text DEFAULT 'deposit' NOT NULL;
--> statement-breakpoint
-- Cash-to-card actions wrote the paired withdrawal and adjustment together.
-- Preserve donations; only reclassify records with that exact paired event.
UPDATE card_adjustments SET kind = 'cash_transfer'
WHERE EXISTS (
  SELECT 1 FROM cash_box_events
  WHERE event_type = 'withdrawal'
    AND ledger_transaction_id IS NULL
    AND occurred_at = card_adjustments.occurred_at
    AND created_at = card_adjustments.created_at
    AND amount_cents = card_adjustments.amount_cents
    AND note = card_adjustments.note
);
