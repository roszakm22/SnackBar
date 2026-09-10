"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight, ArrowUpRight, Banknote, BarChart3, CalendarDays, Check,
  CircleDollarSign, ClipboardCheck, CreditCard, HandCoins, Loader2, Plus, ReceiptText,
  RotateCcw, ShoppingBasket, Target, Trash2, Upload, UserRound, WalletCards,
} from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Toaster } from "@/components/ui/sonner";

type Transaction = {
  id: string; occurredAt: string; amountCents: number; source: "venmo" | "cash" | "manual";
  direction: "incoming" | "outgoing"; counterparty: string; note: string; originalType: string;
};
type Batch = { id: string; fileName: string; importedCount: number; duplicateCount: number; skippedCount: number; createdAt: string };
type CashEvent = { id: string; occurredAt: string; eventType: "count" | "withdrawal" | "deposit"; amountCents: number; calculatedChangeCents: number; note: string };
type CardAudit = { id: string; checkedAt: string; actualBalanceCents: number; expectedBalanceCents: number; varianceCents: number; ledgerMovementCents: number };
type CardAdjustment = { id: string; occurredAt: string; amountCents: number; note: string };
type LedgerData = {
  pending: Transaction[]; pendingCardOutflows: Transaction[]; ledger: Transaction[]; personalCount: number; batches: Batch[]; cashEvents: CashEvent[];
  openingCardBalanceCents: number;
  cardAudit: { expectedBalanceCents: number; ledgerMovementCents: number; adjustmentCents: number; cardOutflowCents: number; hasBaseline: boolean; lastAudit: CardAudit | null; history: CardAudit[]; adjustments: CardAdjustment[] };
};

const emptyData: LedgerData = { pending: [], pendingCardOutflows: [], ledger: [], personalCount: 0, batches: [], cashEvents: [], openingCardBalanceCents: 0, cardAudit: { expectedBalanceCents: 0, ledgerMovementCents: 0, adjustmentCents: 0, cardOutflowCents: 0, hasBaseline: false, lastAudit: null, history: [], adjustments: [] } };
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const chartMoney = (dollars: number) => {
  const rounded = Math.abs(dollars) < 10 ? Math.round(dollars * 100) / 100 : Math.round(dollars);
  return `$${Object.is(rounded, -0) ? 0 : rounded}`;
};
const shortDate = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
const dateTime = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));

