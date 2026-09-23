import { env } from "cloudflare:workers";
import { and, eq, gte, like, lt } from "drizzle-orm";
import { getDb } from "../db";
import { excludedKeys, plaidConnections, transactions } from "../db/schema";

export type PlaidKind = "venmo" | "amex";
type Connection = typeof plaidConnections.$inferSelect;
type PlaidAccount = { account_id: string; name: string; type: string; subtype?: string };
type PlaidTransaction = {
  transaction_id: string; account_id: string; amount: number; date: string; name: string;
  original_description?: string | null; merchant_name?: string | null; pending: boolean;
};
type SyncPage = {
  added: PlaidTransaction[]; modified: PlaidTransaction[]; removed: { transaction_id: string }[];
  next_cursor: string; has_more: boolean;
};

function settings() {
  const variables = env as unknown as Record<string, string | undefined>;
  const clientId = variables.PLAID_CLIENT_ID;
  const secret = variables.PLAID_SECRET;
  const tokenKey = variables.PLAID_TOKEN_KEY;
  const redirectUri = variables.PLAID_REDIRECT_URI;
  const environment = variables.PLAID_ENV === "sandbox" ? "sandbox" : "production";
  const issues = plaidConfigurationIssues();
  if (issues.length) throw new Error(issues.join(" "));
  return { clientId: clientId!, secret: secret!, tokenKey: tokenKey!, redirectUri: redirectUri!, environment };
}

