import { env } from "cloudflare:workers";
import { and, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { teamsNotificationEvents, teamsNotificationRuns, transactions } from "../db/schema";

function chicagoTime(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, hour: Number(value("hour")) };
}

async function send(message: string, url: string) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:") throw new Error("TEAMS_FLOW_URL must use HTTPS.");
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Teams workflow returned HTTP ${response.status}.`);
}

export function teamsConfigured() {
  return Boolean((env as unknown as Record<string, string | undefined>).TEAMS_FLOW_URL?.trim());
}

export async function sendTeamsTest() {
  const url = (env as unknown as Record<string, string | undefined>).TEAMS_FLOW_URL?.trim();
  if (!url) throw new Error("Add TEAMS_FLOW_URL as an encrypted Worker secret first.");
  await send("SnackBar: Teams notifications are connected. New Venmo payments and the daily review summary will appear here.", url);
}

export async function sendTeamsNotifications(now = new Date()) {
  const url = (env as unknown as Record<string, string | undefined>).TEAMS_FLOW_URL?.trim();
  if (!url) return;
  const db = getDb();
  try {
    // A ten-minute window groups payments imported during the same sync into one alert.
    const queued = await db.select({ transactionId: teamsNotificationEvents.transactionId }).from(teamsNotificationEvents)
      .where(and(isNull(teamsNotificationEvents.deliveredAt), lte(teamsNotificationEvents.queuedAt, new Date(now.getTime() - 600_000))))
      .limit(500);
    if (queued.length) {
      const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(transactions)
        .where(and(eq(transactions.source, "venmo"), eq(transactions.classification, "pending")));
      await send(`SnackBar: ${queued.length} new Venmo payment${queued.length === 1 ? "" : "s"} imported. ${Number(count)} Venmo payment${Number(count) === 1 ? "" : "s"} waiting for review.`, url);
      await db.update(teamsNotificationEvents).set({ deliveredAt: now })
        .where(inArray(teamsNotificationEvents.transactionId, queued.map((row) => row.transactionId)));
    }

    const local = chicagoTime(now);
    if (local.hour === 17) {
      const id = `daily:${local.date}`;
      const [sent] = await db.select({ id: teamsNotificationRuns.id }).from(teamsNotificationRuns).where(eq(teamsNotificationRuns.id, id)).limit(1);
      if (!sent) {
        const [venmo, amex] = await Promise.all(["venmo", "amex"].map(async (source) => {
          const [row] = await db.select({ count: sql<number>`count(*)` }).from(transactions)
            .where(and(eq(transactions.source, source as "venmo" | "amex"), eq(transactions.classification, "pending")));
          return Number(row.count);
        }));
        await send(`SnackBar daily review: ${venmo} Venmo payment${venmo === 1 ? "" : "s"} and ${amex} Amex transaction${amex === 1 ? "" : "s"} waiting for review.`, url);
        await db.insert(teamsNotificationRuns).values({ id, deliveredAt: now }).onConflictDoNothing();
      }
    }
    await db.delete(teamsNotificationEvents).where(and(lt(teamsNotificationEvents.deliveredAt, new Date(now.getTime() - 30 * 86_400_000))));
  } catch (error) {
    console.error("SnackBar Teams notification failed:", error instanceof Error ? error.message : error);
  }
}
