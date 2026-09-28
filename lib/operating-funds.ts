import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { cardAdjustments, transactions } from "../db/schema";

export async function getOperatingFunds(db: ReturnType<typeof getDb>) {
  const [manual, imported] = await Promise.all([
    db.select({ id: cardAdjustments.id, amountCents: cardAdjustments.amountCents, occurredAt: cardAdjustments.occurredAt })
      .from(cardAdjustments).where(eq(cardAdjustments.kind, "deposit")),
    db.select({ id: transactions.id, amountCents: transactions.amountCents, occurredAt: transactions.reviewedAt })
      .from(transactions).where(eq(transactions.classification, "card_deposit")),
  ]);
  const deposits = [...manual, ...imported];
  return { nonSalesDepositsCents: deposits.reduce((sum, row) => sum + row.amountCents, 0), deposits };
}
