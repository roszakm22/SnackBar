import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { getDb } from "../../../db";
import { hiddenScoreNames, transactions } from "../../../db/schema";
import { scoreNameKey } from "../../../lib/hidden-scores";

export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const db = getDb();
    const rows = await db.selectDistinct({ text: transactions.note, name: transactions.counterparty })
      .from(transactions)
      .where(and(
        eq(transactions.showAsQuote, true),
        eq(transactions.classification, "snack_bar"),
        eq(transactions.direction, "incoming"),
        eq(transactions.source, "venmo"),
        gt(transactions.amountCents, 0),
        isNotNull(transactions.reviewedAt),
      ))
      .orderBy(asc(transactions.note), asc(transactions.counterparty));
    const hiddenNames = new Set((await db.select({ nameKey: hiddenScoreNames.nameKey })
      .from(hiddenScoreNames)).map((row) => row.nameKey));
    const quotes = await Promise.all(rows
      .filter((row) => row.text.trim() && row.text.length <= 500 && row.name.trim()
        && !hiddenNames.has(scoreNameKey(row.name)))
      .map(async ({ text, name }) => {
        // Public IDs depend only on displayed words, never private transaction IDs.
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([text, name])));
        const id = "quote-" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        return { id, text, name };
      }));
    return Response.json(quotes, { headers });
  } catch {
    return Response.json({ error: "Could not load snack quotes." }, { status: 500, headers });
  }
}
