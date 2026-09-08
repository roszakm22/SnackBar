"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, BarChart3, CircleDollarSign, Loader2, LockKeyhole, ReceiptText, ShoppingBasket } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";

type Day = { date: string; revenueCents: number; expenseCents: number; saleCount: number };
type OverviewData = { days: Day[]; pendingCount: number; latestCashCountAt: string | null; latestCardAuditAt: string | null };

const emptyData: OverviewData = { days: [], pendingCount: 0, latestCashCountAt: null, latestCardAuditAt: null };
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const dateTime = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const localDate = (value: string) => new Date(`${value}T12:00:00`);

export default function OverviewClient() {
  const [data, setData] = useState<OverviewData>(emptyData);
  const [period, setPeriod] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/overview")
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load the overview.");
        setData(result);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load the overview."))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (period === "all") return data.days;
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - Number(period));
    return data.days.filter((day) => localDate(day.date) >= cutoff);
  }, [data.days, period]);

  const stats = useMemo(() => {
    const revenue = filtered.reduce((sum, day) => sum + day.revenueCents, 0);
    const expenses = filtered.reduce((sum, day) => sum + day.expenseCents, 0);
    const sales = filtered.reduce((sum, day) => sum + day.saleCount, 0);
    return { revenue, expenses, net: revenue - expenses, sales, average: sales ? revenue / sales : 0 };
  }, [filtered]);

  const chartData = useMemo(() => filtered.slice(-45).map((day) => ({
    label: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(localDate(day.date)),
    revenue: day.revenueCents / 100,
    expenses: day.expenseCents / 100,
  })), [filtered]);

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
    data.days.forEach((day) => {
      const date = localDate(day.date);
      const week = weeks.find((item) => date >= item.start && date < item.end);
      if (week) rows[date.getDay()][week.key] = Number(rows[date.getDay()][week.key]) + day.revenueCents / 100;
    });
    return { weeks, rows, hasData: rows.some((row) => weeks.some((week) => Number(row[week.key]) > 0)) };
  }, [data.days]);

  return <div className="app-shell">
    <header className="masthead"><div className="mast-inner">
      <div className="brand-lockup"><div className="brand-stamp"><ShoppingBasket /></div><div><span className="unit-tag">DET 930</span><h1>Snack Bar</h1></div></div>
      <div className="top-actions"><span className="public-badge">Public overview</span><Button asChild className="upload-button"><a href="/manage"><LockKeyhole /> Manage</a></Button></div>
    </div></header>
    <main className="workspace">
      <div className="nav-strip"><div className="public-nav"><BarChart3 /> Overview</div><label className="period-control">View <select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="all">All time</option></select></label></div>
      {loading ? <div className="loading-row"><Loader2 className="spin" /> Loading the books…</div> : error ? <div className="overview-error">{error}</div> : <div className="section-stack">
        <section className="hero-grid">
          <article className="net-card"><span className="eyebrow light">Net performance</span><div className={stats.net >= 0 ? "net-number positive" : "net-number negative"}>{money(stats.net)}</div><p>{stats.sales} approved sales in this view</p><div className="net-stripe"><span>Revenue {money(stats.revenue)}</span><span>Expenses {money(stats.expenses)}</span></div></article>
          <div className="stat-stack"><article><span>Revenue</span><strong>{money(stats.revenue)}</strong><ArrowUpRight /></article><article><span>Expenses</span><strong>{money(stats.expenses)}</strong><ArrowDownRight /></article><article><span>Average sale</span><strong>{money(stats.average)}</strong><CircleDollarSign /></article></div>
        </section>
        <section className="dashboard-grid">
          <article className="panel chart-panel"><div className="panel-heading"><div><span className="eyebrow">DAY BY DAY</span><h2>Money moving through the bar</h2></div></div>
            {chartData.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData}><defs><linearGradient id="public-rev" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ea4d2f" stopOpacity={.38}/><stop offset="95%" stopColor="#ea4d2f" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#d9d1c1"/><XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24}/><YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={48}/><Tooltip formatter={(value) => money(Number(value) * 100)}/><Area type="monotone" dataKey="revenue" stroke="#ea4d2f" strokeWidth={3} fill="url(#public-rev)"/><Area type="monotone" dataKey="expenses" stroke="#191914" strokeWidth={2} fill="transparent"/></AreaChart></ResponsiveContainer></div> : <Empty text="Approved activity will appear here." />}
          </article>
          <article className="panel public-summary"><span className="eyebrow">ABOUT THIS VIEW</span><h2>Performance without personal details</h2><p>The public dashboard shows combined daily totals. Names, payment notes, individual transactions, cash counts, and card balances stay in the protected management area.</p></article>
          <article className="panel pulse-panel"><span className="eyebrow">QUICK CHECK</span><h2>{data.pendingCount ? `${data.pendingCount} waiting for review` : "Review queue is clear"}</h2><p>{data.latestCashCountAt ? `Cash box last counted ${dateTime(data.latestCashCountAt)}.` : "The cash box has not been counted yet."}</p><p>{data.latestCardAuditAt ? `Card was last audited ${dateTime(data.latestCardAuditAt)}.` : "The card has not been audited yet."}</p></article>
          <article className="panel comparison-panel"><div className="panel-heading"><div><span className="eyebrow">LAST FOUR WEEKS</span><h2>Week-by-week revenue</h2><p>Daily revenue aligned Sunday through Saturday.</p></div></div>
            {weeklyComparison.hasData ? <div className="comparison-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={weeklyComparison.rows} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#dde2de"/><XAxis dataKey="day" tickLine={false} axisLine={false}/><YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={48}/><Tooltip formatter={(value) => money(Number(value) * 100)}/><Legend/>{weeklyComparison.weeks.map((week, index) => <Line key={week.key} type="monotone" dataKey={week.key} name={week.label} stroke={["#9aaea6", "#627a99", "#d58850", "#356859"][index]} strokeWidth={index === 3 ? 3 : 2} dot={{ r: index === 3 ? 4 : 3 }} activeDot={{ r: 5 }}/>)}</LineChart></ResponsiveContainer></div> : <Empty text="Revenue from the last four weeks will appear here." />}
          </article>
        </section>
      </div>}
    </main>
    <footer><span>DET 930 Snack Bar</span><span>Public totals update from the approved ledger</span></footer>
  </div>;
}

function Empty({ text }: { text: string }) {
  return <div className="empty-state"><ReceiptText /><strong>Nothing here yet</strong><span>{text}</span></div>;
}
