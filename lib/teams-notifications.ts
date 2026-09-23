import { env } from "cloudflare:workers";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { cardAudits, forecastCheckpoints, forecastSettings, teamsNotificationRuns, transactions } from "../db/schema";

function chicagoTime(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, hour: Number(value("hour")) };
}

const currency = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const dateKey = (date: Date) => chicagoTime(date).date;
const day = (key: string) => new Date(`${key}T12:00:00Z`);
const keyOf = (date: Date) => date.toISOString().slice(0, 10);
const closed = (key: string, closures: Array<{ start: string; end: string }>) => closures.some(({ start, end }) => key >= start && key <= end);
function closuresFrom(json: string): Array<{ start: string; end: string }> {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((row): row is { start: string; end: string } =>
      Boolean(row && typeof row.start === "string" && typeof row.end === "string")) : [];
  } catch { return []; }
}

type TeamsContent = { text: string; kind?: "report"; title?: string; revenueToday?: string; revenueWeek?: string; expensesWeek?: string; balance?: string; pace?: string; projection?: string; goal?: string; review?: string };

async function send(content: string | TeamsContent, url: string) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:") throw new Error("TEAMS_FLOW_URL must use HTTPS.");
  const message = typeof content === "string" ? { text: content } : content;
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ "@type": "MessageCard", "@context": "https://schema.org/extensions", summary: "SnackBar notification", ...message }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Teams workflow returned HTTP ${response.status}.`);
}

export function teamsConfigured() {
  return Boolean((env as unknown as Record<string, string | undefined>).TEAMS_FLOW_URL?.trim());
}

async function dailyReviewMessage(now = new Date()) {
  const db = getDb();
  const [venmo, amex] = await Promise.all(["venmo", "amex"].map(async (source) => {
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(transactions)
      .where(and(eq(transactions.source, source as "venmo" | "amex"), eq(transactions.classification, "pending")));
    return Number(row.count);
  }));
  const [ledger, [settings], [checkpoint], [openingAudit]] = await Promise.all([
    db.select({ occurredAt: transactions.occurredAt, amountCents: transactions.amountCents })
      .from(transactions).where(eq(transactions.classification, "snack_bar")),
    db.select().from(forecastSettings).where(eq(forecastSettings.id, "primary")).limit(1),
    db.select().from(forecastCheckpoints).orderBy(desc(forecastCheckpoints.createdAt)).limit(1),
    db.select({ actualBalanceCents: cardAudits.actualBalanceCents }).from(cardAudits).orderBy(asc(cardAudits.checkedAt)).limit(1),
  ]);
  const today = dateKey(now);
  const lastWeek = day(today); lastWeek.setUTCDate(lastWeek.getUTCDate() - 6);
  const weekRows = ledger.filter((row) => dateKey(row.occurredAt) >= keyOf(lastWeek));
  const weeklyRevenue = weekRows.reduce((sum, row) => sum + Math.max(0, row.amountCents), 0);
  const weeklyExpenses = weekRows.reduce((sum, row) => sum + Math.max(0, -row.amountCents), 0);
  const balance = (openingAudit?.actualBalanceCents ?? 0) + ledger.reduce((sum, row) => sum + row.amountCents, 0);
  const firstSale = ledger.filter((row) => row.amountCents > 0).map((row) => dateKey(row.occurredAt)).sort()[0];
  const semesterStart = settings?.semesterStart || firstSale || today;
  const closures = closuresFrom(settings?.closuresJson || "[]");
  const paceDays: string[] = [];
  const cursor = day(today); cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (keyOf(cursor) >= semesterStart && paceDays.length < 14) {
    if (!closed(keyOf(cursor), closures)) paceDays.push(keyOf(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  const salesByDay = new Map<string, number>();
  for (const row of ledger) {
    if (row.amountCents > 0) {
      const key = dateKey(row.occurredAt);
      salesByDay.set(key, (salesByDay.get(key) || 0) + row.amountCents);
    }
  }
  const pace = paceDays.length ? paceDays.reduce((sum, key) => sum + (salesByDay.get(key) || 0), 0) / paceDays.length : 0;
  const weekdaySamples = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
  for (const key of paceDays) {
    const sample = weekdaySamples[day(key).getUTCDay()];
    sample.total += salesByDay.get(key) || 0;
    sample.days++;
  }
  const weekdayPaces = weekdaySamples.map((sample) => sample.days ? sample.total / sample.days : pace);
  const nextMonth = day(today); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  const projected = day(today); projected.setUTCDate(projected.getUTCDate() + 1);
  let projectedBalance = balance;
  while (projected < nextMonth) {
    if (!closed(keyOf(projected), closures)) projectedBalance += weekdayPaces[projected.getUTCDay()];
    projected.setUTCDate(projected.getUTCDate() + 1);
  }
  const title = `SnackBar daily report · ${today}`;
  const revenueToday = currency(salesByDay.get(today) || 0);
  const revenueWeek = currency(weeklyRevenue);
  const expensesWeek = currency(weeklyExpenses);
  const balanceDisplay = currency(balance);
  const paceDisplay = paceDays.length ? `${currency(pace)}/day (${paceDays.length} of 14 days)` : "Waiting for approved revenue";
  const projection = paceDays.length ? `${currency(projectedBalance)} on ${keyOf(nextMonth)} (future expenses excluded)` : "Not enough data";
  let goal = "No tracked goal yet";
  if (checkpoint) {
    const checkpointClosures = closuresFrom(checkpoint.closuresJson);
    let checkpointPaces: number[];
    try { checkpointPaces = JSON.parse(checkpoint.weekdayPacesJson) as number[]; } catch { checkpointPaces = []; }
    const planDay = day(dateKey(checkpoint.createdAt));
    planDay.setUTCDate(planDay.getUTCDate() + 1);
    let planned = checkpoint.startingBalanceCents;
    while (keyOf(planDay) < today) {
      if (!closed(keyOf(planDay), checkpointClosures)) planned += checkpointPaces[planDay.getUTCDay()] ?? checkpoint.dailyRevenueCents;
      planDay.setUTCDate(planDay.getUTCDate() + 1);
    }
    const variance = balance - planned;
    const threshold = Math.max(200, checkpoint.dailyRevenueCents * .15);
    const status = balance >= checkpoint.targetCents ? "Goal reached" : variance < -threshold ? "Behind plan" : variance > threshold ? "Ahead of plan" : "On pace";
    goal = `${currency(checkpoint.targetCents)} · ${status} (${variance >= 0 ? "+" : "-"}${currency(Math.abs(variance))} vs. original plan)`;
  }
  const review = `${venmo} Venmo · ${amex} Amex`;
  const text = [title, `Revenue today: ${revenueToday}`, `Last 7 days: ${revenueWeek} revenue · ${expensesWeek} expenses`,
    `Operating balance: ${balanceDisplay}`, `Revenue pace: ${paceDisplay}`, `Projected balance: ${projection}`,
    `Tracked goal: ${goal}`, `Waiting for review: ${review}`].join("\n");
  return { kind: "report" as const, title, revenueToday, revenueWeek, expensesWeek, balance: balanceDisplay, pace: paceDisplay, projection, goal, review, text };
}

export async function sendTeamsReportNow() {
  const url = (env as unknown as Record<string, string | undefined>).TEAMS_FLOW_URL?.trim();
  if (!url) throw new Error("Add TEAMS_FLOW_URL as an encrypted Worker secret first.");
  await send(await dailyReviewMessage(), url);
}

export async function sendTeamsNotifications(now = new Date()) {
  const url = (env as unknown as Record<string, string | undefined>).TEAMS_FLOW_URL?.trim();
  if (!url) return;
  const db = getDb();
  try {
    const local = chicagoTime(now);
    if (local.hour === 17) {
      const id = `daily:${local.date}`;
      const [sent] = await db.select({ id: teamsNotificationRuns.id }).from(teamsNotificationRuns).where(eq(teamsNotificationRuns.id, id)).limit(1);
      if (!sent) {
        await send(await dailyReviewMessage(now), url);
        await db.insert(teamsNotificationRuns).values({ id, deliveredAt: now }).onConflictDoNothing();
      }
    }
  } catch (error) {
    console.error("SnackBar Teams notification failed:", error instanceof Error ? error.message : error);
  }
}
