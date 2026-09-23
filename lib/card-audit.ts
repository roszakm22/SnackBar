import { and, desc, eq, gt, like, notLike, or } from "drizzle-orm";
import { getDb } from "../db";
import { cardAdjustments, cardAudits, cardOutflowApplications, plaidConnections, transactions } from "../db/schema";

export async function getCardSnapshot(db: ReturnType<typeof getDb>, checkedAt = new Date()) {
  const [lastAudit] = await db.select().from(cardAudits).orderBy(desc(cardAudits.checkedAt)).limit(1);
  const [amexConnection] = await db.select({ kind: plaidConnections.kind }).from(plaidConnections).where(eq(plaidConnections.kind, "amex")).limit(1);
  const usesAmexTransfers = Boolean(amexConnection);
  if (!lastAudit) {
    return { lastAudit: null, usesAmexTransfers, ledgerMovementCents: 0, otherDepositCents: 0, adjustmentCents: 0, cardOutflowCents: 0, expectedBalanceCents: 0, checkedAt };
  }
  const since = lastAudit.checkedAt;
  const movements = usesAmexTransfers ? await db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(eq(transactions.classification, "card_transfer"), eq(transactions.source, "amex"), gt(transactions.reviewedAt, since))) : await db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(eq(transactions.classification, "snack_bar"), eq(transactions.source, "venmo"), eq(transactions.direction, "incoming"),
      or(
        and(like(transactions.sourceKey, "plaid:%"), gt(transactions.reviewedAt, since)),
        and(notLike(transactions.sourceKey, "plaid:%"), gt(transactions.occurredAt, since)),
      )));
  const otherDeposits = await db.select({ amountCents: transactions.amountCents }).from(transactions)
    .where(and(eq(transactions.classification, "card_deposit"), eq(transactions.source, "amex"), gt(transactions.reviewedAt, since)));
  const adjustments = await db
    .select({ amountCents: cardAdjustments.amountCents })
    .from(cardAdjustments)
    .where(gt(cardAdjustments.occurredAt, since));
  const appliedOutflows = await db
    .select({ amountCents: transactions.amountCents })
    .from(cardOutflowApplications)
    .innerJoin(transactions, eq(cardOutflowApplications.transactionId, transactions.id))
    .where(gt(cardOutflowApplications.appliedAt, since));
  const ledgerMovementCents = movements.reduce((sum, row) => sum + row.amountCents, 0);
  const otherDepositCents = otherDeposits.reduce((sum, row) => sum + row.amountCents, 0);
  const adjustmentCents = adjustments.reduce((sum, row) => sum + row.amountCents, 0);
  const cardOutflowCents = appliedOutflows.reduce((sum, row) => sum + row.amountCents, 0);
  return {
    lastAudit,
    usesAmexTransfers,
    ledgerMovementCents,
    otherDepositCents,
    adjustmentCents,
    cardOutflowCents,
    expectedBalanceCents: lastAudit.actualBalanceCents + ledgerMovementCents + otherDepositCents + adjustmentCents + cardOutflowCents,
    checkedAt,
  };
}
