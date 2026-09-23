import { and, asc, desc, eq, gt, gte, inArray, like, lt, notLike, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { cardAdjustments, cardAudits, cardOutflowApplications, cashBoxEvents, excludedKeys, forecastCheckpoints, forecastSettings, importBatches, outlookTargets, plaidConnections, transactions } from "../../../db/schema";
import { parseVenmoCsv } from "../../../lib/csv";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json({ error: message }, { status: 500 });
}

function serialize(row: typeof transactions.$inferSelect) {
  return { ...row, occurredAt: row.occurredAt.toISOString(), createdAt: row.createdAt.toISOString(), reviewedAt: row.reviewedAt?.toISOString() ?? null };
}

function parseMoney(value: unknown) {
  const amount = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function monthKey(date: Date) {
  return date.toISOString().slice(0, 7);
}

function monthLabel(month: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
}

function monthBounds(month: string) {
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end };
}

type ForecastClosure = { id: string; label: string; start: string; end: string };

function validDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseClosures(value: string): ForecastClosure[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const start = String(row.start || "");
      const end = String(row.end || "");
      if (!validDateKey(start) || !validDateKey(end) || end < start) return [];
      return [{ id: String(row.id || crypto.randomUUID()), label: String(row.label || "").slice(0, 80), start, end }];
    }).slice(0, 20);
  } catch {
    return [];
  }
}

async function finalizeAwardsMonth(db: ReturnType<typeof getDb>, month: string, now: Date) {
  const closeId = `award-close:${month}`;
  const [closed] = await db.select({ id: outlookTargets.id }).from(outlookTargets).where(eq(outlookTargets.id, closeId)).limit(1);
  if (closed) return;

  const { start, end } = monthBounds(month);
  const rows = await db
    .select({ amountCents: transactions.amountCents, counterparty: transactions.counterparty })
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
    ));

  const totals = new Map<string, number>();
  rows.forEach((row) => {
    const name = row.counterparty.trim();
    if (name && row.amountCents > 0) totals.set(name, (totals.get(name) || 0) + row.amountCents);
  });

  await db.insert(outlookTargets).values([
    { id: closeId, targetDate: month, targetCents: 0, label: "", createdAt: now },
    ...[...totals.entries()]
      .filter(([, amountCents]) => amountCents >= 1500)
      .map(([label, targetCents]) => ({ id: `award:${month}:${crypto.randomUUID()}`, targetDate: month, targetCents, label, createdAt: now })),
  ]).onConflictDoNothing();
}

async function getCardSnapshot(db: ReturnType<typeof getDb>, checkedAt = new Date()) {
  const [lastAudit] = await db.select().from(cardAudits).orderBy(desc(cardAudits.checkedAt)).limit(1);
  if (!lastAudit) {
    return { lastAudit: null, ledgerMovementCents: 0, adjustmentCents: 0, cardOutflowCents: 0, expectedBalanceCents: 0, checkedAt };
  }
  const since = lastAudit.checkedAt;
  const movements = await db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(eq(transactions.classification, "snack_bar"), eq(transactions.source, "venmo"), eq(transactions.direction, "incoming"),
      or(
        and(like(transactions.sourceKey, "plaid:%"), gt(transactions.reviewedAt, since)),
        and(notLike(transactions.sourceKey, "plaid:%"), gt(transactions.occurredAt, since)),
      )));
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
  const adjustmentCents = adjustments.reduce((sum, row) => sum + row.amountCents, 0);
  const cardOutflowCents = appliedOutflows.reduce((sum, row) => sum + row.amountCents, 0);
  return {
    lastAudit,
    ledgerMovementCents,
    adjustmentCents,
    cardOutflowCents,
    expectedBalanceCents: lastAudit.actualBalanceCents + ledgerMovementCents + adjustmentCents + cardOutflowCents,
    checkedAt,
  };
}

