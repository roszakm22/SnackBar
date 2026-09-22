"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Award, Loader2, Printer, ShoppingBasket } from "lucide-react";
import { Button } from "@/components/ui/button";

type AwardTier = "Platinum" | "Gold" | "Silver" | "Bronze";
type AwardRecord = { name: string; amountCents: number; tier: AwardTier | "Unranked"; month?: string };
type AwardsData = { currentMonth: string; current: AwardRecord[]; history: AwardRecord[]; finalizedMonths: string[] };

const posterTiers: Array<{ name: AwardTier; threshold: string; className: string }> = [
  { name: "Platinum", threshold: "$50+", className: "platinum" },
  { name: "Gold", threshold: "$35–$49.99", className: "gold" },
  { name: "Silver", threshold: "$25–$34.99", className: "silver" },
  { name: "Bronze", threshold: "$15–$24.99", className: "bronze" },
];

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const monthLabel = (month: string) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));

export default function AwardsPrintClient() {
  const [month, setMonth] = useState("");
  const [data, setData] = useState<AwardsData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const requestedMonth = new URLSearchParams(window.location.search).get("month") || new Date().toISOString().slice(0, 7);
    setMonth(requestedMonth);
    fetch("/api/awards", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Awards could not be loaded.");
        setData(body);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Awards could not be loaded."));
  }, []);

  const poster = useMemo(() => {
    if (!data || !month) return null;
    const finalized = data.finalizedMonths.includes(month);
    const awards = finalized
      ? data.history.filter((award) => award.month === month)
      : month === data.currentMonth ? data.current.filter((award) => award.tier !== "Unranked") : [];
    return { finalized, awards, total: awards.length };
  }, [data, month]);

  if (error) return <main className="poster-status"><Award /><h1>Could not build the poster</h1><p>{error}</p><Button asChild variant="outline"><a href="/awards"><ArrowLeft /> Back to awards</a></Button></main>;
  if (!poster) return <main className="poster-status"><Loader2 className="spin" /><p>Building the awards poster…</p></main>;

  const density = poster.total > 32 ? "dense" : poster.total > 20 ? "compact" : "";

  return <main className="poster-page">
    <div className="poster-actions">
      <Button asChild variant="outline"><a href="/awards"><ArrowLeft /> Back to awards</a></Button>
      <span>For best results: Tabloid 11×17 · Landscape · Background graphics on</span>
      <Button onClick={() => window.print()}><Printer /> Print 11×17 poster</Button>
    </div>

    <section className={`award-poster ${density}`} aria-label={`${monthLabel(month)} snack bar awards poster`}>
      <div className="poster-orbit orbit-one" />
      <div className="poster-orbit orbit-two" />
      <header className="poster-header">
        <div className="poster-brand"><span className="poster-brand-mark"><ShoppingBasket /></span><span><b>DET 930</b><strong>SNACK BAR</strong></span></div>
        <div className="poster-title"><span>{poster.finalized ? "MONTHLY HONORS" : "AWARDS IN PROGRESS"}</span><h1>{monthLabel(month)}</h1><p>Recognizing this month&apos;s top snack bar supporters</p></div>
        <div className="poster-seal"><Award /><span>HALL<br/>OF FAME</span></div>
      </header>

      {poster.total ? <div className="poster-tier-grid">
        {posterTiers.map((tier) => {
          const recipients = poster.awards.filter((award) => award.tier === tier.name).sort((a, b) => b.amountCents - a.amountCents);
          return <article className={`poster-tier ${tier.className}`} key={tier.name}>
            <div className="poster-tier-head"><span className="poster-tier-medal"><Award /></span><div><h2>{tier.name}</h2><p>{tier.threshold} this month</p></div></div>
            <div className="poster-recipients">{recipients.length ? recipients.map((recipient, index) => <div className="poster-recipient" key={recipient.name}><span>{String(index + 1).padStart(2, "0")}</span><strong>{recipient.name}</strong><b>{money(recipient.amountCents)}</b></div>) : <div className="poster-tier-empty" aria-label={`No ${tier.name} recipients`}><span /></div>}</div>
          </article>;
        })}
      </div> : <div className="poster-no-awards"><Award /><h2>No awards were handed out.</h2><p>{monthLabel(month)} remains part of the Snack Bar Hall of Fame.</p></div>}

      <footer className="poster-footer"><span>BRONZE $15</span><i /><span>SILVER $25</span><i /><span>GOLD $35</span><i /><span>PLATINUM $50</span><b>DET 930 · SNACK BAR</b></footer>
    </section>
  </main>;
}
