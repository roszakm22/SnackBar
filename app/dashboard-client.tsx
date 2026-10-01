"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight, ArrowUpRight, Banknote, BarChart3, CalendarDays, Check,
  ClipboardCheck, CreditCard, HandCoins, Loader2, Plus, ReceiptText,
  LogOut, RotateCcw, ShoppingBasket, Target, Trash2, Upload, UserRound, WalletCards,
} from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Toaster } from "@/components/ui/sonner";
import { businessDate, revenueCents as saleCents } from "../lib/ledger-math";
import PlaidConnections from "./plaid-connections";

type Transaction = {
  id: string; occurredAt: string; amountCents: number; classification: string; source: "venmo" | "amex" | "cash" | "manual";
  direction: "incoming" | "outgoing"; counterparty: string; note: string; originalType: string; createdAt: string; reviewedAt: string | null;
};
type Batch = { id: string; fileName: string; importedCount: number; duplicateCount: number; skippedCount: number; createdAt: string };
type CashEvent = { id: string; occurredAt: string; eventType: "count" | "withdrawal" | "deposit"; amountCents: number; billsCents: number; coinsCents: number; calculatedChangeCents: number; note: string };
type CardAudit = { id: string; checkedAt: string; actualBalanceCents: number; expectedBalanceCents: number; varianceCents: number; ledgerMovementCents: number; source: "manual" | "plaid" };
type CardAdjustment = { id: string; occurredAt: string; amountCents: number; kind: "deposit" | "cash_transfer"; note: string };
type ForecastClosure = { id: string; label: string; start: string; end: string };
type ForecastSettings = { semesterStart: string; closures: ForecastClosure[]; updatedAt: string | null };
type ForecastCheckpoint = { id: string; targetCents: number; startingBalanceCents: number; dailyRevenueCents: number; weekdayPaces: number[]; projectedDate: string; closures: ForecastClosure[]; createdAt: string };
type LedgerData = {
  pending: Transaction[]; pendingCardOutflows: Transaction[]; ledger: Transaction[]; personalCount: number; batches: Batch[]; cashEvents: CashEvent[];
  openingCardBalanceCents: number; nonSalesDepositsCents: number; nonSalesDeposits: Array<{ id: string; amountCents: number; occurredAt: string | null }>;
  cardAudit: { expectedBalanceCents: number; usesAmexTransfers: boolean; ledgerMovementCents: number; untransferredVenmoCents: number; otherDepositCents: number; adjustmentCents: number; cardOutflowCents: number; hasBaseline: boolean; lastAudit: CardAudit | null; history: CardAudit[]; adjustments: CardAdjustment[]; plaidBalanceCents: number | null; plaidBalanceCheckedAt: string | null; awaitingReview: boolean; awaitingTransfer: boolean };
  forecastSettings: ForecastSettings;
  forecastCheckpoints: ForecastCheckpoint[];
};

const emptyData: LedgerData = { pending: [], pendingCardOutflows: [], ledger: [], personalCount: 0, batches: [], cashEvents: [], openingCardBalanceCents: 0, nonSalesDepositsCents: 0, nonSalesDeposits: [], cardAudit: { expectedBalanceCents: 0, usesAmexTransfers: false, ledgerMovementCents: 0, untransferredVenmoCents: 0, otherDepositCents: 0, adjustmentCents: 0, cardOutflowCents: 0, hasBaseline: false, lastAudit: null, history: [], adjustments: [], plaidBalanceCents: null, plaidBalanceCheckedAt: null, awaitingReview: false, awaitingTransfer: false }, forecastSettings: { semesterStart: "", closures: [], updatedAt: null }, forecastCheckpoints: [] };
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const shortDate = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" }).format(new Date(value));
const dateTime = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }).format(new Date(value));
const localDateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const localDate = (key: string) => {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
};
const isClosed = (date: Date, closures: ForecastClosure[]) => {
  const key = localDateKey(date);
  return closures.some((closure) => key >= closure.start && key <= closure.end);
};

function balanceGoalDate(targetCents: number, balanceCents: number, weekdayPaces: number[], closures: ForecastClosure[], today: Date) {
  if (balanceCents >= targetCents) return today;
  if (!weekdayPaces.some((pace) => pace > 0)) return null;
  const date = new Date(today);
  let gain = 0;
  for (let days = 0; days < 3650; days++) {
    date.setDate(date.getDate() + 1);
    if (!isClosed(date, closures)) gain += weekdayPaces[date.getDay()];
    if (balanceCents + gain >= targetCents) return date;
  }
  return null;
}

async function api<T = LedgerData>(body?: Record<string, unknown>) {
  const response = await fetch("/api/ledger", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "Something went wrong.");
  return result;
}