export function plaidConfigurationIssues() {
  const variables = env as unknown as Record<string, string | undefined>;
  const issues = ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_TOKEN_KEY", "PLAID_REDIRECT_URI"]
    .filter((name) => !variables[name]?.trim()).map((name) => `${name} is missing from this Worker.`);
  const redirectUri = variables.PLAID_REDIRECT_URI;
  if (redirectUri && !/^https:\/\/[^?#]+$/.test(redirectUri) && !(variables.PLAID_ENV === "sandbox" && /^http:\/\/localhost(:\d+)?\/[^?#]+$/.test(redirectUri))) {
    issues.push("PLAID_REDIRECT_URI must be an HTTPS URL without a query string.");
  }
  return issues;
}

export function plaidConfigured() {
  return plaidConfigurationIssues().length === 0;
}

export async function plaidRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const config = settings();
  const response = await fetch(`https://${config.environment}.plaid.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PLAID-CLIENT-ID": config.clientId, "PLAID-SECRET": config.secret },
    body: JSON.stringify(body),
  });
  const data = await response.json() as T & { error_code?: string; error_message?: string };
  if (!response.ok) throw new Error(`Plaid ${data.error_code || response.status}: ${data.error_message || "Request failed"}`);
  return data;
}

function bytesFromBase64(value: string) {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
function base64FromBytes(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function cryptoKey() {
  const bytes = bytesFromBase64(settings().tokenKey);
  if (bytes.length !== 32) throw new Error("PLAID_TOKEN_KEY must be a base64-encoded 32-byte secret.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(), new TextEncoder().encode(value)));
  return `v1.${base64FromBytes(iv)}.${base64FromBytes(ciphertext)}`;
}
async function decrypt(value: string) {
  const [version, iv, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext) throw new Error("Stored Plaid connection cannot be decrypted.");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesFromBase64(iv), }, await cryptoKey(), bytesFromBase64(ciphertext));
  return new TextDecoder().decode(plain);
}

export function plaidRedirectUri() { return settings().redirectUri; }

export async function createLinkToken(kind: PlaidKind, existing?: Connection) {
  const config = settings();
  const token = existing ? await decrypt(existing.encryptedToken) : undefined;
  const result = await plaidRequest<{ link_token: string }>("/link/token/create", {
    client_name: "SnackBar",
    country_codes: ["US"],
    language: "en",
    user: { client_user_id: "snackbar-manager" },
    redirect_uri: config.redirectUri,
    ...(token ? { access_token: token } : { products: ["transactions"], transactions: { days_requested: 90 } }),
  });
  return { linkToken: result.link_token, kind, reconnect: Boolean(existing) };
}

export async function connectItem(kind: PlaidKind, publicToken: string) {
  const db = getDb();
  const [existing] = await db.select().from(plaidConnections).where(eq(plaidConnections.kind, kind)).limit(1);
  if (existing) throw new Error(`Disconnect the existing ${kind} connection before adding a replacement.`);
  const exchanged = await plaidRequest<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
  const details = await plaidRequest<{ item: { institution_id: string } }>("/item/get", { access_token: exchanged.access_token });
  const institution = await plaidRequest<{ institution: { name: string } }>("/institutions/get_by_id", {
    institution_id: details.item.institution_id, country_codes: ["US"],
  });
  const institutionName = institution.institution.name;
  const expected = kind === "venmo" ? /venmo/i : /american express|amex/i;
  if (!expected.test(institutionName)) {
    await plaidRequest("/item/remove", { access_token: exchanged.access_token });
    throw new Error(`Connected ${institutionName}; choose ${kind === "venmo" ? "Venmo Personal" : "American Express"} instead.`);
  }
  const accounts = await plaidRequest<{ accounts: PlaidAccount[] }>("/accounts/get", { access_token: exchanged.access_token });
  const selected = eligibleAccounts(kind, accounts.accounts);
  const warning = selected.length ? null : `No eligible ${kind} account was shared with Plaid. Reconnect to share a checking or credit account.`;
  await db.insert(plaidConnections).values({
    kind, itemId: exchanged.item_id, encryptedToken: await encrypt(exchanged.access_token),
    accountIdsJson: JSON.stringify(selected.map((account) => account.account_id)),
    cursor: null, connectedAt: new Date(), lastSyncedAt: null, lastError: warning,
  });
  return { kind, institution: institutionName, accounts: selected.map((account) => account.name), warning };
}

function eligibleAccounts(kind: PlaidKind, accounts: PlaidAccount[]) {
  return accounts.filter((account) => kind === "venmo"
    ? account.type === "depository"
    : account.type === "credit" || (account.type === "depository" && account.subtype === "checking"));
}

export async function refreshConnectedAccounts(connection: Connection) {
  const accounts = await plaidRequest<{ accounts: PlaidAccount[] }>("/accounts/get", { access_token: await decrypt(connection.encryptedToken) });
  const selected = eligibleAccounts(connection.kind, accounts.accounts);
  const warning = selected.length ? null : `No eligible ${connection.kind} account was shared with Plaid. Reconnect to share a checking or credit account.`;
  await getDb().update(plaidConnections).set({
    accountIdsJson: JSON.stringify(selected.map((account) => account.account_id)), lastError: warning,
  }).where(eq(plaidConnections.kind, connection.kind));
  return { selected: selected.length, warning };
}

function samePerson(a: string, b: string) {
  return a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function venmoDescription(description: string) {
  const match = description.trim().match(/^(.+?)\s+["“]([^"”]*)["”]\s*$/);
  return match ? { name: match[1].trim(), note: match[2].trim() } : null;
}

async function repairPendingVenmoDescriptions() {
  const db = getDb();
  const rows = await db.select({ id: transactions.id, counterparty: transactions.counterparty, note: transactions.note })
    .from(transactions).where(and(eq(transactions.source, "venmo"), eq(transactions.classification, "pending"), like(transactions.sourceKey, "plaid:%")));
  for (const row of rows) {
    const parsed = venmoDescription(row.counterparty);
    if (parsed && row.note === row.counterparty) {
      await db.update(transactions).set({ counterparty: parsed.name, note: parsed.note }).where(eq(transactions.id, row.id));
    }
  }
}

async function applyTransaction(connection: Connection, row: PlaidTransaction, accountIds: Set<string>) {
  if (!accountIds.has(row.account_id) || row.pending) return false;
  const venmo = connection.kind === "venmo";
  // Plaid amounts are positive when money leaves the account.
  if (venmo && row.amount >= 0) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return false;
  const amountCents = Math.round(-row.amount * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) return false;
  const occurredAt = new Date(`${row.date}T12:00:00Z`);
  // An initial Plaid sync may return years of history; existing records came from CSV.
  const cutover = connection.connectedAt.toISOString().slice(0, 10);
  if (row.date < cutover) return false;
  const db = getDb();
  const sourceKey = `plaid:${row.transaction_id}`;
  const [excluded] = await db.select({ sourceKey: excludedKeys.sourceKey }).from(excludedKeys).where(eq(excludedKeys.sourceKey, sourceKey)).limit(1);
  if (excluded) return false;
  const [existing] = await db.select().from(transactions).where(eq(transactions.sourceKey, sourceKey)).limit(1);
  const description = (row.original_description || row.name || row.merchant_name || "").trim();
  const parsed = venmo ? venmoDescription(description) : null;
  const name = (parsed?.name || description).slice(0, 150);
  const note = venmo ? (parsed?.note || (row.name !== description ? row.name : "")) : row.name;
  const counterparty = !name || (venmo && /^venmo(?: payment| transfer)?$/i.test(name))
    ? (venmo ? "Unknown Venmo payer" : "Unknown Amex merchant") : name;
  if (existing) {
    if (existing.classification === "pending") {
      await db.update(transactions).set({ amountCents, counterparty, note: note || "", occurredAt }).where(eq(transactions.id, existing.id));
    } else if (existing.amountCents !== amountCents) {
      throw new Error("A previously approved Plaid transaction changed; reconcile it manually with a statement.");
    }
    return false;
  }
  if (venmo) {
    // The first day's history can overlap a CSV imported before connecting.
    const dayStart = new Date(`${row.date}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const candidates = await db.select({ amountCents: transactions.amountCents, counterparty: transactions.counterparty })
      .from(transactions).where(and(eq(transactions.source, "venmo"), gte(transactions.occurredAt, dayStart), lt(transactions.occurredAt, dayEnd)));
    if (candidates.some((item) => item.amountCents === amountCents && samePerson(item.counterparty, counterparty))) return false;
  }
  await db.insert(transactions).values({
    id: crypto.randomUUID(), sourceKey, importBatchId: null, occurredAt, amountCents,
    source: connection.kind, direction: venmo || amountCents > 0 ? "incoming" : "outgoing",
    counterparty, note: note || "", originalType: "Plaid transaction", originalStatus: "Posted",
    classification: "pending", createdAt: new Date(), reviewedAt: null,
  }).onConflictDoNothing();
  return true;
}

