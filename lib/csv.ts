type CsvRow = string[];

export type ParsedVenmoTransaction = {
  sourceKey: string;
  occurredAt: Date;
  amountCents: number;
  direction: "incoming" | "outgoing";
  counterparty: string;
  note: string;
  originalType: string;
  originalStatus: string;
};

function parseRows(input: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell.trim()); cell = ""; }
    else if (char === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
    else if (char !== "\r") cell += char;
  }
  if (cell.length || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

function normalize(value: string) {
  return value.toLowerCase().replace(/^\ufeff/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function amountToCents(value: string) {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-") || /^\(.*\)$/.test(trimmed);
  const numeric = Number(trimmed.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100) * (negative ? -1 : 1);
}

function parseDate(value: string) {
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(.*))?$/);
  if (!match) return null;
  const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
  const fallback = new Date(`${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}T${match[4] || "12:00:00"}`);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}

export function parseVenmoCsv(input: string) {
  const rows = parseRows(input);
  const headerIndex = rows.findIndex((row) => {
    const headers = row.map(normalize);
    return headers.some((h) => h === "datetime" || h === "date") && headers.some((h) => h === "amount" || h.includes("amount total"));
  });
  if (headerIndex < 0) throw new Error("I couldn't find Venmo's Date/Datetime and Amount columns in this CSV.");

  const headers = rows[headerIndex].map(normalize);
  const find = (...choices: string[]) => headers.findIndex((h) => choices.some((choice) => h === choice || h.includes(choice)));
  const indexes = { id: find("transaction id", "id"), date: find("datetime", "date"), type: find("type"), status: find("status"), note: find("note"), from: find("from"), to: find("to"), amount: find("amount total", "amount") };
  const parsed: ParsedVenmoTransaction[] = [];
  let skipped = 0;

  for (const row of rows.slice(headerIndex + 1)) {
    const date = parseDate(row[indexes.date] || "");
    const amountCents = amountToCents(row[indexes.amount] || "");
    if (!date || amountCents === null || amountCents === 0) { if (row.some(Boolean)) skipped += 1; continue; }
    const direction = amountCents > 0 ? "incoming" : "outgoing";
    const counterparty = (direction === "incoming" ? row[indexes.from] : row[indexes.to]) || "Unknown";
    const note = row[indexes.note] || "";
    const originalType = row[indexes.type] || "";
    const originalStatus = row[indexes.status] || "";
    const suppliedId = row[indexes.id] || "";
    const fingerprint = [date.toISOString(), amountCents, counterparty, note, originalType].join("|");
    parsed.push({ sourceKey: `venmo:${suppliedId || stableHash(fingerprint)}`, occurredAt: date, amountCents, direction, counterparty, note, originalType, originalStatus });
  }
  return { transactions: parsed, skipped };
}
