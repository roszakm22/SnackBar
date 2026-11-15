"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, MessageSquareQuote, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

type SnackQuote = { id: string; text: string };
const ROTATION_MS = 9000;

export default function SnackQuotes() {
  const [quotes, setQuotes] = useState<SnackQuote[]>([]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/snack-quotes.json", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Quotes unavailable");
        const data: unknown = await response.json();
        if (!Array.isArray(data)) return;
        const seen = new Set<string>();
        const selected = data.filter((item): item is SnackQuote => {
          if (!item || typeof item.id !== "string" || !item.id.trim() || typeof item.text !== "string" || !item.text.trim() || item.text.length > 500 || seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        }).map(({ id, text }) => ({ id, text }));
        // Shuffle once per visit; no quote repeats until the whole list has played.
        for (let i = selected.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [selected[i], selected[j]] = [selected[j], selected[i]];
        }
        if (!controller.signal.aborted) setQuotes(selected);
      })
      .catch(() => { /* A missing quote list must not interrupt the overview. */ });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(preference.matches);
    const updateVisibility = () => setVisible(!document.hidden);
    updateMotion();
    updateVisibility();
    preference.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      preference.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  const rotating = quotes.length > 1 && !paused && !hovered && !focused && visible && !reducedMotion;
  useEffect(() => {
    if (!rotating) return;
    const timer = window.setTimeout(() => setIndex((current) => (current + 1) % quotes.length), ROTATION_MS);
    return () => window.clearTimeout(timer);
  }, [rotating, index, quotes.length]);

  const step = (direction: number) => {
    setPaused(true);
    setIndex((current) => (current + direction + quotes.length) % quotes.length);
  };
  const quote = quotes[index];

  return <section
    className="panel snack-quotes"
    aria-labelledby="snack-quotes-title"
    aria-roledescription="carousel"
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}
  >
    <div className="snack-quotes-heading">
      <div><span className="eyebrow">FROM THE PURCHASE NOTES</span><h2 id="snack-quotes-title">Overheard at the Snack Bar</h2></div>
      <MessageSquareQuote aria-hidden="true" />
    </div>
    {quote ? <>
      <div className="snack-quote-stage" aria-live={rotating ? "off" : "polite"} aria-atomic="true">
        <blockquote key={quote.id} className="snack-quote-text">“{quote.text}”</blockquote>
      </div>
      <div className="snack-quote-footer">
        <span>Snack bar hall of fame</span>
        {quotes.length > 1 && <div className="snack-quote-controls">
          <Button type="button" variant="ghost" size="icon" aria-label="Previous quote" onClick={() => step(-1)}><ChevronLeft aria-hidden="true" /></Button>
          <span className="snack-quote-count" aria-label={`Quote ${index + 1} of ${quotes.length}`}>{index + 1} / {quotes.length}</span>
          <Button type="button" variant="ghost" size="icon" aria-label="Next quote" onClick={() => step(1)}><ChevronRight aria-hidden="true" /></Button>
          {!reducedMotion && <Button type="button" variant="ghost" size="icon" aria-label={paused ? "Resume quote rotation" : "Pause quote rotation"} onClick={() => setPaused((current) => !current)}>{paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</Button>}
        </div>}
      </div>
    </> : <p className="snack-quotes-empty">The best purchase notes will land here. Make your next one count.</p>}
  </section>;
}