export async function GET() {
  try {
    const db = getDb();
    const rows = await db.select().from(transactions).orderBy(desc(transactions.occurredAt), desc(transactions.createdAt)).limit(10000);
    const [savedForecastSettings] = await db.select().from(forecastSettings).where(eq(forecastSettings.id, "primary")).limit(1);
    const [savedForecastCheckpoint] = await db.select().from(forecastCheckpoints).where(eq(forecastCheckpoints.id, "active")).limit(1);
    const batchRows = await db.select().from(importBatches).orderBy(desc(importBatches.createdAt)).limit(20);
    const usedBatchIds = new Set(rows.map((row) => row.importBatchId).filter(Boolean));
    const batches = batchRows.filter((batch) => usedBatchIds.has(batch.id)).slice(0, 8);
    const [{ count: personalCount }] = await db.select({ count: sql<number>`count(*)` }).from(excludedKeys);
    const cashEvents = await db.select().from(cashBoxEvents).orderBy(desc(cashBoxEvents.occurredAt)).limit(60);
    const audits = await db.select().from(cardAudits).orderBy(desc(cardAudits.checkedAt)).limit(20);
    const [openingAudit] = await db.select({ actualBalanceCents: cardAudits.actualBalanceCents }).from(cardAudits).orderBy(asc(cardAudits.checkedAt)).limit(1);
    const adjustments = await db.select().from(cardAdjustments).orderBy(desc(cardAdjustments.occurredAt)).limit(40);
    const appliedOutflows = await db.select({ transactionId: cardOutflowApplications.transactionId }).from(cardOutflowApplications);
    const appliedOutflowIds = new Set(appliedOutflows.map((row) => row.transactionId));
    const pendingCardOutflows = rows.filter((row) => row.classification === "snack_bar" && row.amountCents < 0 && !appliedOutflowIds.has(row.id));
    const cardSnapshot = await getCardSnapshot(db);
    const now = new Date();
    const termAnchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() >= 6 ? 6 : 0, 1));
    const termRevenueDates = rows
      .filter((row) => row.classification === "snack_bar" && row.amountCents > 0 && row.occurredAt >= termAnchor)
      .map((row) => row.occurredAt)
      .sort((a, b) => a.getTime() - b.getTime());
    const defaultSemesterStart = (termRevenueDates[0] || now).toISOString().slice(0, 10);
    return Response.json({
      pending: rows.filter((row) => row.classification === "pending").slice(0, 250).map(serialize),
      ledger: rows.filter((row) => row.classification === "snack_bar").map(serialize),
      personalCount,
      batches: batches.map((batch) => ({ ...batch, createdAt: batch.createdAt.toISOString() })),
      cashEvents: cashEvents.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString(), createdAt: event.createdAt.toISOString() })),
      openingCardBalanceCents: openingAudit?.actualBalanceCents ?? 0,
      cardAudit: {
        expectedBalanceCents: cardSnapshot.expectedBalanceCents,
        ledgerMovementCents: cardSnapshot.ledgerMovementCents,
        adjustmentCents: cardSnapshot.adjustmentCents,
        cardOutflowCents: cardSnapshot.cardOutflowCents,
        hasBaseline: Boolean(cardSnapshot.lastAudit),
        lastAudit: cardSnapshot.lastAudit ? { ...cardSnapshot.lastAudit, checkedAt: cardSnapshot.lastAudit.checkedAt.toISOString(), createdAt: cardSnapshot.lastAudit.createdAt.toISOString() } : null,
        history: audits.map((audit) => ({ ...audit, checkedAt: audit.checkedAt.toISOString(), createdAt: audit.createdAt.toISOString() })),
        adjustments: adjustments.map((adjustment) => ({ ...adjustment, occurredAt: adjustment.occurredAt.toISOString(), createdAt: adjustment.createdAt.toISOString() })),
      },
      pendingCardOutflows: pendingCardOutflows.map(serialize),
      forecastSettings: {
        semesterStart: savedForecastSettings?.semesterStart || defaultSemesterStart,
        closures: parseClosures(savedForecastSettings?.closuresJson || "[]"),
        updatedAt: savedForecastSettings?.updatedAt.toISOString() || null,
      },
      forecastCheckpoint: savedForecastCheckpoint ? {
        targetCents: savedForecastCheckpoint.targetCents,
        startingBalanceCents: savedForecastCheckpoint.startingBalanceCents,
        dailyRevenueCents: savedForecastCheckpoint.dailyRevenueCents,
        weekdayPaces: (() => {
          try {
            const parsed = JSON.parse(savedForecastCheckpoint.weekdayPacesJson) as unknown;
            return Array.isArray(parsed) && parsed.length === 7 ? parsed.map(Number) : Array(7).fill(savedForecastCheckpoint.dailyRevenueCents);
          } catch { return Array(7).fill(savedForecastCheckpoint.dailyRevenueCents); }
        })(),
        projectedDate: savedForecastCheckpoint.projectedDate,
        closures: parseClosures(savedForecastCheckpoint.closuresJson),
        createdAt: savedForecastCheckpoint.createdAt.toISOString(),
      } : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "");
    const db = getDb();

    if (action === "forecast_settings") {
      const semesterStart = String(body.semesterStart || "");
      if (!validDateKey(semesterStart)) return Response.json({ error: "Choose a valid semester start date." }, { status: 400 });
      const rawClosures = Array.isArray(body.closures) ? body.closures : [];
      if (rawClosures.length > 20) return Response.json({ error: "Use 20 or fewer closure periods." }, { status: 400 });
      const closures: ForecastClosure[] = [];
      for (const [index, item] of rawClosures.entries()) {
        const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const start = String(row.start || "");
        const end = String(row.end || "");
        if (!validDateKey(start) || !validDateKey(end) || end < start) return Response.json({ error: `Closure ${index + 1} needs a valid start and end date.` }, { status: 400 });
        closures.push({ id: String(row.id || crypto.randomUUID()), label: String(row.label || "").trim().slice(0, 80), start, end });
      }
      const updatedAt = new Date();
      await db.insert(forecastSettings).values({ id: "primary", semesterStart, closuresJson: JSON.stringify(closures), updatedAt })
        .onConflictDoUpdate({ target: forecastSettings.id, set: { semesterStart, closuresJson: JSON.stringify(closures), updatedAt } });
      return Response.json({ saved: true, semesterStart, closures, updatedAt: updatedAt.toISOString() });
    }

    if (action === "forecast_checkpoint") {
      const targetCents = Number(body.targetCents);
      const startingBalanceCents = Number(body.startingBalanceCents);
      const dailyRevenueCents = Number(body.dailyRevenueCents);
      const weekdayPaces = Array.isArray(body.weekdayPaces) ? body.weekdayPaces.map(Number) : [];
      const projectedDate = String(body.projectedDate || "");
      if (!Number.isSafeInteger(targetCents) || targetCents <= 0) return Response.json({ error: "Choose a valid goal amount." }, { status: 400 });
      if (!Number.isSafeInteger(startingBalanceCents)) return Response.json({ error: "The current balance is invalid." }, { status: 400 });
      if (!Number.isSafeInteger(dailyRevenueCents) || dailyRevenueCents <= 0) return Response.json({ error: "Revenue pace is needed before this goal can be tracked." }, { status: 400 });
      if (weekdayPaces.length !== 7 || weekdayPaces.some((value) => !Number.isSafeInteger(value) || value < 0)) return Response.json({ error: "The weekday forecast is invalid." }, { status: 400 });
      if (!validDateKey(projectedDate)) return Response.json({ error: "The projected date is invalid." }, { status: 400 });
      const rawClosures = Array.isArray(body.closures) ? body.closures : [];
      const closures: ForecastClosure[] = [];
      for (const item of rawClosures.slice(0, 20)) {
        const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const start = String(row.start || "");
        const end = String(row.end || "");
        if (validDateKey(start) && validDateKey(end) && end >= start) closures.push({ id: String(row.id || crypto.randomUUID()), label: String(row.label || "").trim().slice(0, 80), start, end });
      }
      const createdAt = new Date();
      await db.insert(forecastCheckpoints).values({ id: "active", targetCents, startingBalanceCents, dailyRevenueCents, weekdayPacesJson: JSON.stringify(weekdayPaces), projectedDate, closuresJson: JSON.stringify(closures), createdAt })
        .onConflictDoUpdate({ target: forecastCheckpoints.id, set: { targetCents, startingBalanceCents, dailyRevenueCents, weekdayPacesJson: JSON.stringify(weekdayPaces), projectedDate, closuresJson: JSON.stringify(closures), createdAt } });
      return Response.json({ saved: true, createdAt: createdAt.toISOString() });
    }

    if (action === "finalize_awards_month") {
      const month = String(body.month || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month >= monthKey(new Date())) {
        return Response.json({ error: "Choose a completed month." }, { status: 400 });
      }
      const { start, end } = monthBounds(month);
      const [{ pending }] = await db.select({ pending: sql<number>`count(*)` }).from(transactions).where(and(
        eq(transactions.classification, "pending"), eq(transactions.source, "venmo"),
        gte(transactions.occurredAt, start), lt(transactions.occurredAt, end),
      ));
      if (Number(pending) > 0) return Response.json({ error: "Review the month's Venmo transactions before finalizing awards." }, { status: 400 });
      await finalizeAwardsMonth(db, month, new Date());
      return Response.json({ finalized: month });
    }

    if (action === "import") {
      const csv = String(body.csv || "");
      const fileName = String(body.fileName || "Venmo statement.csv");
      if (!csv || csv.length > 8_000_000) return Response.json({ error: "Choose a CSV smaller than 8 MB." }, { status: 400 });
      const parsed = parseVenmoCsv(csv);
      const [plaidVenmo] = await db.select({ connectedAt: plaidConnections.connectedAt }).from(plaidConnections).where(eq(plaidConnections.kind, "venmo")).limit(1);
      if (plaidVenmo && parsed.transactions.some((row) => row.occurredAt.toISOString().slice(0, 10) >= plaidVenmo.connectedAt.toISOString().slice(0, 10))) {
        return Response.json({ error: "This CSV overlaps your Plaid Venmo connection. Use Sync Venmo for current payments; CSV import remains available for earlier dates." }, { status: 409 });
      }
      const parsedMonths = [...new Set(parsed.transactions.filter((row) => row.direction === "incoming").map((row) => monthKey(row.occurredAt)))].sort();
      const incomingMonth = parsedMonths.at(-1);
      if (incomingMonth) {
        const existingVenmoDates = await db
          .select({ occurredAt: transactions.occurredAt })
          .from(transactions)
          .where(and(eq(transactions.source, "venmo"), eq(transactions.direction, "incoming")));
        const awardRows = await db.select({ id: outlookTargets.id }).from(outlookTargets);
        const closedMonths = new Set(awardRows
          .filter((row) => row.id.startsWith("award-close:"))
          .map((row) => row.id.slice("award-close:".length)));
        const closingMonths = [...new Set(existingVenmoDates.map((row) => monthKey(row.occurredAt)))]
          .filter((month) => month < incomingMonth && !closedMonths.has(month))
          .sort();

        if (closingMonths.length && body.finalizePreviousMonth !== true) {
          return Response.json({
            requiresMonthFinalize: true,
            closingMonth: closingMonths.at(-1),
            closingMonths,
            closingMonthLabel: closingMonths.map(monthLabel).join(closingMonths.length > 2 ? ", " : " and "),
            incomingMonth,
            incomingMonthLabel: monthLabel(incomingMonth),
          }, { status: 409 });
        }

        if (closingMonths.length) {
          for (const closingMonth of closingMonths) {
            const { start, end } = monthBounds(closingMonth);
            const [pending] = await db
              .select({ count: sql<number>`count(*)` })
              .from(transactions)
              .where(and(
                eq(transactions.classification, "pending"),
                eq(transactions.source, "venmo"),
                eq(transactions.direction, "incoming"),
                gte(transactions.occurredAt, start),
                lt(transactions.occurredAt, end),
              ));
            if (Number(pending?.count || 0) > 0) {
              return Response.json({ error: `Review every ${monthLabel(closingMonth)} Venmo transaction before finalizing its awards.` }, { status: 400 });
            }
          }
          for (const closingMonth of closingMonths) {
            await finalizeAwardsMonth(db, closingMonth, new Date());
          }
        }
      }
      const keys = parsed.transactions.map((row) => row.sourceKey);
      const existing = new Set<string>();
      for (let index = 0; index < keys.length; index += 75) {
        const chunk = keys.slice(index, index + 75);
        if (!chunk.length) continue;
        const matches = await db.select({ sourceKey: transactions.sourceKey }).from(transactions).where(inArray(transactions.sourceKey, chunk));
        const excluded = await db.select({ sourceKey: excludedKeys.sourceKey }).from(excludedKeys).where(inArray(excludedKeys.sourceKey, chunk));
        matches.forEach((row) => existing.add(row.sourceKey));
        excluded.forEach((row) => existing.add(row.sourceKey));
      }
      const fresh = parsed.transactions.filter((row) => !existing.has(row.sourceKey));
      const batchId = crypto.randomUUID();
      const now = new Date();
      await db.insert(importBatches).values({ id: batchId, fileName, importedCount: fresh.length, duplicateCount: parsed.transactions.length - fresh.length, skippedCount: parsed.skipped, createdAt: now });
      for (let index = 0; index < fresh.length; index += 5) {
        const chunk = fresh.slice(index, index + 5);
        await db.insert(transactions).values(chunk.map((row) => ({ id: crypto.randomUUID(), sourceKey: row.sourceKey, importBatchId: batchId, occurredAt: row.occurredAt, amountCents: row.amountCents, source: "venmo" as const, direction: row.direction, counterparty: row.counterparty, note: row.note, originalType: row.originalType, originalStatus: row.originalStatus, classification: "pending" as const, createdAt: now })));
      }
      return Response.json({ imported: fresh.length, duplicates: parsed.transactions.length - fresh.length, skipped: parsed.skipped });
    }

    if (action === "review") {
      const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 250) : [];
      const classification = body.classification === "snack_bar" ? "snack_bar" : body.classification === "personal" ? "personal" : null;
      if (!ids.length || !classification) return Response.json({ error: "Choose at least one transaction and a classification." }, { status: 400 });
      const revisedName = body.counterparty === undefined ? null : String(body.counterparty || "").trim().slice(0, 150);
      if (revisedName !== null && !revisedName) return Response.json({ error: "Enter a payer or merchant name." }, { status: 400 });
      if (classification === "personal") {
        for (let index = 0; index < ids.length; index += 40) {
          const idChunk = ids.slice(index, index + 40);
          const personalRows = await db.select({ sourceKey: transactions.sourceKey }).from(transactions).where(inArray(transactions.id, idChunk));
          if (personalRows.length) {
            await db.insert(excludedKeys).values(personalRows.map((row) => ({ sourceKey: row.sourceKey, excludedAt: new Date() }))).onConflictDoNothing();
            await db.delete(transactions).where(inArray(transactions.id, idChunk));
          }
        }
      } else {
        for (let index = 0; index < ids.length; index += 75) {
          const chunk = ids.slice(index, index + 75);
          const rows = await db.select().from(transactions).where(and(inArray(transactions.id, chunk), eq(transactions.classification, "pending")));
          if (rows.some((row) => row.source === "venmo" && row.sourceKey.startsWith("plaid:") && (revisedName || row.counterparty).toLowerCase().includes("unknown venmo payer"))) {
            return Response.json({ error: "Enter the real payer name before approving this Venmo payment." }, { status: 400 });
          }
          await db.update(transactions).set({ classification, reviewedAt: new Date(), ...(revisedName && ids.length === 1 ? { counterparty: revisedName } : {}) }).where(and(inArray(transactions.id, chunk), eq(transactions.classification, "pending")));
          const amexRows = rows.filter((row) => row.source === "amex" && row.amountCents < 0);
          if (amexRows.length) await db.insert(cardOutflowApplications).values(amexRows.map((row) => ({
            id: crypto.randomUUID(), transactionId: row.id, appliedAt: new Date(), createdAt: new Date(),
          }))).onConflictDoNothing({ target: cardOutflowApplications.transactionId });
        }
      }
      return Response.json({ updated: ids.length });
    }

    if (action === "manual") {
      const amount = Number(body.amount);
      const occurredAt = new Date(String(body.date || ""));
      const source = body.source === "cash" ? "cash" : "manual";
      const direction = body.direction === "outgoing" ? "outgoing" : "incoming";
      const countTowardAwards = body.countTowardAwards === true;
      const counterparty = String(body.counterparty || "").trim();
      if (!Number.isFinite(amount) || amount <= 0 || Number.isNaN(occurredAt.getTime())) return Response.json({ error: "Enter a valid date and an amount greater than zero." }, { status: 400 });
      if (countTowardAwards && (source !== "manual" || direction !== "incoming")) return Response.json({ error: "Only manual money-in purchases can count toward awards." }, { status: 400 });
      if (countTowardAwards && !counterparty) return Response.json({ error: "Enter the customer's name when counting a purchase toward awards." }, { status: 400 });
      if (countTowardAwards) {
        const [closedMonth] = await db.select({ id: outlookTargets.id }).from(outlookTargets).where(eq(outlookTargets.id, `award-close:${monthKey(occurredAt)}`)).limit(1);
        if (closedMonth) return Response.json({ error: `${monthLabel(monthKey(occurredAt))} awards are already finalized.` }, { status: 400 });
      }
      const amountCents = Math.round(amount * 100) * (direction === "outgoing" ? -1 : 1);
      const now = new Date();
      await db.insert(transactions).values({ id: crypto.randomUUID(), sourceKey: `manual:${crypto.randomUUID()}`, importBatchId: null, occurredAt, amountCents, source, direction, counterparty, note: String(body.note || ""), originalType: countTowardAwards ? "Manual award purchase" : "Manual entry", originalStatus: "Complete", classification: "snack_bar", createdAt: now, reviewedAt: now });
      return Response.json({ created: true });
    }

    if (action === "cash_count") {
      const now = new Date();
      const [previousCount] = await db.select().from(cashBoxEvents).where(eq(cashBoxEvents.eventType, "count")).orderBy(desc(cashBoxEvents.occurredAt)).limit(1);
      const billsCents = parseMoney(body.bills ?? body.balance);
      const coinsWereEntered = body.coins !== undefined && body.coins !== null && String(body.coins).trim() !== "";
      const enteredCoinsCents = coinsWereEntered ? parseMoney(body.coins) : null;
      const previousBreakdownKnown = !previousCount || previousCount.amountCents === previousCount.billsCents + previousCount.coinsCents;
      if (!coinsWereEntered && !previousBreakdownKnown) return Response.json({ error: "Count the coins once to establish the bill/coin split. After that, you can leave coins blank." }, { status: 400 });
      const coinsCents = coinsWereEntered ? enteredCoinsCents : (previousCount?.coinsCents ?? 0);
      if (billsCents === null || billsCents < 0) return Response.json({ error: "Enter the amount of bills currently in the cash box." }, { status: 400 });
      if (coinsCents === null || coinsCents < 0) return Response.json({ error: "Enter a valid coin amount or leave it blank to reuse the last count." }, { status: 400 });
      const balanceCents = billsCents + coinsCents;
      const since = previousCount?.occurredAt ?? new Date(0);
      const adjustments = await db.select().from(cashBoxEvents).where(and(gt(cashBoxEvents.occurredAt, since), inArray(cashBoxEvents.eventType, ["withdrawal", "deposit"])));
      const withdrawals = adjustments.filter((row) => row.eventType === "withdrawal").reduce((sum, row) => sum + row.amountCents, 0);
      const deposits = adjustments.filter((row) => row.eventType === "deposit").reduce((sum, row) => sum + row.amountCents, 0);
      const calculatedChangeCents = balanceCents - (previousCount?.amountCents ?? 0) + withdrawals - deposits;
      const transactionId = calculatedChangeCents === 0 ? null : crypto.randomUUID();
      if (transactionId) {
        await db.insert(transactions).values({
          id: transactionId,
          sourceKey: `cash-count:${crypto.randomUUID()}`,
          importBatchId: null,
          occurredAt: now,
          amountCents: calculatedChangeCents,
          source: "cash",
          direction: calculatedChangeCents > 0 ? "incoming" : "outgoing",
          counterparty: "Cash box",
          note: `Cash count: $${(balanceCents / 100).toFixed(2)} ($${(billsCents / 100).toFixed(2)} bills + $${(coinsCents / 100).toFixed(2)} coins)`,
          originalType: "Cash box count",
          originalStatus: "Complete",
          classification: "snack_bar",
          createdAt: now,
          reviewedAt: now,
        });
      }
      await db.insert(cashBoxEvents).values({
        id: crypto.randomUUID(), occurredAt: now, eventType: "count", amountCents: balanceCents,
        billsCents, coinsCents, calculatedChangeCents, ledgerTransactionId: transactionId, note: String(body.note || ""), createdAt: now,
      });
      return Response.json({ balanceCents, billsCents, coinsCents, coinsCarriedForward: !coinsWereEntered, calculatedChangeCents, previousBalanceCents: previousCount?.amountCents ?? 0, withdrawals, deposits });
    }

    if (action === "cash_to_card") {
      const amountCents = parseMoney(body.amount);
      if (amountCents === null || amountCents <= 0) return Response.json({ error: "Enter a transfer amount greater than zero." }, { status: 400 });
      const now = new Date();
      const note = String(body.note || "").trim() || "Cash deposit to card";
      await db.insert(cashBoxEvents).values({
        id: crypto.randomUUID(), occurredAt: now, eventType: "withdrawal", amountCents,
        billsCents: 0, coinsCents: 0, calculatedChangeCents: 0, ledgerTransactionId: null, note, createdAt: now,
      });
      await db.insert(cardAdjustments).values({
        id: crypto.randomUUID(), occurredAt: now, amountCents, note, createdAt: now,
      });
      return Response.json({ created: true, amountCents });
    }

    if (action === "cash_adjustment") {
      const amountCents = parseMoney(body.amount);
      const eventType = body.eventType === "deposit" ? "deposit" : body.eventType === "withdrawal" ? "withdrawal" : null;
      if (amountCents === null || amountCents <= 0 || !eventType) return Response.json({ error: "Enter a valid cash movement." }, { status: 400 });
      const now = new Date();
      await db.insert(cashBoxEvents).values({ id: crypto.randomUUID(), occurredAt: now, eventType, amountCents, billsCents: 0, coinsCents: 0, calculatedChangeCents: 0, ledgerTransactionId: null, note: String(body.note || ""), createdAt: now });
      return Response.json({ created: true });
    }

    if (action === "card_audit" || action === "card_baseline") {
      const actualBalanceCents = parseMoney(body.balance);
      if (actualBalanceCents === null || actualBalanceCents < 0) return Response.json({ error: "Enter the current card balance." }, { status: 400 });
      const now = new Date();
      const snapshot = await getCardSnapshot(db, now);
      const resetBaseline = action === "card_baseline" || !snapshot.lastAudit;
      const expectedBalanceCents = resetBaseline ? actualBalanceCents : snapshot.expectedBalanceCents;
      const varianceCents = actualBalanceCents - expectedBalanceCents;
      await db.insert(cardAudits).values({ id: crypto.randomUUID(), checkedAt: now, actualBalanceCents, expectedBalanceCents, varianceCents, ledgerMovementCents: resetBaseline ? 0 : snapshot.ledgerMovementCents, createdAt: now });
      return Response.json({ actualBalanceCents, expectedBalanceCents, varianceCents, ledgerMovementCents: snapshot.ledgerMovementCents });
    }

    if (action === "card_adjustment") {
      const amountCents = parseMoney(body.amount);
      if (amountCents === null || amountCents <= 0) return Response.json({ error: "Enter a deposit amount greater than zero." }, { status: 400 });
      const now = new Date();
      await db.insert(cardAdjustments).values({ id: crypto.randomUUID(), occurredAt: now, amountCents, note: String(body.note || "Donation / non-sales deposit"), createdAt: now });
      return Response.json({ created: true, amountCents });
    }

    if (action === "card_outflow_apply") {
      const transactionId = String(body.transactionId || "");
      if (!transactionId) return Response.json({ error: "Transaction id is required." }, { status: 400 });
      const [transaction] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
      if (!transaction || transaction.classification !== "snack_bar" || transaction.amountCents >= 0) return Response.json({ error: "Choose an approved expense." }, { status: 400 });
      await db.insert(cardOutflowApplications).values({ id: crypto.randomUUID(), transactionId, appliedAt: new Date(), createdAt: new Date() }).onConflictDoNothing({ target: cardOutflowApplications.transactionId });
      return Response.json({ applied: true, amountCents: transaction.amountCents });
    }

    if (action === "delete") {
      const id = String(body.id || "");
      if (!id) return Response.json({ error: "Transaction id is required." }, { status: 400 });
      await db.delete(transactions).where(eq(transactions.id, id));
      return Response.json({ deleted: true });
    }

    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
