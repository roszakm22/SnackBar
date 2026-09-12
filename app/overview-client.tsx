"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Award, BarChart3, CircleDollarSign, Loader2, LockKeyhole, ReceiptText, ShoppingBasket, Trophy } from "lucide-react";
import { Area, Cell, CartesianGrid, ComposedChart, Legend, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { chartMoney, moneyChartScale } from "./chart-utils";

type Day = { date: string; revenueCents: number; expenseCents: number; saleCount: number };
type LeaderAward = { month: string; tier: "bronze" | "silver" | "gold" | "platinum"; current: boolean };
type Leader = { name: string; totalCents: number; purchases: number; awards: LeaderAward[] };
type OverviewData = { days: Day[]; weeklyDays: Day[]; pendingCount: number; latestCashCountAt: string | null; latestVenmoImportAt: string | null; openingCardBalanceCents: number; leaders: Leader[]; customerConcentration: { topThreeCents: number; everyoneElseCents: number; totalCents: number; customerCount: number } };

const todayValue = new Date().toISOString().slice(0, 10);
const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 29);
const monthAgoValue = monthAgo.toISOString().slice(0, 10);
const emptyData: OverviewData = { days: [], weeklyDays: [], pendingCount: 0, latestCashCountAt: null, latestVenmoImportAt: null, openingCardBalanceCents: 0, leaders: [], customerConcentration: { topThreeCents: 0, everyoneElseCents: 0, totalCents: 0, customerCount: 0 } };
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const dateTime = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const localDate = (value: string) => new Date(`${value}T12:00:00`);
const awardMonth = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T12:00:00Z`));

export default function OverviewClient() {
  const [data, setData] = useState<OverviewData>(emptyData);
  const [period, setPeriod] = useState("all");
  const [loading, setLoading] = useState(true);
  const [leaderLoading, setLeaderLoading] = useState(false);
  const [error, setError] = useState("");
  const [leaderFrom, setLeaderFrom] = useState(monthAgoValue);
  const [leaderTo, setLeaderTo] = useState(todayValue);

  useEffect(() => {
    fetch(`/api/overview?from=${monthAgoValue}&to=${todayValue}`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load the overview.");
        setData(result);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load the overview."))
      .finally(() => setLoading(false));
  }, []);

  const updateLeaderboard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (leaderFrom > leaderTo) return setError("The leaderboard start date must be before the end date.");
    setLeaderLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/overview?from=${leaderFrom}&to=${leaderTo}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not update the leaderboard.");
      setData((current) => ({ ...current, leaders: result.leaders, customerConcentration: result.customerConcentration }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the leaderboard.");
    } finally {
      setLeaderLoading(false);
    }
  };

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
    const starting = period === "all" ? data.openingCardBalanceCents : 0;
    return { revenue, expenses, starting, net: starting + revenue - expenses, sales, average: sales ? revenue / sales : 0 };
  }, [data.openingCardBalanceCents, filtered, period]);

  const chartData = useMemo(() => {
    let cumulativeNet = period === "all" ? data.openingCardBalanceCents / 100 : 0;
    return filtered.map((day) => {
      cumulativeNet += (day.revenueCents - day.expenseCents) / 100;
      return {
        label: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(localDate(day.date)),
        net: cumulativeNet,
      };
    }).slice(-45);
  }, [data.openingCardBalanceCents, filtered, period]);

  const chartScale = useMemo(() => moneyChartScale(chartData.map((day) => day.net)), [chartData]);
  const chartHasPositive = useMemo(() => chartData.some((day) => day.net > 0), [chartData]);
  const concentrationData = useMemo(() => [
    { name: "Top 3 customers", value: data.customerConcentration.topThreeCents, color: "#356859" },
    { name: "Everyone else", value: data.customerConcentration.everyoneElseCents, color: "#d58850" },
  ], [data.customerConcentration]);
  const topThreeShare = data.customerConcentration.totalCents
    ? Math.round((data.customerConcentration.topThreeCents / data.customerConcentration.totalCents) * 100)
    : 0;

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
    data.weeklyDays.forEach((day) => {
      const date = localDate(day.date);
      const week = weeks.find((item) => date >= item.start && date < item.end);
      if (week) rows[date.getDay()][week.key] = Number(rows[date.getDay()][week.key]) + day.revenueCents / 100;
    });
    return { weeks, rows, hasData: rows.some((row) => weeks.some((week) => Number(row[week.key]) > 0)) };
  }, [data.weeklyDays]);

  return <div className="app-shell">
    <header className="masthead"><div className="mast-inner">
      <div className="brand-lockup"><div className="brand-stamp"><ShoppingBasket /></div><div><span className="unit-tag">DET 930</span><h1>Snack Bar</h1></div></div>
      <div className="top-actions"><span className="public-badge">Public overview</span><Button asChild className="upload-button"><a href="/manage"><LockKeyhole /> Manage</a></Button></div>
    </div></header>
    <main className="workspace">
      <div className="nav-strip"><div className="public-tabs"><span className="public-tab active"><BarChart3 /> Overview</span><a className="public-tab" href="/awards"><Award /> Awards</a></div><label className="period-control">View <select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="all">All time</option></select></label></div>
      {loading ? <div className="loading-row"><Loader2 className="spin" /> Loading the books…</div> : error ? <div className="overview-error">{error}</div> : <div className="section-stack">
        <section className="hero-grid">
          <article className="net-card"><span className="eyebrow light">Net performance</span><div className={stats.net >= 0 ? "net-number positive" : "net-number negative"}>{money(stats.net)}</div><p>{stats.sales} approved sales in this view{period !== "all" && data.openingCardBalanceCents > 0 ? " · starting card funds appear in All time" : ""}</p><div className="net-stripe">{stats.starting > 0 && <span>Starting card {money(stats.starting)}</span>}<span>Revenue {money(stats.revenue)}</span><span>Expenses {money(stats.expenses)}</span></div></article>
          <div className="stat-stack"><article><span>Revenue</span><strong>{money(stats.revenue)}</strong><ArrowUpRight /></article><article><span>Expenses</span><strong>{money(stats.expenses)}</strong><ArrowDownRight /></article><article><span>Average sale</span><strong>{money(stats.average)}</strong><CircleDollarSign /></article></div>
        </section>
        <section className="dashboard-grid">
          <div className="overview-chart-stack">
            <article className="panel chart-panel"><div className="panel-heading"><div><span className="eyebrow">OPERATING GROWTH</span><h2>Net position over time</h2><p>Tracks the same net performance shown above. All time includes the starting card balance.</p></div></div>
            {chartData.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={chartData}><defs><linearGradient id="public-net-growth" x1="0" y1="0" x2="0" y2="1"><stop offset={`${chartScale.zeroOffset}%`} stopColor="#356859" stopOpacity={.38}/><stop offset={`${chartScale.zeroOffset}%`} stopColor="#b4493e" stopOpacity={.34}/></linearGradient></defs><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#d9d1c1"/><XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24}/><YAxis domain={chartScale.domain} ticks={chartScale.ticks} tickFormatter={(value) => chartMoney(Number(value))} tickLine={false} axisLine={false} width={64}/><Tooltip formatter={(value) => [money(Number(value) * 100), "Net position"]}/><ReferenceLine y={0} stroke="#8a938e" strokeDasharray="5 5" label={{ value: "Break-even", position: "insideTopRight", fill: "#68716b", fontSize: 12 }}/><Area type="monotone" dataKey="net" stroke="#26332e" strokeWidth={3} fill={chartHasPositive ? "url(#public-net-growth)" : "#b4493e"} fillOpacity={chartHasPositive ? 1 : .28} baseValue={0}/></ComposedChart></ResponsiveContainer></div> : <Empty text="Approved activity will appear here." />}
          </article>
            <article className="panel concentration-panel"><div className="panel-heading"><div><span className="eyebrow">CUSTOMER MIX</span><h2>Customer concentration</h2><p>Top three customers compared with everyone else for the leaderboard dates.</p></div></div>
            {data.customerConcentration.totalCents ? <div className="concentration-body"><div className="concentration-chart"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={concentrationData} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="88%" paddingAngle={2} stroke="none">{concentrationData.map((slice) => <Cell key={slice.name} fill={slice.color}/>)}</Pie><Tooltip formatter={(value) => money(Number(value))}/></PieChart></ResponsiveContainer><div className="concentration-center"><strong>{topThreeShare}%</strong><span>from top 3</span></div></div><div className="concentration-legend">{concentrationData.map((slice) => <div key={slice.name}><span className="concentration-dot" style={{ background: slice.color }}/><div><strong>{slice.name}</strong><small>{data.customerConcentration.totalCents ? Math.round((slice.value / data.customerConcentration.totalCents) * 100) : 0}% of revenue</small></div><b>{money(slice.value)}</b></div>)}<p>{data.customerConcentration.customerCount} customer{data.customerConcentration.customerCount === 1 ? "" : "s"} in this range</p></div></div> : <Empty text="Customer mix will appear after approved sales."/>}
          </article>
          </div>
          <div className="overview-side-stack">
            <article className="panel leaderboard-panel"><div className="panel-heading"><div><span className="eyebrow">TOP SUPPORTERS</span><h2><Trophy/> Leaderboard</h2></div></div><form className="leaderboard-range" onSubmit={updateLeaderboard}><label>From<input type="date" value={leaderFrom} max={leaderTo} onChange={(event) => setLeaderFrom(event.target.value)} required/></label><label>To<input type="date" value={leaderTo} min={leaderFrom} onChange={(event) => setLeaderTo(event.target.value)} required/></label><Button size="sm" disabled={leaderLoading}>{leaderLoading ? <Loader2 className="spin"/> : "Update"}</Button></form>{data.leaders.length ? <ol className="buyer-list">{data.leaders.map((leader, index) => <li key={leader.name}><LeaderboardRank index={index}/><div className="buyer-details"><div className="buyer-name-line"><strong>{leader.name}</strong><LeaderAwards awards={leader.awards || []}/></div><small>{leader.purchases} purchase{leader.purchases === 1 ? "" : "s"}</small></div><b>{money(leader.totalCents)}</b></li>)}</ol> : <Empty text="No approved sales in this date range."/>}</article>
            <article className="panel pulse-panel"><span className="eyebrow">QUICK CHECK</span><h2>{data.pendingCount ? `${data.pendingCount} waiting for review` : "Review queue is clear"}</h2><p>{data.latestCashCountAt ? `Cash box last counted ${dateTime(data.latestCashCountAt)}.` : "The cash box has not been counted yet."}</p><p>{data.latestVenmoImportAt ? `Venmo activity last uploaded ${dateTime(data.latestVenmoImportAt)}.` : "No Venmo statement has been uploaded yet."}</p></article>
          </div>
          <article className="panel comparison-panel"><div className="panel-heading"><div><span className="eyebrow">LAST FOUR WEEKS</span><h2>Week-by-week revenue</h2><p>Venmo and manual activity aligned Sunday through Saturday; cash-box entries excluded.</p></div></div>
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

function LeaderAwards({ awards }: { awards: LeaderAward[] }) {
  if (!awards.length) return null;
  const visible = awards.slice(0, 6);
  const label = awards.map((award) => `${awardMonth(award.month)} ${award.tier}${award.current ? " (current month)" : ""}`).join(", ");
  return <span className="leader-awards" aria-label={`Awards: ${label}`}>
    {visible.map((award) => <span key={`${award.month}-${award.tier}-${award.current}`} className={`leader-award ${award.tier}${award.current ? " current" : ""}`} title={`${awardMonth(award.month)} ${award.tier}${award.current ? " · current month" : ""}`}><Trophy aria-hidden="true"/></span>)}
    {awards.length > visible.length && <span className="leader-award-more" title={`${awards.length - visible.length} more awards`}>+${awards.length - visible.length}</span>}
  </span>;
}

function LeaderboardRank({ index }: { index: number }) {
  const place = index + 1;
  return <span className={`rank ${place <= 3 ? `trophy-rank place-${place}` : ""}`}><span className="sr-only">Rank {place}</span>{place <= 3 ? <Trophy aria-hidden="true"/> : <span aria-hidden="true">{place}</span>}</span>;
}