export async function syncConnection(connection: Connection) {
  const token = await decrypt(connection.encryptedToken);
  const accountIds = new Set(JSON.parse(connection.accountIdsJson) as string[]);
  if (!accountIds.size) throw new Error(`No eligible ${connection.kind} account is shared with Plaid. Use Reconnect to share an account.`);
  let imported = 0;
  try {
    let pages: SyncPage[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      pages = [];
      let cursor = connection.cursor;
      try {
        while (pages.length < 20) {
          const page = await plaidRequest<SyncPage>("/transactions/sync", { access_token: token, cursor: cursor || undefined, count: 500 });
          pages.push(page);
          cursor = page.next_cursor;
          if (!page.has_more) break;
        }
        if (pages.at(-1)?.has_more) throw new Error("Plaid returned too many pages. Sync again later.");
        break;
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION")) || attempt === 2) throw error;
      }
    }
    const db = getDb();
    for (const page of pages) {
      for (const row of [...page.added, ...page.modified]) if (await applyTransaction(connection, row, accountIds)) imported++;
      for (const removed of page.removed) {
        const [stored] = await db.select().from(transactions).where(eq(transactions.sourceKey, `plaid:${removed.transaction_id}`)).limit(1);
        if (!stored) continue;
        if (stored.classification !== "pending") throw new Error("An approved Plaid transaction was removed; reconcile it manually with a statement.");
        await db.delete(transactions).where(eq(transactions.id, stored.id));
      }
      // Replaying a page after a partial failure is safe: source keys are unique.
      await db.update(plaidConnections).set({ cursor: page.next_cursor, lastSyncedAt: new Date(), lastError: null }).where(eq(plaidConnections.kind, connection.kind));
    }
    if (connection.kind === "venmo") await repairPendingVenmoDescriptions();
    return { imported, pages: pages.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    await getDb().update(plaidConnections).set({ lastError: message.slice(0, 300) }).where(eq(plaidConnections.kind, connection.kind));
    throw error;
  }
}

export async function syncPlaidConnections() {
  if (!plaidConfigured()) return;
  const connections = await getDb().select().from(plaidConnections);
  for (const connection of connections) {
    try { await syncConnection(connection); }
    catch (error) { console.error(`Plaid ${connection.kind} sync failed:`, error instanceof Error ? error.message : error); }
  }
}

export async function listPlaidConnections() {
  const rows = await getDb().select().from(plaidConnections);
  return rows.map((row) => ({
    kind: row.kind, connectedAt: row.connectedAt.toISOString(),
    lastSyncedAt: row.lastSyncedAt?.toISOString() || null, lastError: row.lastError,
  }));
}

export async function getPlaidConnection(kind: PlaidKind) {
  const [connection] = await getDb().select().from(plaidConnections).where(eq(plaidConnections.kind, kind)).limit(1);
  return connection;
}

export async function disconnectPlaid(kind: PlaidKind) {
  const connection = await getPlaidConnection(kind);
  if (!connection) return;
  await plaidRequest("/item/remove", { access_token: await decrypt(connection.encryptedToken) });
  await getDb().delete(plaidConnections).where(eq(plaidConnections.kind, kind));
}
