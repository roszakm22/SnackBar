type Entry = { amountCents: number; classification?: string; source?: string };

export const revenueCents = (row: Entry) => row.classification === "card_refund" ? 0 : Math.max(0, row.amountCents);
export const expenseCents = (row: Entry) => row.classification === "card_refund" ? -row.amountCents : Math.max(0, -row.amountCents);
export const isCardExpense = (row: Entry) => row.classification === "snack_bar" && row.amountCents < 0 && row.source !== "cash";

// All pages and reports use the snack bar's calendar, even on a UTC server.
export const businessDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
}).format(date);

export function businessMonthBounds(month: string) {
  const midnight = (year: number, monthIndex: number) => {
    const noon = new Date(Date.UTC(year, monthIndex, 1, 12));
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(noon));
    return new Date(Date.UTC(year, monthIndex, 1, 12 - hour));
  };
  const [year, number] = month.split("-").map(Number);
  return { start: midnight(year, number - 1), end: midnight(year, number) };
}