export default function DashboardClient({ displayName }: { displayName: string }) {
  const [data, setData] = useState<LedgerData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [activeTab, setActiveTab] = useState("review");
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState("all");
  const [targetAmount, setTargetAmount] = useState("500");
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [forecastDraft, setForecastDraft] = useState<ForecastSettings>(emptyData.forecastSettings);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [movementOpen, setMovementOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [cardDepositOpen, setCardDepositOpen] = useState(false);
  const [reviewName, setReviewName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const result = await api() as LedgerData;
      setData(result);
      setLoadError("");
      setForecastDraft(result.forecastSettings);
      setSelectedGoalId((current) => result.forecastCheckpoints.some((goal) => goal.id === current) ? current : result.forecastCheckpoints[0]?.id ?? null);
    }
    catch (error) { setLoadError(error instanceof Error ? error.message : "Could not load the ledger."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const savedTarget = window.localStorage.getItem("snackbar-outlook-target");
    if (savedTarget) setTargetAmount(savedTarget);
  }, []);
  const post = async (payload: Record<string, unknown>, success: string) => {
    setBusy(true);
    try { const result = await api<Record<string, unknown>>(payload); toast.success(success); await load(); return result; }
    catch (error) { toast.error(error instanceof Error ? error.message : "Something went wrong."); return null; }
    finally { setBusy(false); }
  };
  const refreshAmexAudit = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/ledger/plaid", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "audit", kind: "amex" }) });
      const result = await response.json() as { error?: string; audit: { awaitingReview: boolean; awaitingTransfer: boolean; untransferredVenmoCents: number; audited: boolean } };
      if (!response.ok) throw new Error(result.error || "Could not refresh Amex balance.");
      await load();
      toast.success(result.audit.awaitingReview
        ? "Balance refreshed. Finish reviewing transactions and applying expenses before the audit."
        : result.audit.awaitingTransfer
          ? `Balance refreshed. Audit paused while ${money(result.audit.untransferredVenmoCents)} remains in Venmo or in transit.`
          : result.audit.audited ? "Amex audit saved." : "Amex balance refreshed.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not refresh Amex balance."); }
    finally { setBusy(false); }
  };

  const filtered = useMemo(() => {
    if (period === "all") return data.ledger;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - Number(period));
    return data.ledger.filter((row) => new Date(row.occurredAt) >= cutoff);
  }, [data.ledger, period]);

  const outlook = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const semesterStart = data.forecastSettings.semesterStart ? localDate(data.forecastSettings.semesterStart) : todayStart;
    semesterStart.setHours(0, 0, 0, 0);
    const paceDateKeys: string[] = [];
    const cursor = new Date(todayStart); cursor.setDate(cursor.getDate() - 1);
    while (cursor >= semesterStart && paceDateKeys.length < 14) {
      if (!isClosed(cursor, data.forecastSettings.closures)) paceDateKeys.push(localDateKey(cursor));
      cursor.setDate(cursor.getDate() - 1);
    }
    const paceDates = new Set(paceDateKeys);
    const revenueByDate = new Map<string, number>();
    data.ledger.filter((row) => saleCents(row) > 0 && paceDates.has(businessDate(new Date(row.occurredAt)))).forEach((row) => {
      const key = businessDate(new Date(row.occurredAt));
      revenueByDate.set(key, (revenueByDate.get(key) || 0) + row.amountCents);
    });
    const revenueCents = [...revenueByDate.values()].reduce((sum, value) => sum + value, 0);
    const nonSalesDepositsCents = data.nonSalesDepositsCents;
    const currentBalanceCents = data.openingCardBalanceCents + data.ledger.reduce((sum, row) => sum + row.amountCents, 0) + nonSalesDepositsCents;
    const operatingDays = paceDateKeys.length;
    const dailyRevenueCents = operatingDays ? revenueCents / operatingDays : 0;
    const weekdaySamples = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
    paceDateKeys.forEach((key) => {
      const weekday = localDate(key).getDay();
      weekdaySamples[weekday].total += revenueByDate.get(key) || 0;
      weekdaySamples[weekday].days += 1;
    });
    const weekdayPaces = weekdaySamples.map((sample) => sample.days ? sample.total / sample.days : dailyRevenueCents);
    const confidence = operatingDays < 7 ? "Early estimate" : operatingDays < 14 ? "Developing" : "Established";
    const monthly = Array.from({ length: 4 }, (_, index) => {
      const date = new Date(todayStart.getFullYear(), todayStart.getMonth() + index + 1, 1, 12);
      const future = new Date(todayStart); future.setDate(future.getDate() + 1); future.setHours(12, 0, 0, 0);
      let operatingDaysAhead = 0;
      let projectedRevenueCents = 0;
      while (future < date) {
        if (!isClosed(future, data.forecastSettings.closures)) {
          operatingDaysAhead += 1;
          projectedRevenueCents += weekdayPaces[future.getDay()];
        }
        future.setDate(future.getDate() + 1);
      }
      const todayUtc = Date.UTC(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate());
      const dateUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
      const days = Math.max(0, Math.round((dateUtc - todayUtc) / 86_400_000));
      return { days, operatingDays: operatingDaysAhead, date, revenueCents: projectedRevenueCents, balanceCents: currentBalanceCents + projectedRevenueCents };
    });
    return { revenueCents, dailyRevenueCents, weekdayPaces, currentBalanceCents, monthly, operatingDays, confidence };
  }, [data.nonSalesDepositsCents, data.forecastSettings, data.ledger, data.openingCardBalanceCents]);

  const targetProjection = useMemo(() => {
    const targetCents = Math.round(Number(targetAmount) * 100);
    if (!Number.isFinite(targetCents) || targetCents <= 0) return { status: "invalid" as const, targetCents: 0, days: 0, date: null };
    const remainingCents = targetCents - outlook.currentBalanceCents;
    if (remainingCents <= 0) return { status: "reached" as const, targetCents, days: 0, date: new Date() };
    if (outlook.dailyRevenueCents <= 0) return { status: "unavailable" as const, targetCents, days: 0, date: null };
    const date = new Date(); date.setHours(12, 0, 0, 0);
    let projectedGain = 0;
    let calendarDays = 0;
    let operatingDays = 0;
    while (projectedGain < remainingCents && calendarDays < 3650) {
      date.setDate(date.getDate() + 1);
      calendarDays += 1;
      if (!isClosed(date, data.forecastSettings.closures)) {
        operatingDays += 1;
        projectedGain += outlook.weekdayPaces[date.getDay()];
      }
    }
    if (projectedGain < remainingCents) return { status: "unavailable" as const, targetCents, days: 0, operatingDays: 0, date: null };
    return { status: "projected" as const, targetCents, days: calendarDays, operatingDays, date };
  }, [data.forecastSettings.closures, outlook.currentBalanceCents, outlook.dailyRevenueCents, outlook.weekdayPaces, targetAmount]);

  const checkpointProgresses = useMemo(() => data.forecastCheckpoints.map((checkpoint) => {
    const created = new Date(checkpoint.createdAt); created.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const originalDate = localDate(checkpoint.projectedDate); originalDate.setHours(0, 0, 0, 0);
    let plannedBalanceCents = checkpoint.startingBalanceCents;
    const completed = new Date(created); completed.setDate(completed.getDate() + 1);
    while (completed < today) {
      if (!isClosed(completed, checkpoint.closures)) plannedBalanceCents += checkpoint.weekdayPaces[completed.getDay()] ?? checkpoint.dailyRevenueCents;
      completed.setDate(completed.getDate() + 1);
    }
    const varianceCents = outlook.currentBalanceCents - plannedBalanceCents;
    const threshold = Math.max(200, checkpoint.dailyRevenueCents * .15);
    const status = outlook.currentBalanceCents >= checkpoint.targetCents ? "reached" : varianceCents < -threshold ? "behind" : varianceCents > threshold ? "ahead" : "on-pace";
    let remainingOperatingDays = 0;
    const remaining = new Date(today); remaining.setDate(remaining.getDate() + 1);
    while (remaining <= originalDate) {
      if (!isClosed(remaining, checkpoint.closures)) remainingOperatingDays += 1;
      remaining.setDate(remaining.getDate() + 1);
    }
    const requiredDailyCents = remainingOperatingDays > 0 ? Math.max(0, checkpoint.targetCents - outlook.currentBalanceCents) / remainingOperatingDays : null;
    const currentDate = balanceGoalDate(checkpoint.targetCents, outlook.currentBalanceCents, outlook.weekdayPaces, data.forecastSettings.closures, today);
    const dateSlipDays = currentDate ? Math.round((Date.UTC(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()) - Date.UTC(originalDate.getFullYear(), originalDate.getMonth(), originalDate.getDate())) / 86_400_000) : null;

    const changes = new Map<string, number>();
    data.ledger.forEach((row) => {
      const effective = new Date(row.reviewedAt || row.createdAt);
      if (effective >= new Date(checkpoint.createdAt)) {
        const key = localDateKey(effective);
        changes.set(key, (changes.get(key) || 0) + row.amountCents);
      }
    });
    data.nonSalesDeposits.forEach((deposit) => {
      if (!deposit.occurredAt || new Date(deposit.occurredAt) < new Date(checkpoint.createdAt)) return;
      const key = businessDate(new Date(deposit.occurredAt));
      changes.set(key, (changes.get(key) || 0) + deposit.amountCents);
    });
    const chartEnd = originalDate > today ? originalDate : today;
    const chart: Array<{ label: string; plan: number; actual: number | null }> = [];
    let plan = checkpoint.startingBalanceCents;
    let actual = checkpoint.startingBalanceCents;
    const cursor = new Date(created);
    while (cursor <= chartEnd) {
      if (cursor > created && !isClosed(cursor, checkpoint.closures)) plan += checkpoint.weekdayPaces[cursor.getDay()] ?? checkpoint.dailyRevenueCents;
      if (cursor <= today) actual += changes.get(localDateKey(cursor)) || 0;
      const isToday = localDateKey(cursor) === localDateKey(today);
      chart.push({ label: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(cursor), plan: Math.min(plan, checkpoint.targetCents) / 100, actual: cursor <= today ? (isToday ? outlook.currentBalanceCents : actual) / 100 : null });
      cursor.setDate(cursor.getDate() + 1);
    }
    return { checkpoint, plannedBalanceCents, varianceCents, status, requiredDailyCents, currentDate, dateSlipDays, chart };
  }), [data.forecastCheckpoints, data.ledger, data.nonSalesDeposits, data.forecastSettings.closures, outlook.currentBalanceCents, outlook.weekdayPaces]);
  const checkpointProgress = checkpointProgresses.find((progress) => progress.checkpoint.id === selectedGoalId);

  const outlookChartData = useMemo(() => [
    { label: "Now", balance: outlook.currentBalanceCents / 100 },
    ...outlook.monthly.map((projection) => ({
      label: new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" }).format(projection.date),
      balance: projection.balanceCents / 100,
    })),
  ], [outlook]);

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const file = fileRef.current?.files?.[0];
    if (!file) return toast.error("Choose a Venmo CSV first.");
    const csv = await file.text();
    setBusy(true);
    try {
      let finalizePreviousMonth = false;
      while (true) {
        const response = await fetch("/api/ledger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "import", csv, fileName: file.name, finalizePreviousMonth }),
        });
        const result = await response.json() as { error?: string; requiresMonthFinalize?: boolean; closingMonthLabel?: string; incomingMonthLabel?: string };
        if (response.status === 409 && result.requiresMonthFinalize && !finalizePreviousMonth) {
          const confirmed = window.confirm(
            `This statement contains ${result.incomingMonthLabel || "a new month"} purchases.\n\nBefore locking ${result.closingMonthLabel || "the previous month"} awards, make sure its latest Venmo CSV is already uploaded and every transaction is reviewed.\n\nFinalize the month and continue?`,
          );
          if (!confirmed) return;
          finalizePreviousMonth = true;
          continue;
        }
        if (!response.ok) throw new Error(result.error || "The Venmo statement could not be imported.");
        toast.success("Venmo statement imported.");
        await load();
        setUploadOpen(false);
        if (fileRef.current) fileRef.current.value = "";
        return;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const manual = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    const result = await post({ action: "manual", amount: form.get("amount"), date: form.get("date"), direction: form.get("direction"), source: form.get("source"), counterparty: form.get("counterparty"), note: form.get("note"), countTowardAwards: form.get("countTowardAwards") === "on" }, "Ledger entry added.");
    if (result) { setManualOpen(false); formElement.reset(); }
  };

  const cashCount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    const result = await post({ action: "cash_count", bills: form.get("bills"), coins: form.get("coins"), note: form.get("note") }, "Cash box counted and ledger updated.");
    if (result) formElement.reset();
  };

  const cashMovement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    const result = await post({ action: "cash_adjustment", eventType: form.get("eventType"), amount: form.get("amount"), note: form.get("note") }, "Cash movement recorded.");
    if (result) { setMovementOpen(false); formElement.reset(); }
  };

  const cashToCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    const result = await post({ action: "cash_to_card", amount: form.get("amount"), note: form.get("note") }, "Cash-to-card transfer recorded.");
    if (result) { setTransferOpen(false); formElement.reset(); }
  };

  const cardAudit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const resetBaseline = submitter?.value === "baseline";
    if (resetBaseline && !window.confirm("Use this balance as a new audit starting point? This accepts the current difference and starts future checks from this amount.")) return;
    const result = await post({ action: resetBaseline ? "card_baseline" : "card_audit", balance: form.get("balance") }, resetBaseline ? "New card baseline saved." : "Card audit saved.");
    if (result) formElement.reset();
  };

  const cardDeposit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    const result = await post({ action: "card_adjustment", amount: form.get("amount"), note: form.get("note") }, "Non-sales deposit added to the card balance.");
    if (result) { setCardDepositOpen(false); formElement.reset(); }
  };

  const applyCardOutflow = async (transactionId: string) => {
    await post({ action: "card_outflow_apply", transactionId }, "Expense applied to the card audit.");
  };

  const saveForecastSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await post({ action: "forecast_settings", semesterStart: forecastDraft.semesterStart, closures: forecastDraft.closures }, "Forecast settings saved.");
    if (result) setForecastDraft((current) => ({ ...current, updatedAt: String(result.updatedAt) }));
  };

  const trackForecastGoal = async () => {
    if (targetProjection.status !== "projected" || !targetProjection.date) return;
    await post({
      action: "forecast_checkpoint",
      targetCents: targetProjection.targetCents,
      startingBalanceCents: Math.round(outlook.currentBalanceCents),
      dailyRevenueCents: Math.round(outlook.dailyRevenueCents),
      weekdayPaces: outlook.weekdayPaces.map(Math.round),
      projectedDate: localDateKey(targetProjection.date),
      closures: data.forecastSettings.closures,
    }, "Another goal is now being tracked.");
  };

  const deleteForecastGoal = async (id: string) => {
    if (!window.confirm("Remove this tracked goal and its saved forecast?")) return;
    await post({ action: "forecast_checkpoint_delete", id }, "Tracked goal removed.");
  };

  const addClosure = () => {
    const today = localDateKey(new Date());
    setForecastDraft((current) => ({ ...current, closures: [...current.closures, { id: crypto.randomUUID(), label: "", start: today, end: today }] }));
  };

  const updateClosure = (id: string, field: "label" | "start" | "end", value: string) => {
    setForecastDraft((current) => ({ ...current, closures: current.closures.map((closure) => closure.id === id ? { ...closure, [field]: value } : closure) }));
  };

  const review = async (classification: "snack_bar" | "personal" | "card_transfer" | "card_deposit" | "card_confirmed" | "card_refund") => {
    const current = data.pending[0]; if (!current) return;
    const message = classification === "snack_bar" ? current.amountCents < 0 ? "Expense approved. Apply it in Card audit." : "Sale confirmed."
      : classification === "personal" ? "Marked personal. Provisional sale removed from totals."
      : classification === "card_transfer" ? "Venmo transfer added to the card audit, not sales."
      : classification === "card_refund" ? "Refund recorded against expenses."
      : classification === "card_confirmed" ? "Confirmed without adding another deposit."
      : "Deposit added to the card audit, not sales.";
    const result = await post({ action: "review", ids: [current.id], classification, ...(classification === "snack_bar" ? { counterparty: (reviewName ?? current.counterparty).trim() } : {}) }, message);
    if (result) setReviewName(null);
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this ledger entry?")) return;
    await post({ action: "delete", id }, "Ledger entry deleted.");
  };

  const current = data.pending[0];
  const latestCount = data.cashEvents.find((x) => x.eventType === "count");
  const latestCountHasBreakdown = Boolean(latestCount && latestCount.amountCents === latestCount.billsCents + latestCount.coinsCents);
  const latestAudit = data.cardAudit.lastAudit;
  const varianceClass = !latestAudit || latestAudit.varianceCents === 0 ? "even" : latestAudit.varianceCents < 0 ? "short" : "over";

  return (
    <div className="app-shell">
      <header className="masthead">
        <div className="mast-inner">
          <div className="brand-lockup"><div className="brand-stamp"><ShoppingBasket /></div><div><span className="unit-tag">DET 930</span><h1>Snack Bar</h1></div></div>
          <div className="top-actions"><span className="welcome">Hey, {displayName}</span><Button variant="outline" onClick={() => window.location.assign("/cdn-cgi/access/logout")}><LogOut/> Log out</Button><Button variant="outline" onClick={() => setManualOpen(true)}><Plus/> Manual entry</Button><Button className="upload-button" onClick={() => setUploadOpen(true)}><Upload/> Import Venmo</Button></div>
        </div>
      </header>

      <main className="workspace">
        {loadError && <div className="overview-error">{loadError} <Button variant="outline" onClick={() => void load()}>Retry</Button></div>}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="nav-strip">
            <TabsList variant="line">
              <a className="overview-nav-link" href="/"><BarChart3/> Overview</a>
              <TabsTrigger value="review"><ClipboardCheck/> Review <span className="count-pill">{data.pending.length}</span></TabsTrigger>
              <TabsTrigger value="cash"><Banknote/> Cash box</TabsTrigger>
              <TabsTrigger value="card"><CreditCard/> Card audit</TabsTrigger>
              <TabsTrigger value="connections"><CreditCard/> Connections</TabsTrigger>
              <TabsTrigger value="outlooks"><Target/> Outlooks</TabsTrigger>
              <TabsTrigger value="ledger"><ReceiptText/> Ledger</TabsTrigger>
            </TabsList>
            {activeTab === "ledger" && <label className="period-control">View <select value={period} onChange={(e) => setPeriod(e.target.value)}><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="all">All time</option></select></label>}
          </div>

          <TabsContent value="review" className="section-stack">
            <div className="page-heading"><div><span className="eyebrow">ONE AT A TIME</span><h2>Transaction review</h2><p>Incoming Venmos count as snack-bar sales until you mark them personal. Review each one when you can.</p></div><div className="review-progress"><strong>{data.pending.length}</strong><span>left to review</span></div></div>
            {loading ? <Loading/> : current ? <div className="review-stage"><article className="review-ticket">
              <div className="ticket-top"><Badge variant="outline">{current.source}</Badge><span>{shortDate(current.occurredAt)}</span></div>
              <div className={`review-amount ${current.amountCents >= 0 ? "positive" : "negative"}`}>{money(current.amountCents)}</div>
              <div className="review-person"><div className={`direction-icon ${current.amountCents >= 0 ? "in" : "out"}`}>{current.amountCents >= 0 ? <ArrowDownRight/> : <ArrowUpRight/>}</div><div><span>{current.amountCents >= 0 ? "From" : "To"}</span><h3>{current.counterparty || "Unknown person"}</h3></div></div>
              <div className="review-note"><span>{current.source === "amex" ? "AMEX DESCRIPTION" : "VENMO NOTE"}</span><p>{current.note || "No details included"}</p></div>
              {current.source === "amex" && current.amountCents > 0
                ? <p className="privacy-note">Choose what arrived. Use Already recorded for a deposit or transfer you entered earlier.</p>
                : <div className="review-name"><Label htmlFor="review-name">{current.source === "amex" ? "Merchant" : "Payer name"}</Label><Input id="review-name" value={reviewName ?? current.counterparty} onChange={(event) => setReviewName(event.target.value)} placeholder="Enter the correct name"/></div>}
              <div className="review-actions">
                {current.source === "amex" && current.amountCents > 0 ? <>
                  <Button size="lg" disabled={busy} onClick={() => void review("card_transfer")}>Venmo transfer</Button>
                  <Button variant="outline" size="lg" disabled={busy} onClick={() => void review("card_deposit")}>Donation / added funds</Button>
                  <Button variant="outline" size="lg" disabled={busy} onClick={() => void review("card_refund")}>Purchase refund</Button>
                  <Button variant="outline" size="lg" disabled={busy} onClick={() => void review("card_confirmed")}>Already recorded</Button>
                  <Button variant="outline" size="lg" disabled={busy} onClick={() => void review("personal")}><UserRound/> Ignore</Button>
                </> : <>
                  <Button variant="outline" size="lg" disabled={busy} onClick={() => void review("personal")}><UserRound/> Personal</Button>
                  <Button size="lg" disabled={busy} onClick={() => void review("snack_bar")}>{busy ? <Loader2 className="spin"/> : <Check/>} {current.source === "amex" ? "Approve expense" : "Confirm snack bar"}</Button>
                </>}
              </div>
              {!(current.source === "amex" && current.amountCents > 0) && <p className="privacy-note">Personal entries are permanently excluded.</p>}
            </article></div> : loadError ? null : <div className="all-clear"><Check/><h2>All caught up.</h2><p>No transactions waiting for review.</p></div>}
          </TabsContent>

          <TabsContent value="connections" className="section-stack" forceMount>
            <PlaidConnections onChanged={load}/>
          </TabsContent>

          <TabsContent value="cash" className="section-stack">
            <div className="page-heading"><div><span className="eyebrow">PHYSICAL CASH</span><h2>Cash box</h2><p>Count the box after recording any cash movements.</p></div><div className="cash-actions"><Button onClick={() => setTransferOpen(true)}><WalletCards/> Transfer cash to card</Button><Dialog open={movementOpen} onOpenChange={setMovementOpen}><DialogTrigger asChild><Button variant="outline"><RotateCcw/> Record cash movement</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Record cash movement</DialogTitle><DialogDescription>Record cash moved without a sale. For a cash purchase, use Manual entry with source Cash.</DialogDescription></DialogHeader><form id="movement-form" className="form-grid" onSubmit={cashMovement}><div><Label htmlFor="eventType">Movement</Label><select className="native-select" id="eventType" name="eventType"><option value="withdrawal">Removed from box</option><option value="deposit">Added to box</option></select></div><div><Label htmlFor="move-amount">Amount</Label><Input id="move-amount" name="amount" inputMode="decimal" placeholder="0.00" required/></div><div className="full"><Label htmlFor="move-note">Note</Label><Input id="move-note" name="note" placeholder="Starting change, cash moved…"/></div></form><DialogFooter><Button type="submit" form="movement-form" disabled={busy}>Save movement</Button></DialogFooter></DialogContent></Dialog></div></div>
            <section className="cash-grid"><article className="cash-count-card"><div className="count-date"><CalendarDays/><span>Counting now<br/><b>{new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(new Date())}</b></span></div><form onSubmit={cashCount}><div className="cash-count-parts"><div><Label htmlFor="cash-bills">Bills</Label><div className="money-input compact"><span>$</span><Input id="cash-bills" name="bills" inputMode="decimal" placeholder="0.00" required autoComplete="off"/></div></div><div><Label htmlFor="cash-coins">Coins <small>{latestCountHasBreakdown || !latestCount ? "optional" : "count once"}</small></Label><div className="money-input compact"><span>$</span><Input id="cash-coins" name="coins" inputMode="decimal" placeholder={latestCountHasBreakdown && latestCount ? (latestCount.coinsCents / 100).toFixed(2) : "0.00"} autoComplete="off"/></div><small>{latestCountHasBreakdown && latestCount ? `Leave blank to keep ${money(latestCount.coinsCents)}.` : latestCount ? "Enter coins this time to establish the split." : "Leave blank to use $0.00."}</small></div></div><Label htmlFor="cash-note">Note <small>optional</small></Label><Input id="cash-note" name="note" placeholder="End of day count"/><Button size="lg" disabled={busy}>{busy ? <Loader2 className="spin"/> : <Banknote/>} Count it & update ledger</Button></form></article><article className="balance-board"><span className="eyebrow light">LAST COUNT</span><strong>{latestCount ? money(latestCount.amountCents) : "—"}</strong><p>{latestCount ? dateTime(latestCount.occurredAt) : "No cash counts yet"}</p>{latestCount && latestCountHasBreakdown ? <div className="cash-balance-parts"><span>Bills <b>{money(latestCount.billsCents)}</b></span><span>Coins <b>{money(latestCount.coinsCents)}</b></span></div> : latestCount ? <p className="cash-split-pending">Bill and coin tracking begins with the next count.</p> : null}{latestCount && <div className={latestCount.calculatedChangeCents >= 0 ? "count-change up" : "count-change down"}><span>Ledger change</span><b>{money(latestCount.calculatedChangeCents)}</b></div>}</article></section>
            <History title="Cash box history">{data.cashEvents.length ? data.cashEvents.map((event) => <div className="history-row" key={event.id}><div className="history-icon"><Banknote/></div><div><strong>{event.eventType === "count" ? "Cash count" : event.eventType === "withdrawal" ? "Cash removed" : "Cash added"}</strong><span>{dateTime(event.occurredAt)}{event.eventType === "count" && event.amountCents === event.billsCents + event.coinsCents ? ` · ${money(event.billsCents)} bills + ${money(event.coinsCents)} coins` : ""}{event.note ? ` · ${event.note}` : ""}</span></div><b>{money(event.amountCents)}</b>{event.eventType === "count" && <em>{money(event.calculatedChangeCents)} to ledger</em>}</div>) : <Empty text="Cash counts and movements will appear here."/>}</History>
          </TabsContent>

          <TabsContent value="card" className="section-stack">
            <div className="page-heading"><div><span className="eyebrow">RECONCILIATION</span><h2>Card audit</h2><p>Compare the expected balance with Amex checking.</p></div><Button variant="outline" onClick={() => setCardDepositOpen(true)}><HandCoins/> Add non-sales deposit</Button></div>
            <section className="audit-grid"><article className="audit-form-card"><div className="expected-chip"><span>{data.cardAudit.hasBaseline ? "Expected balance" : "First audit"}</span><strong>{data.cardAudit.hasBaseline ? money(data.cardAudit.expectedBalanceCents) : "Sets baseline"}</strong></div>{data.cardAudit.hasBaseline && <div className="audit-breakdown"><span>Since last audit</span><b>{data.cardAudit.usesAmexTransfers ? "Venmo transfers received" : "Venmo sales"} {money(data.cardAudit.ledgerMovementCents)}</b>{data.cardAudit.untransferredVenmoCents > 0 && <b>Still in Venmo / in transit {money(data.cardAudit.untransferredVenmoCents)}</b>}{data.cardAudit.otherDepositCents !== 0 && <b>Deposits / refunds {money(data.cardAudit.otherDepositCents)}</b>}<b>Applied card expenses {money(data.cardAudit.cardOutflowCents)}</b><b>Manual deposits / cash transfers {money(data.cardAudit.adjustmentCents)}</b></div>}{data.cardAudit.usesAmexTransfers && <div className="amex-balance"><strong>Amex checking: {data.cardAudit.plaidBalanceCents === null ? "Waiting for balance" : money(data.cardAudit.plaidBalanceCents)}</strong><p>{data.cardAudit.plaidBalanceCheckedAt ? `Checked ${dateTime(data.cardAudit.plaidBalanceCheckedAt)}. ` : ""}{data.cardAudit.awaitingReview ? "Finish Review and apply card expenses to resume audits." : data.cardAudit.awaitingTransfer ? `Automatic audit paused while ${money(data.cardAudit.untransferredVenmoCents)} remains in Venmo or in transit.` : "Automatic audits run after Amex sync."}</p><Button variant="outline" disabled={busy} onClick={() => void refreshAmexAudit()}>Refresh Amex balance</Button></div>}<details><summary>Enter balance manually</summary><form onSubmit={cardAudit}><Label htmlFor="card-balance">Current Amex checking balance</Label><div className="money-input"><span>$</span><Input id="card-balance" name="balance" inputMode="decimal" placeholder="0.00" required autoComplete="off"/></div><Button size="lg" disabled={busy}>{busy ? <Loader2 className="spin"/> : <ClipboardCheck/>} {data.cardAudit.hasBaseline ? "Run the audit" : "Set starting balance"}</Button>{data.cardAudit.hasBaseline && <Button type="submit" name="mode" value="baseline" variant="ghost" disabled={busy}>Use this as a new baseline</Button>}</form></details></article><article className={`audit-result ${varianceClass}`}><span className="eyebrow light">LATEST RESULT</span>{latestAudit ? <><div className="audit-status">{latestAudit.varianceCents === 0 ? "BALANCED" : latestAudit.varianceCents < 0 ? "SHORT" : "OVER"}</div><strong>{money(Math.abs(latestAudit.varianceCents))}</strong><div className="audit-pair"><span>Actual <b>{money(latestAudit.actualBalanceCents)}</b></span><span>Expected <b>{money(latestAudit.expectedBalanceCents)}</b></span></div><p>{dateTime(latestAudit.checkedAt)}</p></> : <><WalletCards/><h3>No baseline yet</h3><p>The first automatic balance reading starts tracking after review is clear.</p></>}</article></section>
            {data.pendingCardOutflows.length > 0 && <History title="Expenses to apply"><div className="outflow-explainer">Apply each expense once it has posted to Amex. Remove any duplicate manual entry first.</div>{data.pendingCardOutflows.map((row) => <div className="history-row pending-outflow" key={row.id}><div className="history-icon"><CreditCard/></div><div><strong>{row.note || row.counterparty || "Card expense"}</strong><span>{shortDate(row.occurredAt)} · {row.counterparty || "Ledger expense"}</span></div><b>{money(row.amountCents)}</b><Button size="sm" variant="outline" disabled={busy} onClick={() => void applyCardOutflow(row.id)}>Apply to card</Button></div>)}</History>}
            <History title="Audit history">{data.cardAudit.history.length ? data.cardAudit.history.map((audit) => <div className="history-row audit-history" key={audit.id}><div className={`status-dot ${audit.varianceCents === 0 ? "even" : audit.varianceCents < 0 ? "short" : "over"}`}/><div><strong>{dateTime(audit.checkedAt)} · {audit.source === "plaid" ? "Automatic" : "Manual"}</strong><span>Expected {money(audit.expectedBalanceCents)} · actual {money(audit.actualBalanceCents)}</span></div><b>{audit.varianceCents === 0 ? "Balanced" : `${audit.varianceCents > 0 ? "+" : "−"}${money(Math.abs(audit.varianceCents))}`}</b></div>) : <Empty text="Completed card audits will appear here."/>}</History>
            {data.cardAudit.adjustments.length > 0 && <History title="Manual deposits and transfers">{data.cardAudit.adjustments.map((adjustment) => <div className="history-row" key={adjustment.id}><div className="history-icon"><HandCoins/></div><div><strong>{adjustment.note || "Non-sales deposit"}</strong><span>{dateTime(adjustment.occurredAt)} · {adjustment.kind === "cash_transfer" ? "Cash transfer" : "Added funds"}</span></div><b>{money(adjustment.amountCents)}</b></div>)}</History>}
          </TabsContent>

          <TabsContent value="outlooks" className="section-stack">
            <div className="page-heading"><div><span className="eyebrow">AUTOMATIC FORECAST</span><h2>Outlook</h2><p>Forecasts follow your recent weekday sales. Future purchases are not included.</p></div></div>
            <section className="outlook-summary"><div><span className="eyebrow light">CURRENT OPERATING BALANCE</span><strong>{money(outlook.currentBalanceCents)}</strong><p>Funds tracked across the snack bar</p></div><div className="pace-callout"><span>Current revenue pace</span><b className="positive">{money(outlook.dailyRevenueCents)}/day</b><em>{outlook.confidence} · {outlook.operatingDays} of 14 days</em></div></section>
            {data.ledger.length ? <section className="outlook-grid monthly-outlook-grid">{outlook.monthly.map((projection) => <ProjectionCard key={projection.date.toISOString()} projection={projection}/>)}</section> : <article className="panel"><Empty text="The forecast will appear after transactions are approved."/></article>}
            <article className="panel target-panel"><div className="panel-heading"><div><span className="eyebrow">BALANCE GOAL</span><h2>When will we reach it?</h2></div></div><div className="target-layout"><label className="target-control" htmlFor="outlook-target"><span>Target balance</span><div><b>$</b><Input id="outlook-target" type="number" min="0.01" step="0.01" inputMode="decimal" value={targetAmount} onChange={(event) => { setTargetAmount(event.target.value); window.localStorage.setItem("snackbar-outlook-target", event.target.value); }}/></div></label><div className={`target-result ${targetProjection.status}`}><span>{targetProjection.status === "reached" ? "GOAL STATUS" : "ESTIMATED DATE"}</span><strong>{targetProjection.status === "projected" && targetProjection.date ? new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(targetProjection.date) : targetProjection.status === "reached" ? "Already reached" : targetProjection.status === "unavailable" ? "Not enough data" : "Enter a target"}</strong><p>{targetProjection.status === "projected" ? `${targetProjection.operatingDays} operating days over ${targetProjection.days} calendar days` : targetProjection.status === "reached" ? `${money(outlook.currentBalanceCents)} is already above ${money(targetProjection.targetCents)}` : targetProjection.status === "unavailable" ? "Approved revenue is needed before a date can be estimated." : "Use an amount greater than zero."}</p></div></div><div className="target-actions"><Button disabled={busy || targetProjection.status !== "projected"} onClick={() => void trackForecastGoal()}>{busy ? <Loader2 className="spin"/> : <Target/>} Track goal</Button></div></article>
            {checkpointProgresses.length > 0 && <div className="goal-list"><div className="panel-heading"><div><span className="eyebrow">TRACKED GOALS</span><h2>Your outlooks</h2></div></div><div className="goal-grid">{checkpointProgresses.map((progress) => <button type="button" key={progress.checkpoint.id} className={`goal-tile ${progress.status} ${selectedGoalId === progress.checkpoint.id ? "selected" : ""}`} onClick={() => setSelectedGoalId(progress.checkpoint.id)}><span>{progress.status === "reached" ? "Goal reached" : progress.status === "behind" ? "Behind plan" : progress.status === "ahead" ? "Ahead of plan" : "On pace"}</span><strong>{money(progress.checkpoint.targetCents)}</strong><small>Original estimate {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(localDate(progress.checkpoint.projectedDate))}</small></button>)}</div></div>}
            {checkpointProgress && <article className={`panel checkpoint-panel ${checkpointProgress.status}`}><div className="panel-heading"><div><span className="eyebrow">LOCKED FORECAST</span><h2>Are we following the outlook?</h2><p>Original plan saved {dateTime(checkpointProgress.checkpoint.createdAt)}.</p></div><div className="goal-detail-actions"><Badge variant="outline">{checkpointProgress.status === "reached" ? "Goal reached" : checkpointProgress.status === "behind" ? "Behind plan" : checkpointProgress.status === "ahead" ? "Ahead of plan" : "On pace"}</Badge><Button variant="outline" size="sm" disabled={busy} onClick={() => void deleteForecastGoal(checkpointProgress.checkpoint.id)}>Remove goal</Button></div></div><div className="checkpoint-stats"><div><span>Original estimate</span><strong>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(localDate(checkpointProgress.checkpoint.projectedDate))}</strong></div><div><span>Current estimate</span><strong>{checkpointProgress.currentDate ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(checkpointProgress.currentDate) : "Unavailable"}</strong><small>{checkpointProgress.dateSlipDays === null ? "No current estimate" : checkpointProgress.dateSlipDays === 0 ? "No change" : `${Math.abs(checkpointProgress.dateSlipDays)} day${Math.abs(checkpointProgress.dateSlipDays) === 1 ? "" : "s"} ${checkpointProgress.dateSlipDays > 0 ? "later" : "earlier"}`}</small></div><div><span>Against original plan</span><strong>{checkpointProgress.varianceCents >= 0 ? "+" : "−"}{money(Math.abs(checkpointProgress.varianceCents))}</strong><small>Plan called for {money(checkpointProgress.plannedBalanceCents)} by now</small></div><div><span>Average needed now</span><strong>{checkpointProgress.requiredDailyCents === null ? "Past due" : `${money(checkpointProgress.requiredDailyCents)}/day`}</strong><small>Current average is {money(outlook.dailyRevenueCents)}/day</small></div></div><div className="checkpoint-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={checkpointProgress.chart} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#dde2de"/><XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={30}/><YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={58}/><Tooltip formatter={(value, name) => [money(Number(value) * 100), name === "plan" ? "Original forecast" : "Actual balance"]}/><Line type="monotone" dataKey="plan" name="plan" stroke="#9b7858" strokeWidth={2} strokeDasharray="7 5" dot={false}/><Line type="monotone" dataKey="actual" name="actual" stroke="#356859" strokeWidth={3} dot={false} connectNulls={false}/></LineChart></ResponsiveContainer></div><div className="checkpoint-legend"><span><i className="plan"/> Original forecast</span><span><i className="actual"/> Actual balance</span></div></article>}
            <article className="panel outlook-chart-panel"><div className="panel-heading"><div><span className="eyebrow">MONTHLY PATH</span><h2>Balance at the start of each month</h2><p>Projected sales added to the current balance.</p></div></div><div className="outlook-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={outlookChartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#dde2de"/><XAxis dataKey="label" tickLine={false} axisLine={false}/><YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={58}/><Tooltip formatter={(value) => [money(Number(value) * 100), "Projected balance"]}/><Line type="monotone" dataKey="balance" stroke="#356859" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }}/></LineChart></ResponsiveContainer></div></article>
            <article className="panel forecast-settings"><div className="panel-heading"><div><span className="eyebrow">FORECAST SETTINGS</span><h2>Semester and closures</h2><p>Closures pause projected sales.</p></div></div><form onSubmit={saveForecastSettings}><div className="forecast-basics"><label><span>Current semester started</span><Input type="date" required value={forecastDraft.semesterStart} onChange={(event) => setForecastDraft((current) => ({ ...current, semesterStart: event.target.value }))}/></label><div><span>Normal operating days</span><strong>Sunday–Saturday</strong></div></div><div className="closure-heading"><div><strong>Scheduled closures</strong><span>Winter break, spring break, or any period with no sales</span></div><Button type="button" variant="outline" onClick={addClosure}><Plus/> Add closure</Button></div>{forecastDraft.closures.length ? <div className="closure-list">{forecastDraft.closures.map((closure) => <div className="closure-row" key={closure.id}><label><span>Name</span><Input value={closure.label} placeholder="Winter break" onChange={(event) => updateClosure(closure.id, "label", event.target.value)}/></label><label><span>First closed day</span><Input type="date" required value={closure.start} onChange={(event) => updateClosure(closure.id, "start", event.target.value)}/></label><label><span>Last closed day</span><Input type="date" required min={closure.start} value={closure.end} onChange={(event) => updateClosure(closure.id, "end", event.target.value)}/></label><Button type="button" variant="ghost" size="icon-sm" aria-label="Remove closure" onClick={() => setForecastDraft((current) => ({ ...current, closures: current.closures.filter((item) => item.id !== closure.id) }))}><Trash2/></Button></div>)}</div> : <p className="no-closures">No closures scheduled. Revenue will be projected every day.</p>}<div className="forecast-save"><span>{data.forecastSettings.updatedAt ? `Last saved ${dateTime(data.forecastSettings.updatedAt)}` : "Not saved yet"}</span><Button disabled={busy}>{busy ? <Loader2 className="spin"/> : <Check/>} Save forecast settings</Button></div></form></article>
            <article className="panel forecast-method"><div><span>14-day revenue pace</span><strong>{money(outlook.dailyRevenueCents * 7)} / week</strong></div><div><span>Future expenses assumed</span><strong>$0</strong></div><p>Uses up to 14 completed days, with a separate pace for each weekday. Closed days are skipped.</p></article>
          </TabsContent>

          <TabsContent value="ledger" className="section-stack">
            <div className="page-heading"><div><span className="eyebrow">ACTIVITY</span><h2>The ledger</h2><p>Sales (including unreviewed Venmos), purchases, refunds, and cash activity.</p></div><Button onClick={() => setManualOpen(true)}><Plus/> Manual entry</Button></div>
