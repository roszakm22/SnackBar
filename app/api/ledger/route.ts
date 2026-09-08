import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { cardAdjustments, cardAudits, cardOutflowApplications, cashBoxEvents, excludedKeys, importBatches, transactions } from "../../../db/schema";
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

async function getCardSnapshot(db: ReturnType<typeof getDb>, checkedAt = new Date()) {
  const [lastAudit] = await db.select().from(cardAudits).orderBy(desc(cardAudits.checkedAt)).limit(1);
  if (!lastAudit) {
    return { lastAudit: null, ledgerMovementCents: 0, adjustmentCents: 0, cardOutflowCents: 0, expectedBalanceCents: 0, checkedAt };
  }
  const since = lastAudit.checkedAt;
  const movements = await db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(eq(transactions.classification, "snack_bar"), eq(transactions.source, "venmo"), eq(transactions.direction, "incoming"), gt(transactions.occurredAt, since)));
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
    await db.delete(transactions).where(and(eq(transactions.source, "venmo"), eq(transactions.direction, "outgoing")));
    const rows = await db.select().from(transactions).orderBy(desc(transactions.occurredAt), desc(transactions.createdAt)).limit(10000);
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

    if (action === "import") {
      const csv = String(body.csv || "");
      const fileName = String(body.fileName || "Venmo statement.csv");
      if (!csv || csv.length > 8_000_000) return Response.json({ error: "Choose a CSV smaller than 8 MB." }, { status: 400 });
      const parsed = parseVenmoCsv(csv);
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
          await db.update(transactions).set({ classification, reviewedAt: new Date() }).where(inArray(transactions.id, ids.slice(index, index + 75)));
        }
      }
      return Response.json({ updated: ids.length });
    }

    if (action === "manual") {
      const amount = Number(body.amount);
      const occurredAt = new Date(String(body.date || ""));
      const source = body.source === "cash" ? "cash" : "manual";
      const direction = body.direction === "outgoing" ? "outgoing" : "incoming";
      if (!Number.isFinite(amount) || amount <= 0 || Number.isNaN(occurredAt.getTime())) return Response.json({ error: "Enter a valid date and an amount greater than zero." }, { status: 400 });
      const amountCents = Math.round(amount * 100) * (direction === "outgoing" ? -1 : 1);
      const now = new Date();
      await db.insert(transactions).values({ id: crypto.randomUUID(), sourceKey: `manual:${crypto.randomUUID()}`, importBatchId: null, occurredAt, amountCents, source, direction, counterparty: String(body.counterparty || ""), note: String(body.note || ""), originalType: "Manual entry", originalStatus: "Complete", classification: "snack_bar", createdAt: now, reviewedAt: now });
      return Response.json({ created: true });
    }

    if (action === "cash_count") {
      const balanceCents = parseMoney(body.balance);
      if (balanceCents === null || balanceCents < 0) return Response.json({ error: "Enter the amount currently in the cash box." }, { status: 400 });
      const now = new Date();
      const [previousCount] = await db.select().from(cashBoxEvents).where(eq(cashBoxEvents.eventType, "count")).orderBy(desc(cashBoxEvents.occurredAt)).limit(1);
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
          note: `Cash count: $${(balanceCents / 100).toFixed(2)}`,
          originalType: "Cash box count",
          originalStatus: "Complete",
          classification: "snack_bar",
          createdAt: now,
          reviewedAt: now,
        });
      }
      await db.insert(cashBoxEvents).values({
        id: crypto.randomUUID(), occurredAt: now, eventType: "count", amountCents: balanceCents,
        calculatedChangeCents, ledgerTransactionId: transactionId, note: String(body.note || ""), createdAt: now,
      });
      return Response.json({ balanceCents, calculatedChangeCents, previousBalanceCents: previousCount?.amountCents ?? 0, withdrawals, deposits });
    }

    if (action === "cash_adjustment") {
      const amountCents = parseMoney(body.amount);
      const eventType = body.eventType === "deposit" ? "deposit" : body.eventType === "withdrawal" ? "withdrawal" : null;
      if (amountCents === null || amountCents <= 0 || !eventType) return Response.json({ error: "Enter a valid cash movement." }, { status: 400 });
      const now = new Date();
      await db.insert(cashBoxEvents).values({ id: crypto.randomUUID(), occurredAt: now, eventType, amountCents, calculatedChangeCents: 0, ledgerTransactionId: null, note: String(body.note || ""), createdAt: now });
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