async function api(body?: Record<string, unknown>) {
  const response = await fetch("/api/ledger", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong.");
  return result;
}

export default function DashboardClient({ displayName }: { displayName: string }) {
  const [data, setData] = useState<LedgerData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState("all");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [movementOpen, setMovementOpen] = useState(false);
  const [cardDepositOpen, setCardDepositOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try { setData(await api()); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not load the ledger."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const post = async (payload: Record<string, unknown>, success: string) => {
    setBusy(true);
    try { const result = await api(payload); toast.success(success); await load(); return result; }
    catch (error) { toast.error(error instanceof Error ? error.message : "Something went wrong."); return null; }
    finally { setBusy(false); }
  };

  const filtered = useMemo(() => {
    if (period === "all") return data.ledger;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - Number(period));
    return data.ledger.filter((row) => new Date(row.occurredAt) >= cutoff);
  }, [data.ledger, period]);

  const stats = useMemo(() => {
    const incoming = filtered.filter((x) => x.amountCents > 0).reduce((sum, x) => sum + x.amountCents, 0);
    const outgoing = filtered.filter((x) => x.amountCents < 0).reduce((sum, x) => sum + Math.abs(x.amountCents), 0);
    const sales = filtered.filter((x) => x.amountCents > 0);
    const starting = period === "all" ? data.openingCardBalanceCents : 0;
    return { incoming, outgoing, starting, net: starting + incoming - outgoing, average: sales.length ? incoming / sales.length : 0 };
  }, [data.openingCardBalanceCents, filtered, period]);

  const outlook = useMemo(() => {
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 27); cutoff.setHours(0, 0, 0, 0);
    const recent = data.ledger.filter((row) => {
      const date = new Date(row.occurredAt);
      return date >= cutoff && date <= today;
    });
    const revenueCents = recent.filter((row) => row.amountCents > 0).reduce((sum, row) => sum + row.amountCents, 0);
    const currentBalanceCents = data.openingCardBalanceCents + data.ledger.reduce((sum, row) => sum + row.amountCents, 0);
    const dailyRevenueCents = revenueCents / 28;
    const horizons = [7, 30, 90].map((days) => {
      const date = new Date(today); date.setDate(date.getDate() + days);
      return { days, date, revenueCents: dailyRevenueCents * days, balanceCents: currentBalanceCents + dailyRevenueCents * days };
    });
    return { revenueCents, dailyRevenueCents, currentBalanceCents, horizons };
  }, [data.ledger, data.openingCardBalanceCents]);

  const outlookChartData = useMemo(() => [
    { label: "Now", balance: outlook.currentBalanceCents / 100 },
    ...outlook.horizons.map((projection) => ({ label: `${projection.days} days`, balance: projection.balanceCents / 100 })),
  ], [outlook]);

  const chartData = useMemo(() => {
    const days = new Map<string, { label: string; revenue: number; expenses: number }>();
    [...filtered].reverse().forEach((row) => {
      const key = row.occurredAt.slice(0, 10);
      const item = days.get(key) || { label: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(row.occurredAt)), revenue: 0, expenses: 0 };
      if (row.amountCents >= 0) item.revenue += row.amountCents / 100; else item.expenses += Math.abs(row.amountCents) / 100;
      days.set(key, item);
    });
    let cumulativeNet = period === "all" ? data.openingCardBalanceCents / 100 : 0;
    return [...days.values()].map((day) => {
      cumulativeNet += day.revenue - day.expenses;
      return { label: day.label, net: cumulativeNet };
    }).slice(-45);
  }, [data.openingCardBalanceCents, filtered, period]);

  const chartScale = useMemo(() => {
    const dataMaximum = Math.max(...chartData.map((day) => day.net));
    const dataMinimum = Math.min(...chartData.map((day) => day.net));
    const span = Math.max(dataMaximum - dataMinimum, Math.abs(dataMaximum), Math.abs(dataMinimum), 1);
    const padding = span * 0.08;
    const maximum = Math.max(0, dataMaximum) + padding;
    const minimum = Math.min(0, dataMinimum) - padding;
    return { domain: [minimum, maximum] as [number, number], zeroOffset: maximum / (maximum - minimum) * 100 };
  }, [chartData]);

  const topPeople = useMemo(() => {
    const totals = new Map<string, { total: number; visits: number }>();
    filtered.filter((x) => x.source !== "cash" && x.amountCents > 0 && x.counterparty).forEach((x) => {
      const current = totals.get(x.counterparty) || { total: 0, visits: 0 };
      current.total += x.amountCents; current.visits += 1; totals.set(x.counterparty, current);
    });
    return [...totals.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  }, [filtered]);

  const weeklyComparison = useMemo(() => {
    const currentWeekStart = new Date();
    currentWeekStart.setHours(0, 0, 0, 0);
    currentWeekStart.setDate(currentWeekStart.getDate() - currentWeekStart.getDay());
    const weeks = Array.from({ length: 4 }, (_, index) => {
      const start = new Date(currentWeekStart);
      start.setDate(start.getDate() - (3 - index) * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      const lastDay = new Date(end);
      lastDay.setDate(lastDay.getDate() - 1);
      const format = (date: Date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
      return { key: `week${index}`, start, end, label: `${format(start)}–${format(lastDay)}` };
    });
    const rows: Array<Record<string, string | number>> = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => ({ day, week0: 0, week1: 0, week2: 0, week3: 0 }));
    data.ledger.filter((row) => row.amountCents > 0 && row.source !== "cash").forEach((row) => {
      const date = new Date(row.occurredAt);
      const week = weeks.find((item) => date >= item.start && date < item.end);
      if (week) rows[date.getDay()][week.key] = Number(rows[date.getDay()][week.key]) + row.amountCents / 100;
    });
    return { weeks, rows, hasData: rows.some((row) => weeks.some((week) => Number(row[week.key]) > 0)) };
  }, [data.ledger]);

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const file = fileRef.current?.files?.[0];
    if (!file) return toast.error("Choose a Venmo CSV first.");
    const result = await post({ action: "import", csv: await file.text(), fileName: file.name }, "Venmo statement imported.");
    if (result) { setUploadOpen(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const manual = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const result = await post({ action: "manual", amount: form.get("amount"), date: form.get("date"), direction: form.get("direction"), source: form.get("source"), counterparty: form.get("counterparty"), note: form.get("note") }, "Ledger entry added.");
    if (result) { setManualOpen(false); event.currentTarget.reset(); }
  };

  const cashCount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const result = await post({ action: "cash_count", balance: form.get("balance"), note: form.get("note") }, "Cash box counted and ledger updated.");
    if (result) event.currentTarget.reset();
  };

  const cashMovement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const result = await post({ action: "cash_adjustment", eventType: form.get("eventType"), amount: form.get("amount"), note: form.get("note") }, "Cash movement recorded.");
    if (result) { setMovementOpen(false); event.currentTarget.reset(); }
  };

  const cardAudit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const resetBaseline = submitter?.value === "baseline";
    const result = await post({ action: resetBaseline ? "card_baseline" : "card_audit", balance: form.get("balance") }, resetBaseline ? "New card baseline saved." : "Card audit saved.");
    if (result) event.currentTarget.reset();
  };

  const cardDeposit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const result = await post({ action: "card_adjustment", amount: form.get("amount"), note: form.get("note") }, "Non-sales deposit added to the card balance.");
    if (result) { setCardDepositOpen(false); event.currentTarget.reset(); }
  };

  const applyCardOutflow = async (transactionId: string) => {
    await post({ action: "card_outflow_apply", transactionId }, "Expense applied to the card audit.");
  };

  const review = async (classification: "snack_bar" | "personal") => {
    const current = data.pending[0]; if (!current) return;
    await post({ action: "review", ids: [current.id], classification }, classification === "snack_bar" ? "Added to the snack bar ledger." : "Marked personal and discarded.");
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this ledger entry?")) return;
    await post({ action: "delete", id }, "Ledger entry deleted.");
  };

  const current = data.pending[0];
  const latestCount = data.cashEvents.find((x) => x.eventType === "count");
  const latestAudit = data.cardAudit.lastAudit;
  const varianceClass = !latestAudit || latestAudit.varianceCents === 0 ? "even" : latestAudit.varianceCents < 0 ? "short" : "over";

  return (
    <div className="app-shell">
      <header className="masthead">
        <div className="mast-inner">
          <div className="brand-lockup"><div className="brand-stamp"><ShoppingBasket /></div><div><span className="unit-tag">DET 930</span><h1>Snack Bar</h1></div></div>
          <div className="top-actions"><span className="welcome">Hey, {displayName}</span><Button variant="outline" onClick={() => setManualOpen(true)}><Plus/> Manual entry</Button><Button className="upload-button" onClick={() => setUploadOpen(true)}><Upload/> Import Venmo</Button></div>
        </div>
      </header>

      <main className="workspace">
        <Tabs defaultValue="review">
          <div className="nav-strip">
            <TabsList variant="line">
              <a className="overview-nav-link" href="/"><BarChart3/> Overview</a>
              <TabsTrigger value="review"><ClipboardCheck/> Review <span className="count-pill">{data.pending.length}</span></TabsTrigger>
              <TabsTrigger value="cash"><Banknote/> Cash box</TabsTrigger>
              <TabsTrigger value="card"><CreditCard/> Card audit</TabsTrigger>
              <TabsTrigger value="outlooks"><Target/> Outlooks</TabsTrigger>
              <TabsTrigger value="ledger"><ReceiptText/> Ledger</TabsTrigger>
            </TabsList>
            <label className="period-control">View <select value={period} onChange={(e) => setPeriod(e.target.value)}><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="all">All time</option></select></label>
          </div>

          <TabsContent value="overview" className="section-stack">
            <section className="hero-grid">
              <article className="net-card"><span className="eyebrow light">Net performance</span><div className={stats.net >= 0 ? "net-number positive" : "net-number negative"}>{money(stats.net)}</div><p>{filtered.length} approved entries in this view</p><div className="net-stripe">{stats.starting > 0 && <span>Starting card {money(stats.starting)}</span>}<span>Revenue {money(stats.incoming)}</span><span>Expenses {money(stats.outgoing)}</span></div></article>
              <div className="stat-stack"><article><span>Revenue</span><strong>{money(stats.incoming)}</strong><ArrowUpRight/></article><article><span>Expenses</span><strong>{money(stats.outgoing)}</strong><ArrowDownRight/></article><article><span>Average sale</span><strong>{money(stats.average)}</strong><CircleDollarSign/></article></div>
            </section>
            <section className="dashboard-grid">
              <article className="panel chart-panel"><div className="panel-heading"><div><span className="eyebrow">OPERATING GROWTH</span><h2>Net position over time</h2><p>Tracks the same net performance shown above. All time includes the starting card balance.</p></div></div>
                {chartData.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={chartData}><defs><linearGradient id="net-growth" x1="0" y1="0" x2="0" y2="1"><stop offset={`${chartScale.zeroOffset}%`} stopColor="#356859" stopOpacity={.38}/><stop offset={`${chartScale.zeroOffset}%`} stopColor="#b4493e" stopOpacity={.34}/></linearGradient></defs><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#d9d1c1"/><XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24}/><YAxis domain={chartScale.domain} tickFormatter={(v) => chartMoney(Number(v))} tickLine={false} axisLine={false} width={64}/><Tooltip formatter={(v) => [money(Number(v) * 100), "Net position"]}/><ReferenceLine y={0} stroke="#8a938e" strokeDasharray="5 5" label={{ value: "Break-even", position: "insideTopRight", fill: "#68716b", fontSize: 12 }}/><Area type="monotone" dataKey="net" stroke="#26332e" strokeWidth={3} fill="url(#net-growth)" baseValue={0}/></ComposedChart></ResponsiveContainer></div> : <Empty text="Approve transactions to start the growth chart."/>}
              </article>
              <article className="panel"><div className="panel-heading"><div><span className="eyebrow">REGULARS</span><h2>Top customers</h2></div></div>{topPeople.length ? <ol className="buyer-list">{topPeople.map(([name, value], i) => <li key={name}><span className="rank">{i + 1}</span><div><strong>{name}</strong><small>{value.visits} transaction{value.visits === 1 ? "" : "s"}</small></div><b>{money(value.total)}</b></li>)}</ol> : <Empty text="Customer totals appear after sales are approved."/>}</article>
              <article className="panel pulse-panel"><span className="eyebrow">QUICK CHECK</span><h2>{data.pending.length ? `${data.pending.length} waiting for review` : "Review queue is clear"}</h2><p>{latestCount ? `Cash box last counted ${dateTime(latestCount.occurredAt)}.` : "The cash box has not been counted yet."}</p><p>{latestAudit ? `Card was last audited ${dateTime(latestAudit.checkedAt)}.` : "The card has not been audited yet."}</p></article>
              <article className="panel comparison-panel"><div className="panel-heading"><div><span className="eyebrow">LAST FOUR WEEKS</span><h2>Week-by-week revenue</h2><p>Venmo and manual activity aligned Sunday through Saturday; cash-box entries excluded.</p></div></div>
                {weeklyComparison.hasData ? <div className="comparison-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={weeklyComparison.rows} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#dde2de"/><XAxis dataKey="day" tickLine={false} axisLine={false}/><YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={48}/><Tooltip formatter={(value) => money(Number(value) * 100)}/><Legend/>{weeklyComparison.weeks.map((week, index) => <Line key={week.key} type="monotone" dataKey={week.key} name={week.label} stroke={["#9aaea6", "#627a99", "#d58850", "#356859"][index]} strokeWidth={index === 3 ? 3 : 2} dot={{ r: index === 3 ? 4 : 3 }} activeDot={{ r: 5 }} />)}</LineChart></ResponsiveContainer></div> : <Empty text="Revenue from the last four weeks will appear here."/>}
              </article>
            </section>
          </TabsContent>

          <TabsContent value="review" className="section-stack">
            <div className="page-heading"><div><span className="eyebrow">ONE AT A TIME</span><h2>Transaction review</h2><p>Only snack bar activity enters the ledger. Personal details are discarded.</p></div><div className="review-progress"><strong>{data.pending.length}</strong><span>left to review</span></div></div>
            {loading ? <Loading/> : current ? <div className="review-stage"><article className="review-ticket"><div className="ticket-top"><Badge variant="outline">{current.source}</Badge><span>{shortDate(current.occurredAt)}</span></div><div className={`review-amount ${current.amountCents >= 0 ? "positive" : "negative"}`}>{money(current.amountCents)}</div><div className="review-person"><div className={`direction-icon ${current.amountCents >= 0 ? "in" : "out"}`}>{current.amountCents >= 0 ? <ArrowDownRight/> : <ArrowUpRight/>}</div><div><span>{current.amountCents >= 0 ? "From" : "To"}</span><h3>{current.counterparty || "Unknown person"}</h3></div></div><div className="review-note"><span>VENMO NOTE</span><p>{current.note || "No note included"}</p></div><div className="review-actions"><Button variant="outline" size="lg" disabled={busy} onClick={() => void review("personal")}><UserRound/> Personal</Button><Button size="lg" disabled={busy} onClick={() => void review("snack_bar")}>{busy ? <Loader2 className="spin"/> : <Check/>} Snack bar</Button></div><p className="privacy-note">Personal transactions are excluded permanently and their details are not retained.</p></article></div> : <div className="all-clear"><Check/><h2>All caught up.</h2><p>Import another Venmo CSV whenever you have new activity.</p><Button onClick={() => setUploadOpen(true)}><Upload/> Import Venmo</Button></div>}
          </TabsContent>

          <TabsContent value="cash" className="section-stack">
            <div className="page-heading"><div><span className="eyebrow">PHYSICAL CASH</span><h2>Cash box</h2><p>Count what is there. The change since the last count is added to the ledger automatically.</p></div><Dialog open={movementOpen} onOpenChange={setMovementOpen}><DialogTrigger asChild><Button variant="outline"><RotateCcw/> Record cash movement</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Record cash movement</DialogTitle><DialogDescription>Log money deliberately added to or removed from the box so the next count stays accurate.</DialogDescription></DialogHeader><form id="movement-form" className="form-grid" onSubmit={cashMovement}><div><Label htmlFor="eventType">Movement</Label><select className="native-select" id="eventType" name="eventType"><option value="withdrawal">Removed from box</option><option value="deposit">Added to box</option></select></div><div><Label htmlFor="move-amount">Amount</Label><Input id="move-amount" name="amount" inputMode="decimal" placeholder="0.00" required/></div><div className="full"><Label htmlFor="move-note">Note</Label><Input id="move-note" name="note" placeholder="Restock run, starting change…"/></div></form><DialogFooter><Button type="submit" form="movement-form" disabled={busy}>Save movement</Button></DialogFooter></DialogContent></Dialog></div>
            <section className="cash-grid"><article className="cash-count-card"><div className="count-date"><CalendarDays/><span>Counting now<br/><b>{new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(new Date())}</b></span></div><form onSubmit={cashCount}><Label htmlFor="cash-balance">How much is in the box?</Label><div className="money-input"><span>$</span><Input id="cash-balance" name="balance" inputMode="decimal" placeholder="0.00" required autoComplete="off"/></div><Label htmlFor="cash-note">Note <small>optional</small></Label><Input id="cash-note" name="note" placeholder="End of day count"/><Button size="lg" disabled={busy}>{busy ? <Loader2 className="spin"/> : <Banknote/>} Count it & update ledger</Button></form></article><article className="balance-board"><span className="eyebrow light">LAST COUNT</span><strong>{latestCount ? money(latestCount.amountCents) : "—"}</strong><p>{latestCount ? dateTime(latestCount.occurredAt) : "No cash counts yet"}</p>{latestCount && <div className={latestCount.calculatedChangeCents >= 0 ? "count-change up" : "count-change down"}><span>Ledger change</span><b>{money(latestCount.calculatedChangeCents)}</b></div>}<small>First count establishes the opening cash. Later counts measure the change, adjusted for recorded deposits and withdrawals.</small></article></section>
            <History title="Cash box history">{data.cashEvents.length ? data.cashEvents.map((event) => <div className="history-row" key={event.id}><div className="history-icon"><Banknote/></div><div><strong>{event.eventType === "count" ? "Cash count" : event.eventType === "withdrawal" ? "Cash removed" : "Cash added"}</strong><span>{dateTime(event.occurredAt)}{event.note ? ` · ${event.note}` : ""}</span></div><b>{money(event.amountCents)}</b>{event.eventType === "count" && <em>{money(event.calculatedChangeCents)} to ledger</em>}</div>) : <Empty text="Cash counts and movements will appear here."/>}</History>
          </TabsContent>

          <TabsContent value="card" className="section-stack">
            <div className="page-heading"><div><span className="eyebrow">RECONCILIATION</span><h2>Card audit</h2><p>Compare the current card balance with sales and only the expenses that have actually posted to the card.</p></div><Button variant="outline" onClick={() => setCardDepositOpen(true)}><HandCoins/> Add non-sales deposit</Button></div>
            <section className="audit-grid"><article className="audit-form-card"><div className="expected-chip"><span>{data.cardAudit.hasBaseline ? "Expected balance" : "First audit"}</span><strong>{data.cardAudit.hasBaseline ? money(data.cardAudit.expectedBalanceCents) : "Sets baseline"}</strong></div>{data.cardAudit.hasBaseline && <div className="audit-breakdown"><span>Since last audit</span><b>Venmo sales {money(data.cardAudit.ledgerMovementCents)}</b><b>Applied card expenses {money(data.cardAudit.cardOutflowCents)}</b><b>Non-sales deposits {money(data.cardAudit.adjustmentCents)}</b></div>}<form onSubmit={cardAudit}><Label htmlFor="card-balance">What is the current card balance?</Label><div className="money-input"><span>$</span><Input id="card-balance" name="balance" inputMode="decimal" placeholder="0.00" required autoComplete="off"/></div><Button size="lg" disabled={busy}>{busy ? <Loader2 className="spin"/> : <ClipboardCheck/>} {data.cardAudit.hasBaseline ? "Run the audit" : "Set starting balance"}</Button>{data.cardAudit.hasBaseline && <Button type="submit" name="mode" value="baseline" variant="ghost" disabled={busy}>Use this as a new baseline</Button>}</form><p className="method-note">Your first entry becomes the starting balance and always balances. Expenses stay pending here until you confirm that they have posted to the card.</p></article><article className={`audit-result ${varianceClass}`}><span className="eyebrow light">LATEST RESULT</span>{latestAudit ? <><div className="audit-status">{latestAudit.varianceCents === 0 ? "BALANCED" : latestAudit.varianceCents < 0 ? "SHORT" : "OVER"}</div><strong>{money(Math.abs(latestAudit.varianceCents))}</strong><div className="audit-pair"><span>Actual <b>{money(latestAudit.actualBalanceCents)}</b></span><span>Expected <b>{money(latestAudit.expectedBalanceCents)}</b></span></div><p>{dateTime(latestAudit.checkedAt)}</p></> : <><WalletCards/><h3>No baseline yet</h3><p>Enter the current balance once to start tracking.</p></>}</article></section>
            {data.pendingCardOutflows.length > 0 && <History title="Expenses waiting to post"><div className="outflow-explainer">These expenses are already in the ledger, but they have not been subtracted from the card yet.</div>{data.pendingCardOutflows.map((row) => <div className="history-row pending-outflow" key={row.id}><div className="history-icon"><CreditCard/></div><div><strong>{row.note || row.counterparty || "Card expense"}</strong><span>{shortDate(row.occurredAt)} · {row.counterparty || "Ledger expense"}</span></div><b>{money(row.amountCents)}</b><Button size="sm" variant="outline" disabled={busy} onClick={() => void applyCardOutflow(row.id)}>Apply to card</Button></div>)}</History>}
            <History title="Audit history">{data.cardAudit.history.length ? data.cardAudit.history.map((audit) => <div className="history-row audit-history" key={audit.id}><div className={`status-dot ${audit.varianceCents === 0 ? "even" : audit.varianceCents < 0 ? "short" : "over"}`}/><div><strong>{dateTime(audit.checkedAt)}</strong><span>Expected {money(audit.expectedBalanceCents)} · actual {money(audit.actualBalanceCents)}</span></div><b>{audit.varianceCents === 0 ? "Balanced" : `${audit.varianceCents > 0 ? "+" : "−"}${money(Math.abs(audit.varianceCents))}`}</b></div>) : <Empty text="Completed card audits will appear here."/>}</History>
            {data.cardAudit.adjustments.length > 0 && <History title="Non-sales deposits">{data.cardAudit.adjustments.map((adjustment) => <div className="history-row" key={adjustment.id}><div className="history-icon"><HandCoins/></div><div><strong>{adjustment.note || "Non-sales deposit"}</strong><span>{dateTime(adjustment.occurredAt)} · excluded from income</span></div><b>{money(adjustment.amountCents)}</b></div>)}</History>}
          </TabsContent>

          <TabsContent value="outlooks" className="section-stack">
            <div className="page-heading"><div><span className="eyebrow">AUTOMATIC FORECAST</span><h2>Outlook</h2><p>Projected from the last 28 days of approved revenue. Recorded expenses affect today&apos;s balance but are not assumed to repeat.</p></div></div>
            <section className="outlook-summary"><div><span className="eyebrow light">CURRENT OPERATING BALANCE</span><strong>{money(outlook.currentBalanceCents)}</strong><p>Starting card funds + approved income − recorded expenses</p></div><div className="pace-callout"><span>Current revenue pace</span><b className="positive">{money(outlook.dailyRevenueCents)}/day</b></div></section>
            <article className="panel outlook-chart-panel"><div className="panel-heading"><div><span className="eyebrow">PROJECTION PATH</span><h2>Where the balance is headed</h2><p>Current balance plus the recent daily revenue pace.</p></div></div><div className="outlook-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={outlookChartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#dde2de"/><XAxis dataKey="label" tickLine={false} axisLine={false}/><YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={58}/><Tooltip formatter={(value) => [money(Number(value) * 100), "Projected balance"]}/><Line type="monotone" dataKey="balance" stroke="#356859" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }}/></LineChart></ResponsiveContainer></div></article>
            {data.ledger.length ? <section className="outlook-grid">{outlook.horizons.map((projection) => <ProjectionCard key={projection.days} projection={projection}/>)}</section> : <article className="panel"><Empty text="The forecast will appear after transactions are approved."/></article>}
            <article className="panel forecast-method"><div><span>28-day revenue pace</span><strong>{money(outlook.revenueCents / 4)} / week</strong></div><div><span>Future expenses assumed</span><strong>$0</strong></div><p>Recorded expenses reduce the current balance once and are not repeated in the forecast. Donations do not count as sales.</p></article>
          </TabsContent>

          <TabsContent value="ledger" className="section-stack">
            <div className="page-heading"><div><span className="eyebrow">APPROVED ACTIVITY</span><h2>The ledger</h2><p>Venmo, cash counts and manual entries in one record.</p></div><Button onClick={() => setManualOpen(true)}><Plus/> Manual entry</Button></div>
            <article className="panel table-panel">{loading ? <Loading/> : filtered.length ? <Table><TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Source</TableHead><TableHead>Person / account</TableHead><TableHead>Note</TableHead><TableHead className="amount-head">Amount</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader><TableBody>{filtered.map((row) => <TableRow key={row.id}><TableCell>{shortDate(row.occurredAt)}</TableCell><TableCell><Badge variant="outline">{row.source}</Badge></TableCell><TableCell>{row.counterparty || "—"}</TableCell><TableCell className="note-cell">{row.note || "—"}</TableCell><TableCell className={`amount-cell ${row.amountCents >= 0 ? "positive" : "negative"}`}>{money(row.amountCents)}</TableCell><TableCell><Button variant="ghost" size="icon-sm" aria-label="Delete transaction" onClick={() => void remove(row.id)}><Trash2/></Button></TableCell></TableRow>)}</TableBody></Table> : <Empty text="No approved entries in this period."/>}</article>
            {data.batches.length > 0 && <History title="Recent imports">{data.batches.map((batch) => <div className="history-row" key={batch.id}><div className="history-icon"><Upload/></div><div><strong>{batch.fileName}</strong><span>{dateTime(batch.createdAt)}</span></div><b>{batch.importedCount} imported</b><em>{batch.duplicateCount} duplicates · {batch.skippedCount} skipped</em></div>)}</History>}
          </TabsContent>
        </Tabs>
      </main>

      <footer><span>SNACK BAR · DET 930</span><span>{data.personalCount} personal transaction{data.personalCount === 1 ? "" : "s"} excluded</span></footer>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}><DialogContent><DialogHeader><DialogTitle>Import a Venmo statement</DialogTitle><DialogDescription>Upload the CSV exactly as Venmo provides it. Only money received is imported; outgoing payments and duplicates are ignored.</DialogDescription></DialogHeader><form id="upload-form" className="upload-form" onSubmit={upload}><label className="drop-zone"><Upload/><strong>Choose your Venmo CSV</strong><span>CSV only · up to 8 MB</span><Input ref={fileRef} type="file" accept=".csv,text/csv" required/></label></form><DialogFooter><Button type="submit" form="upload-form" disabled={busy}>{busy ? <Loader2 className="spin"/> : <Upload/>} Import transactions</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={cardDepositOpen} onOpenChange={setCardDepositOpen}><DialogContent><DialogHeader><DialogTitle>Add a non-sales deposit</DialogTitle><DialogDescription>Use this for donated money or other funds added to the card. It raises the expected card balance without counting as snack bar income.</DialogDescription></DialogHeader><form id="card-deposit-form" className="form-grid" onSubmit={cardDeposit}><div><Label htmlFor="card-deposit-amount">Amount</Label><Input id="card-deposit-amount" name="amount" inputMode="decimal" placeholder="0.00" required/></div><div><Label htmlFor="card-deposit-note">Description</Label><Input id="card-deposit-note" name="note" placeholder="Donation, starting funds…"/></div></form><DialogFooter><Button type="submit" form="card-deposit-form" disabled={busy}>{busy ? <Loader2 className="spin"/> : <HandCoins/>} Add deposit</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={manualOpen} onOpenChange={setManualOpen}><DialogContent><DialogHeader><DialogTitle>Add a manual ledger entry</DialogTitle><DialogDescription>For purchases, reimbursements or anything that did not arrive through Venmo or a cash count.</DialogDescription></DialogHeader><form id="manual-form" className="form-grid" onSubmit={manual}><div><Label htmlFor="manual-date">Date</Label><Input id="manual-date" name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required/></div><div><Label htmlFor="manual-amount">Amount</Label><Input id="manual-amount" name="amount" inputMode="decimal" placeholder="0.00" required/></div><div><Label htmlFor="manual-direction">Direction</Label><select className="native-select" id="manual-direction" name="direction"><option value="incoming">Money in</option><option value="outgoing">Money out</option></select></div><div><Label htmlFor="manual-source">Source</Label><select className="native-select" id="manual-source" name="source"><option value="manual">Manual</option><option value="cash">Cash</option></select></div><div><Label htmlFor="manual-person">Person / account</Label><Input id="manual-person" name="counterparty" placeholder="Costco, cash customer…"/></div><div><Label htmlFor="manual-note">Note</Label><Input id="manual-note" name="note" placeholder="What was this for?"/></div></form><DialogFooter><Button type="submit" form="manual-form" disabled={busy}>Add to ledger</Button></DialogFooter></DialogContent></Dialog>
      <Toaster richColors position="bottom-right"/>
    </div>
  );
}

function Empty({ text }: { text: string }) { return <div className="empty-state"><ReceiptText/><strong>Nothing here yet</strong><span>{text}</span></div>; }
function Loading() { return <div className="loading-row"><Loader2 className="spin"/> Loading the books…</div>; }
function History({ title, children }: { title: string; children: React.ReactNode }) { return <article className="panel history-panel"><div className="panel-heading"><div><span className="eyebrow">LOG BOOK</span><h2>{title}</h2></div></div><div className="history-list">{children}</div></article>; }

function ProjectionCard({ projection }: { projection: { days: number; date: Date; revenueCents: number; balanceCents: number } }) {
  return <article className="outlook-card">
    <div className="projection-date"><span>IN {projection.days} DAYS</span><strong>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(projection.date)}</strong></div>
    <div className="outlook-amount"><strong>{money(projection.balanceCents)}</strong><span>projected balance</span></div>
    <div className="projection-split"><span>Added revenue <b>{money(projection.revenueCents)}</b></span><span>Expenses assumed <b>$0</b></span></div>
  </article>;
}