<article className="panel table-panel">{loading ? <Loading/> : filtered.length ? <Table><TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Source</TableHead><TableHead>Person / account</TableHead><TableHead>Note</TableHead><TableHead className="amount-head">Amount</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader><TableBody>{filtered.map((row) => <TableRow key={row.id}><TableCell>{shortDate(row.occurredAt)}</TableCell><TableCell><Badge variant="outline">{row.classification === "card_refund" ? "refund" : row.classification === "pending" ? "venmo · unreviewed" : row.source}</Badge></TableCell><TableCell>{row.counterparty || "—"}</TableCell><TableCell className="note-cell">{row.note || "—"}</TableCell><TableCell className={`amount-cell ${row.amountCents >= 0 ? "positive" : "negative"}`}>{money(row.amountCents)}</TableCell><TableCell>{row.classification !== "pending" && <Button variant="ghost" size="icon-sm" aria-label="Delete transaction" disabled={busy} onClick={() => void remove(row.id)}><Trash2/></Button>}</TableCell></TableRow>)}</TableBody></Table> : <Empty text="No sales or expenses in this period."/>}</article>
            {data.batches.length > 0 && <History title="Recent imports">{data.batches.map((batch) => <div className="history-row" key={batch.id}><div className="history-icon"><Upload/></div><div><strong>{batch.fileName}</strong><span>{dateTime(batch.createdAt)}</span></div><b>{batch.importedCount} imported</b><em>{batch.duplicateCount} duplicates · {batch.skippedCount} skipped</em></div>)}</History>}
          </TabsContent>
        </Tabs>
      </main>

      <footer><span>SNACK BAR · DET 930</span><span>{data.personalCount} excluded entr{data.personalCount === 1 ? "y" : "ies"}</span></footer>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}><DialogContent><DialogHeader><DialogTitle>Import a Venmo statement</DialogTitle><DialogDescription>Upload the CSV exactly as Venmo provides it. Only money received is imported; outgoing payments and duplicates are ignored.</DialogDescription></DialogHeader><form id="upload-form" className="upload-form" onSubmit={upload}><label className="drop-zone"><Upload/><strong>Choose your Venmo CSV</strong><span>CSV only · up to 8 MB</span><Input ref={fileRef} type="file" accept=".csv,text/csv" required/></label></form><DialogFooter><Button type="submit" form="upload-form" disabled={busy}>{busy ? <Loader2 className="spin"/> : <Upload/>} Import transactions</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={transferOpen} onOpenChange={setTransferOpen}><DialogContent><DialogHeader><DialogTitle>Transfer cash to the card</DialogTitle><DialogDescription>Record once the cash deposit has posted to Amex. Choose Already recorded when its matching Amex entry appears.</DialogDescription></DialogHeader><form id="cash-transfer-form" className="form-grid" onSubmit={cashToCard}><div><Label htmlFor="cash-transfer-amount">Amount transferred</Label><Input id="cash-transfer-amount" name="amount" inputMode="decimal" placeholder="0.00" required autoComplete="off"/></div><div><Label htmlFor="cash-transfer-note">Note</Label><Input id="cash-transfer-note" name="note" placeholder="Cash deposit to card"/></div></form><DialogFooter><Button type="submit" form="cash-transfer-form" disabled={busy}>{busy ? <Loader2 className="spin"/> : <WalletCards/>} Record transfer</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={cardDepositOpen} onOpenChange={setCardDepositOpen}><DialogContent><DialogHeader><DialogTitle>Add a non-sales deposit</DialogTitle><DialogDescription>Record funds already received by Amex. If you enter them here, choose Already recorded on the matching Amex deposit.</DialogDescription></DialogHeader><form id="card-deposit-form" className="form-grid" onSubmit={cardDeposit}><div><Label htmlFor="card-deposit-amount">Amount</Label><Input id="card-deposit-amount" name="amount" inputMode="decimal" placeholder="0.00" required/></div><div><Label htmlFor="card-deposit-note">Description</Label><Input id="card-deposit-note" name="note" placeholder="Donation, starting funds…"/></div></form><DialogFooter><Button type="submit" form="card-deposit-form" disabled={busy}>{busy ? <Loader2 className="spin"/> : <HandCoins/>} Add deposit</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={manualOpen} onOpenChange={setManualOpen}><DialogContent><DialogHeader><DialogTitle>Add a manual ledger entry</DialogTitle><DialogDescription>Use only for activity not already recorded or awaiting import. Cash entries also update the next cash count.</DialogDescription></DialogHeader><form id="manual-form" className="form-grid" onSubmit={manual}><div><Label htmlFor="manual-date">Date</Label><Input id="manual-date" name="date" type="date" defaultValue={businessDate()} max={businessDate()} required/></div><div><Label htmlFor="manual-amount">Amount</Label><Input id="manual-amount" name="amount" inputMode="decimal" placeholder="0.00" required/></div><div><Label htmlFor="manual-direction">Direction</Label><select className="native-select" id="manual-direction" name="direction"><option value="incoming">Money in</option><option value="outgoing">Money out</option></select></div><div><Label htmlFor="manual-source">Source</Label><select className="native-select" id="manual-source" name="source"><option value="manual">Manual</option><option value="cash">Cash</option></select></div><div><Label htmlFor="manual-person">Person / account</Label><Input id="manual-person" name="counterparty" placeholder="Costco, cash customer…"/></div><div><Label htmlFor="manual-note">Note</Label><Input id="manual-note" name="note" placeholder="What was this for?"/></div><label className="award-option full"><input name="countTowardAwards" type="checkbox"/><span><strong>Count toward customer awards</strong><small>Use for a manual customer purchase. Money in and a person’s name are required.</small></span></label></form><DialogFooter><Button type="submit" form="manual-form" disabled={busy}>Add to ledger</Button></DialogFooter></DialogContent></Dialog>
      <Toaster richColors position="bottom-right"/>
    </div>
  );
}

function Empty({ text }: { text: string }) { return <div className="empty-state"><ReceiptText/><strong>Nothing here yet</strong><span>{text}</span></div>; }
function Loading() { return <div className="loading-row"><Loader2 className="spin"/> Loading the books…</div>; }
function History({ title, children }: { title: string; children: React.ReactNode }) { return <article className="panel history-panel"><div className="panel-heading"><div><span className="eyebrow">LOG BOOK</span><h2>{title}</h2></div></div><div className="history-list">{children}</div></article>; }

function ProjectionCard({ projection }: { projection: { days: number; operatingDays: number; date: Date; revenueCents: number; balanceCents: number } }) {
  return <article className="outlook-card">
    <div className="projection-date"><span>START OF {new Intl.DateTimeFormat("en-US", { month: "long" }).format(projection.date).toUpperCase()}</span><strong>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(projection.date)}</strong></div>
    <div className="outlook-amount"><strong>{money(projection.balanceCents)}</strong><span>projected balance</span></div>
    <div className="projection-split"><span>Projected days <b>{projection.operatingDays}</b></span><span>Added revenue <b>{money(projection.revenueCents)}</b></span></div>
  </article>;
}
