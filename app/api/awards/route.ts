import { and, asc, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../../../db";
import { outlookTargets, transactions } from "../../../db/schema";

export const dynamic = "force-dynamic";

const tierFor = (amountCents: number) =>
  amountCents >= 10000 ? "platinum" :
  amountCents >= 7500 ? "gold" :
  amountCents >= 5000 ? "silver" :
  amountCents >= 2500 ? "bronze" : "unranked";

const monthBounds = (month: string) => {
  const [year, monthNumber] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, monthNumber - 1, 1)),
    end: new Date(Date.UTC(year, monthNumber, 1)),
  };
};

export async function GET() {
  try {
    const db = getDb();
    const currentMonth = new Date().toISOString().slice(0, 7);
    const { start, end } = monthBounds(currentMonth);
    const currentRows = await db
      .select({ counterparty: transactions.counterparty, amountCents: transactions.amountCents })
      .from(transactions)
      .where(and(
        eq(transactions.classification, "snack_bar"),
        eq(transactions.source, "venmo"),
        eq(transactions.direction, "incoming"),
        gte(transactions.occurredAt, start),
        lt(transactions.occurredAt, end),
      ))
      .orderBy(asc(transactions.counterparty));

    const currentTotals = new Map<string, number>();
    currentRows.forEach((row) => {
      const name = row.counterparty.trim();
      if (name && row.amountCents > 0) currentTotals.set(name, (currentTotals.get(name) || 0) + row.amountCents);
    });

    const saved = await db.select().from(outlookTargets).orderBy(asc(outlookTargets.targetDate), asc(outlookTargets.label));
    const history = saved
      .filter((row) => row.id.startsWith("award:") && row.label && row.targetCents >= 2500)
      .map((row) => ({ month: row.targetDate, name: row.label, amountCents: row.targetCents, tier: tierFor(row.targetCents) }))
      .sort((a, b) => b.month.localeCompare(a.month) || b.amountCents - a.amountCents);

    const current = [...currentTotals.entries()]
      .map(([name, amountCents]) => ({ name, amountCents, tier: tierFor(amountCents) }))
      .sort((a, b) => b.amountCents - a.amountCents);

    return Response.json({ currentMonth, current, history });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load awards.";
    return Response.json({ error: message }, { status: 500 });
  }
}
