"use client";

import { useEffect, useMemo, useState } from "react";
import { Award, BarChart3, Loader2, LockKeyhole, ShoppingBasket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Tier = "Platinum" | "Gold" | "Silver" | "Bronze" | "Unranked";
type CurrentAward = { name: string; amountCents: number; tier: Tier };
type HistoryAward = { month: string; name: string; amountCents: number; tier: Exclude<Tier, "Unranked"> };
type AwardsData = { currentMonth: string; current: CurrentAward[]; history: HistoryAward[] };

const tiers: Tier[] = ["Platinum", "Gold", "Silver", "Bronze", "Unranked"];
const tierDetails: Record<Tier, { floor: number; next?: number; className: string }> = {
  Platinum: { floor: 10000, className: "platinum" },
  Gold: { floor: 7500, next: 10000, className: "gold" },
  Silver: { floor: 5000, next: 7500, className: "silver" },
  Bronze: { floor: 2500, next: 5000, className: "bronze" },
  Unranked: { floor: 0, next: 2500, className: "unranked" },
};

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const monthLabel = (month: string) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));

export default function AwardsClient() {
  const [data, setData] = useState<AwardsData>({ currentMonth: new Date().toISOString().slice(0, 7), current: [], history: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/awards", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Awards could not be loaded.");
        setData(body);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Awards could not be loaded."))
      .finally(() => setLoading(false));
  }, []);

  const historyMonths = useMemo(() => {
    const grouped = new Map<string, HistoryAward[]>();
    data.history.forEach((award) => grouped.set(award.month, [...(grouped.get(award.month) || []), award]));
    return [...grouped.entries()];
  }, [data.history]);

  return <div className="app-shell awards-page">
    <header className="masthead"><div className="mast-inner">
      <div className="brand-lockup"><div className="brand-stamp"><ShoppingBasket /></div><div><span className="unit-tag">DET 930</span><h1>Snack Bar</h1></div></div>
      <div className="top-actions"><span className="public-badge">Public awards</span><Button asChild variant="outline"><a href="/"><BarChart3 /> Overview</a></Button><Button asChild className="upload-button"><a href="/manage"><LockKeyhole /> Manage</a></Button></div>
    </div></header>

    <main className="workspace">
      <section className="awards-heading"><div className="awards-heading-icon"><Award /></div><div><span className="eyebrow">Monthly awards</span><h2>Snack Bar Hall of Fame</h2><p>Every purchase adds to the month. Awards are permanent once the next month begins.</p></div></section>
      {loading ? <div className="loading-row"><Loader2 className="spin" /> Loading awards…</div> : error ? <div className="overview-error">{error}</div> :
      <Tabs defaultValue="current" className="awards-tabs">
        <TabsList><TabsTrigger value="current">Current month</TabsTrigger><TabsTrigger value="history">History</TabsTrigger></TabsList>
        <TabsContent value="current" className="awards-content">
          <div className="awards-month-title"><div><span className="eyebrow">In progress</span><h3>{monthLabel(data.currentMonth)}</h3></div><p>$25 Bronze · $50 Silver · $75 Gold · $100 Platinum</p></div>
          {data.current.length === 0 ? <div className="empty-awards"><Award /><h3>No awards activity yet</h3><p>Approved Venmo purchases will show up here.</p></div> :
          tiers.map((tier) => {
            const people = data.current.filter((person) => person.tier === tier);
            if (!people.length) return null;
            const details = tierDetails[tier];
            const nextTier = tier === "Platinum" ? null : tiers[tiers.indexOf(tier) - 1];
            return <section className={`award-tier ${details.className}`} key={tier}>
              <div className="award-tier-header"><div><span className="award-medallion"><Award /></span><h3>{tier}</h3></div><span>{tier === "Platinum" ? "$100+" : tier === "Unranked" ? "Under $25" : `${money(details.floor)}–${money((details.next || 0) - 1)}`}</span></div>
              <div className="award-people">{people.map((person) => {
                const percent = details.next ? Math.min(100, (person.amountCents / details.next) * 100) : 100;
                return <article className="award-person" key={person.name}>
                  <div className="award-person-line"><strong>{person.name}</strong><span>{money(person.amountCents)}</span></div>
                  <div className="award-progress" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>
                  <small>{details.next ? `${money(details.next - person.amountCents)} to ${nextTier}` : "Platinum earned"}</small>
                </article>;
              })}</div>
            </section>;
          })}
        </TabsContent>
        <TabsContent value="history" className="awards-content">
          <div className="awards-month-title"><div><span className="eyebrow">Final results</span><h3>Award history</h3></div><p>Completed months are locked when the next month’s statement is imported.</p></div>
          {historyMonths.length === 0 ? <div className="empty-awards"><Award /><h3>No completed months yet</h3><p>The first month will appear here after the next month’s Venmo statement is imported.</p></div> :
          historyMonths.map(([month, awards]) => <section className="history-month" key={month}><h3>{monthLabel(month)}</h3><div className="history-awards">{awards.map((award) => <article className={`history-award ${tierDetails[award.tier].className}`} key={`${month}-${award.name}`}><span className="award-medallion"><Award /></span><div><strong>{award.name}</strong><small>{award.tier}</small></div><b>{money(award.amountCents)}</b></article>)}</div></section>)}
        </TabsContent>
      </Tabs>}
    </main>
  </div>;
}
