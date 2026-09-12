import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { cardAudits, cashBoxEvents, importBatches, outlookTargets, transactions } from "../../../db/schema";

export const dynamic = "force-dynamic";

type AwardTier = "bronze" | "silver" | "gold" | "platinum";

const awardTier = (amountCents: number): AwardTier | null =>
  amountCents >= 5000 ? "platinum" :
  amountCents >= 3500 ? "gold" :
  amountCents >= 2500 ? "silver" :
  amountCents >= 1500 ? "bronze" : null;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const rows = await db
      .select({ occurredAt: transactions.occurredAt, amountCents: transactions.amountCents, counterparty: transactions.counterparty, source: transactions.source, originalType: transactions.originalType })
      .from(transactions)
      .where(eq(transactions.classification, "snack_bar"))
      .orderBy(asc(transactions.occurredAt))
      .limit(10000);

    const days = new Map<string, { date: string; revenueCents: number; expenseCents: number; saleCount: number }>();
    const weeklyDays = new Map<string, { date: string; revenueCents: number; expenseCents: number; saleCount: number }>();
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
      if (row.source !== "cash") {
        const weeklyDay = weeklyDays.get(date) || { date, revenueCents: 0, expenseCents: 0, saleCount: 0 };
        if (row.amountCents > 0) {
          weeklyDay.revenueCents += row.amountCents;
          weeklyDay.saleCount += 1;
        } else {
          weeklyDay.expenseCents += Math.abs(row.amountCents);
        }
        weeklyDays.set(date, weeklyDay);
      }
    }

    const { searchParams } = new URL(request.url);
    const fromValue = searchParams.get("from");
    const toValue = searchParams.get("to");
    const from = fromValue && /^\d{4}-\d{2}-\d{2}$/.test(fromValue) ? new Date(`${fromValue}T00:00:00Z`) : new Date(0);
    const to = toValue && /^\d{4}-\d{2}-\d{2}$/.test(toValue) ? new Date(`${toValue}T23:59:59.999Z`) : new Date();
    const leaders = new Map<string, { name: string; totalCents: number; purchases: number }>();
    rows.filter((row) => row.source !== "cash" && row.amountCents > 0 && row.counterparty && row.occurredAt >= from && row.occurredAt <= to).forEach((row) => {
      const current = leaders.get(row.counterparty) || { name: row.counterparty, totalCents: 0, purchases: 0 };
      current.totalCents += row.amountCents;
      current.purchases += 1;
      leaders.set(row.counterparty, current);
    });

    const savedAwards = await db
      .select({ id: outlookTargets.id, name: outlookTargets.label, month: outlookTargets.targetDate, amountCents: outlookTargets.targetCents })
      .from(outlookTargets);
    const awardsByName = new Map<string, Array<{ month: string; tier: AwardTier; current: boolean }>>();
    savedAwards.forEach((award) => {
      const tier = award.id.startsWith("award:") ? awardTier(award.amountCents) : null;
      const key = award.name.trim().toLowerCase();
      if (!tier || !key) return;
      const current = awardsByName.get(key) || [];
      current.push({ month: award.month, tier, current: false });
      awardsByName.set(key, current);
    });

    const currentMonth = new Date().toISOString().slice(0, 7);
    const currentMonthTotals = new Map<string, number>();
    rows
      .filter((row) => (row.source === "venmo" || (row.source === "manual" && row.originalType === "Manual award purchase")) && row.amountCents > 0 && row.counterparty && row.occurredAt.toISOString().startsWith(currentMonth))
      .forEach((row) => {
        const key = row.counterparty!.trim().toLowerCase();
        currentMonthTotals.set(key, (currentMonthTotals.get(key) || 0) + row.amountCents);
      });
    currentMonthTotals.forEach((amountCents, key) => {
      const tier = awardTier(amountCents);
      if (!tier) return;
      const current = awardsByName.get(key) || [];
      current.push({ month: currentMonth, tier, current: true });
      awardsByName.set(key, current);
    });
    awardsByName.forEach((awards) => awards.sort((a, b) => Number(b.current) - Number(a.current) || b.month.localeCompare(a.month)));
    const rankedLeaders = [...leaders.values()].sort((a, b) => b.totalCents - a.totalCents);

    const [{ count: pendingCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(and(eq(transactions.classification, "pending"), eq(transactions.direction, "incoming")));
    const [latestCount] = await db.select({ occurredAt: cashBoxEvents.occurredAt }).from(cashBoxEvents).where(eq(cashBoxEvents.eventType, "count")).orderBy(desc(cashBoxEvents.occurredAt)).limit(1);
    const [latestImport] = await db.select({ createdAt: importBatches.createdAt }).from(importBatches).orderBy(desc(importBatches.createdAt)).limit(1);
    const [openingAudit] = await db.select({ actualBalanceCents: cardAudits.actualBalanceCents }).from(cardAudits).orderBy(asc(cardAudits.checkedAt)).limit(1);

    return Response.json({
      days: [...days.values()],
      weeklyDays: [...weeklyDays.values()],
      pendingCount: Number(pendingCount),
      latestCashCountAt: latestCount?.occurredAt.toISOString() ?? null,
      latestVenmoImportAt: latestImport?.createdAt.toISOString() ?? null,
      openingCardBalanceCents: openingAudit?.actualBalanceCents ?? 0,
      leaders: rankedLeaders.slice(0, 10).map((leader) => ({
        ...leader,
        awards: awardsByName.get(leader.name.trim().toLowerCase()) || [],
      })),
      customerConcentration: (() => {
        const topThreeCents = rankedLeaders.slice(0, 3).reduce((sum, customer) => sum + customer.totalCents, 0);
        const totalCents = rankedLeaders.reduce((sum, customer) => sum + customer.totalCents, 0);
        return { topThreeCents, everyoneElseCents: totalCents - topThreeCents, totalCents, customerCount: rankedLeaders.length };
      })(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the overview.";
    return Response.json({ error: message }, { status: 500 });
  }
}
