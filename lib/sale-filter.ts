import { and, eq, gt, or } from "drizzle-orm";
import { transactions } from "../db/schema";

export const countedSalesCondition = or(
  eq(transactions.classification, "snack_bar"),
  and(eq(transactions.classification, "pending"), eq(transactions.source, "venmo"), eq(transactions.direction, "incoming"), gt(transactions.amountCents, 0)),
);

export const countedLedgerCondition = or(countedSalesCondition, eq(transactions.classification, "card_refund"));
