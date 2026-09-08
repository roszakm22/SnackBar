import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  importedCount: integer("imported_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const excludedKeys = sqliteTable("excluded_keys", {
  sourceKey: text("source_key").primaryKey(),
  excludedAt: integer("excluded_at", { mode: "timestamp_ms" }).notNull(),
});

export const cashBoxEvents = sqliteTable(
  "cash_box_events",
  {
    id: text("id").primaryKey(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    eventType: text("event_type", { enum: ["count", "withdrawal", "deposit"] }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    calculatedChangeCents: integer("calculated_change_cents").notNull().default(0),
    ledgerTransactionId: text("ledger_transaction_id").references(() => transactions.id),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("idx_cash_box_events_date").on(table.occurredAt)],
);

export const cardAudits = sqliteTable(
  "card_audits",
  {
    id: text("id").primaryKey(),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
    actualBalanceCents: integer("actual_balance_cents").notNull(),
    expectedBalanceCents: integer("expected_balance_cents").notNull(),
    varianceCents: integer("variance_cents").notNull(),
    ledgerMovementCents: integer("ledger_movement_cents").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("idx_card_audits_date").on(table.checkedAt)],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key").notNull(),
    importBatchId: text("import_batch_id").references(() => importBatches.id),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    source: text("source", { enum: ["venmo", "cash", "manual"] }).notNull(),
    direction: text("direction", { enum: ["incoming", "outgoing"] }).notNull(),
    counterparty: text("counterparty").notNull().default(""),
    note: text("note").notNull().default(""),
    originalType: text("original_type").notNull().default(""),
    originalStatus: text("original_status").notNull().default(""),
    classification: text("classification", { enum: ["pending", "snack_bar", "personal"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("idx_transactions_source_key").on(table.sourceKey),
    index("idx_transactions_classification_date").on(table.classification, table.occurredAt),
    index("idx_transactions_counterparty").on(table.counterparty),
  ],
);
