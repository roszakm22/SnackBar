import { and, asc, eq, gte, lt, or } from "drizzle-orm";
import { getDb } from "../../../db";
import { outlookTargets, transactions } from "../../../db/schema";

export const dynamic = "force-dynamic";

const tierFor = (amountCents: number) =>
  amountCents >= 5000 ? "Platinum" :
  amountCents >= 3500 ? "Gold" :
  amountCents >= 2500 ? "Silver" :
  amountCents >= 1500 ? "Bronze" : "Unranked";

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
        or(
          eq(transactions.source, "venmo"),
          and(eq(transactions.source, "manual"), eq(transactions.originalType, "Manual award purchase")),
        ),
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
    const finalizedMonths = saved
      .filter((row) => row.id.startsWith("award-close:"))
      .map((row) => row.id.slice("award-close:".length))
      .sort((a, b) => b.localeCompare(a));
    const history = saved
      .filter((row) => row.id.startsWith("award:") && row.label && row.targetCents >= 1500)
      .map((row) => ({ month: row.targetDate, name: row.label, amountCents: row.targetCents, tier: tierFor(row.targetCents) }))
      .sort((a, b) => b.month.localeCompare(a.month) || b.amountCents - a.amountCents);

    const current = [...currentTotals.entries()]
      .map(([name, amountCents]) => ({ name, amountCents, tier: tierFor(amountCents) }))
      .sort((a, b) => b.amountCents - a.amountCents);

    return Response.json({ currentMonth, current, history, finalizedMonths });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load awards.";
    return Response.json({ error: message }, { status: 500 });
  }
}
