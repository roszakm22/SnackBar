import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { cardAudits, cashBoxEvents, transactions } from "../../../db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const rows = await db
      .select({ occurredAt: transactions.occurredAt, amountCents: transactions.amountCents })
      .from(transactions)
      .where(eq(transactions.classification, "snack_bar"))
      .orderBy(asc(transactions.occurredAt))
      .limit(10000);

    const days = new Map<string, { date: string; revenueCents: number; expenseCents: number; saleCount: number }>();
    for (const row of rows) {
      const date = row.occurredAt.toISOString().slice(0, 10);
      const day = days.get(date) || { date, revenueCents: 0, expenseCents: 0, saleCount: 0 };
      if (row.amountCents > 0) {
        day.revenueCents += row.amountCents;
        day.saleCount += 1;
      } else {
        day.expenseCents += Math.abs(row.amountCents);
      }
      days.set(date, day);
    }

    const [{ count: pendingCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(and(eq(transactions.classification, "pending"), eq(transactions.direction, "incoming")));
    const [latestCount] = await db.select({ occurredAt: cashBoxEvents.occurredAt }).from(cashBoxEvents).where(eq(cashBoxEvents.eventType, "count")).orderBy(desc(cashBoxEvents.occurredAt)).limit(1);
    const [latestAudit] = await db.select({ checkedAt: cardAudits.checkedAt }).from(cardAudits).orderBy(desc(cardAudits.checkedAt)).limit(1);

    return Response.json({
      days: [...days.values()],
      pendingCount: Number(pendingCount),
      latestCashCountAt: latestCount?.occurredAt.toISOString() ?? null,
      latestCardAuditAt: latestAudit?.checkedAt.toISOString() ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the overview.";
    return Response.json({ error: message }, { status: 500 });
  }
}
