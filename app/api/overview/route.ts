import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { cardAudits, cashBoxEvents, importBatches, outlookTargets, plaidConnections, transactions } from "../../../db/schema";
import { getOperatingFunds } from "../../../lib/operating-funds";
import { businessDate, expenseCents, revenueCents } from "../../../lib/ledger-math";

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
      .select({ occurredAt: transactions.occurredAt, amountCents: transactions.amountCents, counterparty: transactions.counterparty, source: transactions.source, originalType: transactions.originalType, classification: transactions.classification })
      .from(transactions)
      .where(or(eq(transactions.classification, "snack_bar"), eq(transactions.classification, "card_refund")))
      .orderBy(asc(transactions.occurredAt));

    const days = new Map<string, { date: string; revenueCents: number; expenseCents: number; saleCount: number }>();
    const weeklyDays = new Map<string, { date: string; revenueCents: number; expenseCents: number; saleCount: number }>();
    for (const row of rows) {
      const date = businessDate(row.occurredAt);
      const day = days.get(date) || { date, revenueCents: 0, expenseCents: 0, saleCount: 0 };
      day.revenueCents += revenueCents(row);
      day.expenseCents += expenseCents(row);
      if (revenueCents(row) > 0 && row.source !== "cash") day.saleCount += 1;
      days.set(date, day);
      if (row.source !== "cash") {
        const weeklyDay = weeklyDays.get(date) || { date, revenueCents: 0, expenseCents: 0, saleCount: 0 };
        if (revenueCents(row) > 0) {
          weeklyDay.revenueCents += revenueCents(row);
          weeklyDay.saleCount += 1;
        } else {
          weeklyDay.expenseCents += expenseCents(row);
        }
        weeklyDays.set(date, weeklyDay);
      }
    }

    const { nonSalesDepositsCents } = await getOperatingFunds(db);

    const { searchParams } = new URL(request.url);
    const fromValue = searchParams.get("from");
    const toValue = searchParams.get("to");
    const from = fromValue && /^\d{4}-\d{2}-\d{2}$/.test(fromValue) ? fromValue : "1970-01-01";
    const to = toValue && /^\d{4}-\d{2}-\d{2}$/.test(toValue) ? toValue : businessDate();
    const leaders = new Map<string, { name: string; totalCents: number; purchases: number }>();
    rows.filter((row) => row.source !== "cash" && revenueCents(row) > 0 && row.counterparty && businessDate(row.occurredAt) >= from && businessDate(row.occurredAt) <= to).forEach((row) => {
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

    const currentMonth = businessDate().slice(0, 7);
    const currentMonthTotals = new Map<string, number>();
    rows
      .filter((row) => (row.source === "venmo" || (row.source === "manual" && row.originalType === "Manual award purchase")) && row.amountCents > 0 && row.counterparty && businessDate(row.occurredAt).startsWith(currentMonth))
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
    const [venmoConnection] = await db.select({ lastSyncedAt: plaidConnections.lastSyncedAt }).from(plaidConnections).where(eq(plaidConnections.kind, "venmo")).limit(1);
    const [openingAudit] = await db.select({ actualBalanceCents: cardAudits.actualBalanceCents }).from(cardAudits).orderBy(asc(cardAudits.checkedAt)).limit(1);

    return Response.json({
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
      weeklyDays: [...weeklyDays.values()],
      pendingCount: Number(pendingCount),
      latestCashCountAt: latestCount?.occurredAt.toISOString() ?? null,
      latestVenmoImportAt: latestImport?.createdAt.toISOString() ?? null,
      latestVenmoSyncAt: venmoConnection?.lastSyncedAt?.toISOString() ?? null,
      openingCardBalanceCents: openingAudit?.actualBalanceCents ?? 0,
      nonSalesDepositsCents,
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
