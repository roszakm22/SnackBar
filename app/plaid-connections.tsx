"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type Kind = "venmo" | "amex";
type Connection = { kind: Kind; connectedAt: string; lastSyncedAt: string | null; lastError: string | null };
type PlaidHandler = { open: () => void; destroy: () => void };
declare global {
  interface Window {
    Plaid?: { create: (options: {
      token: string; receivedRedirectUri?: string;
      onSuccess: (publicToken: string | null) => void;
      onExit: (error: { display_message?: string } | null) => void;
    }) => PlaidHandler };
  }
}

const savedLinkKey = "snackbar-plaid-link";

async function plaidApi(body?: Record<string, unknown>) {
  const response = await fetch("/api/ledger/plaid", body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Plaid connection failed.");
  return result;
}

function loadScript() {
  if (window.Plaid) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-plaid-link="true"]');
    const script = existing || document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Plaid Link could not load.")), { once: true });
    if (!existing) {
      script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
      script.async = true;
      script.dataset.plaidLink = "true";
      document.head.append(script);
    }
  });
}

export default function PlaidConnections({ onChanged }: { onChanged: () => Promise<void> }) {
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);
  const [configured, setConfigured] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [busy, setBusy] = useState(false);
  const [awardMonth, setAwardMonth] = useState(() => {
    const date = new Date(); date.setMonth(date.getMonth() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });

  const refresh = useCallback(async () => {
    const result = await plaidApi() as { configured: boolean; connections: Connection[] };
    setConfigured(result.configured);
    setConnections(result.connections);
  }, []);

  const launch = useCallback(async (kind: Kind, linkToken: string, reconnect: boolean, receivedRedirectUri?: string) => {
    await loadScript();
    if (!window.Plaid) throw new Error("Plaid Link is unavailable.");
    const handler = window.Plaid.create({
      token: linkToken,
      ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
      onSuccess: (publicToken) => {
        void (async () => {
          setBusy(true);
          try {
            if (reconnect) {
              const result = await plaidApi({ action: "reconnect_complete", kind }) as { warning?: string | null };
              if (result.warning) toast.error(result.warning);
              else toast.success(`${kind === "venmo" ? "Venmo" : "Amex"} reconnected.`);
            } else {
              if (!publicToken) throw new Error("Plaid did not provide an authorization token.");
              const result = await plaidApi({ action: "exchange", kind, publicToken }) as { connected: { warning?: string | null } };
              if (result.connected.warning) toast.error(result.connected.warning);
              else toast.success(`${kind === "venmo" ? "Venmo" : "Amex"} connected.`);
            }
            localStorage.removeItem(savedLinkKey);
            await refresh();
            await onChangedRef.current();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not finish linking.");
          } finally { setBusy(false); handler.destroy(); }
        })();
      },
      onExit: (error) => {
        if (error) toast.error(error.display_message || "Plaid sign-in was interrupted.");
        handler.destroy();
      },
    });
    handler.open();
  }, [refresh]);

  useEffect(() => {
    const refreshTimer = window.setTimeout(() => {
      void refresh().catch((error) => toast.error(error instanceof Error ? error.message : "Could not load Plaid status."));
    }, 0);
    const url = new URL(window.location.href);
    if (!url.searchParams.has("oauth_state_id")) return () => window.clearTimeout(refreshTimer);
    const saved = localStorage.getItem(savedLinkKey);
    if (!saved) {
      toast.error("The Plaid session expired. Start the connection again.");
      return () => window.clearTimeout(refreshTimer);
    }
    try {
      const state = JSON.parse(saved) as { kind: Kind; linkToken: string; reconnect: boolean };
      const redirect = window.location.href;
      window.history.replaceState({}, "", "/manage");
      void launch(state.kind, state.linkToken, state.reconnect, redirect).catch((error) =>
        toast.error(error instanceof Error ? error.message : "Could not resume Plaid sign-in."));
    } catch { toast.error("The saved Plaid session is invalid. Start again."); }
    return () => window.clearTimeout(refreshTimer);
  }, [launch, refresh]);

  const start = async (kind: Kind, reconnect: boolean) => {
    setBusy(true);
    try {
      const result = await plaidApi({ action: "link", kind, reconnect }) as { linkToken: string };
      localStorage.setItem(savedLinkKey, JSON.stringify({ kind, linkToken: result.linkToken, reconnect }));
      await launch(kind, result.linkToken, reconnect);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start Plaid sign-in.");
    } finally { setBusy(false); }
  };

  const sync = async (kind: Kind) => {
    setBusy(true);
    try {
      const result = await plaidApi({ action: "sync", kind }) as { imported: number };
      toast.success(`Synced ${kind === "venmo" ? "Venmo" : "Amex"}: ${result.imported} new to review.`);
      await refresh(); await onChangedRef.current();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Sync failed."); }
    finally { setBusy(false); }
  };

  const disconnect = async (kind: Kind) => {
    if (!window.confirm(`Disconnect ${kind === "venmo" ? "Venmo" : "Amex"}? On Plaid's free Trial, this will permanently use one of your ten connection slots.`)) return;
    setBusy(true);
    try { await plaidApi({ action: "disconnect", kind }); await refresh(); toast.success("Disconnected."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Disconnect failed."); }
    finally { setBusy(false); }
  };

  const finalizeAwards = async () => {
    if (!window.confirm(`Finalize ${awardMonth} awards? First make sure all Venmo payments for that month have synced and been reviewed. This cannot be undone.`)) return;
    setBusy(true);
    try {
      const response = await fetch("/api/ledger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "finalize_awards_month", month: awardMonth }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not finalize awards.");
      toast.success(`Awards finalized for ${awardMonth}.`);
      await onChangedRef.current();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not finalize awards."); }
    finally { setBusy(false); }
  };

  return (
    <section className="panel plaid-panel">
      <div className="panel-heading"><div><span className="eyebrow">AUTOMATIC IMPORT</span><h2>Connected accounts</h2>
        <p>Plaid checks for posted activity; SnackBar syncs every four hours. New Venmo receipts and Amex charges wait for your review.</p></div></div>
      {!configured && <p>To enable connections, add the Plaid Worker secrets and redirect URL described in the repository README.</p>}
      {(["venmo", "amex"] as Kind[]).map((kind) => {
        const connection = connections.find((item) => item.kind === kind);
        return <div className="plaid-account" key={kind}>
          <div><strong>{kind === "venmo" ? "Venmo Personal" : "American Express"}</strong>
            <span>{connection ? `Connected · Last sync ${connection.lastSyncedAt ? new Date(connection.lastSyncedAt).toLocaleString() : "pending"}` : "Not connected"}</span>
            {connection?.lastError && <small className="plaid-error">{connection.lastError}</small>}</div>
          <div className="plaid-actions">
            {connection ? <>
              <Button variant="outline" disabled={busy} onClick={() => void sync(kind)}>Sync now</Button>
              <Button variant="outline" disabled={busy} onClick={() => void start(kind, true)}>Reconnect</Button>
              <Button variant="outline" disabled={busy} onClick={() => void disconnect(kind)}>Disconnect</Button>
            </> : <Button disabled={busy || !configured} onClick={() => void start(kind, false)}>Connect {kind === "venmo" ? "Venmo" : "Amex"}</Button>}
          </div>
        </div>;
      })}
      {connections.some((item) => item.kind === "venmo") && <div className="plaid-awards">
        <label htmlFor="plaid-awards-month">Finalize monthly awards after all payments are reviewed</label>
        <input id="plaid-awards-month" type="month" value={awardMonth} onChange={(event) => setAwardMonth(event.target.value)}/>
        <Button variant="outline" disabled={busy} onClick={() => void finalizeAwards()}>Finalize awards</Button>
      </div>}
      <p className="plaid-footnote">Plaid may omit a Venmo payer name. Check it before approval. CSV import stays available for dates before the Venmo connection.</p>
    </section>
  );
}
