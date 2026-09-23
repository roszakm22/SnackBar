import {
  connectItem, createLinkToken, disconnectPlaid, getPlaidConnection,
  listPlaidConnections, plaidConfigured, plaidConfigurationIssues, plaidRedirectUri, refreshConnectedAccounts, syncConnection, auditAmexBalance,
  type PlaidKind,
} from "../../../../lib/plaid";

export const dynamic = "force-dynamic";

function kindOf(value: unknown): PlaidKind | null {
  return value === "venmo" || value === "amex" ? value : null;
}

export async function GET() {
  try {
    return Response.json({ configured: plaidConfigured(), configurationIssues: plaidConfigurationIssues(), connections: await listPlaidConnections() });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load Plaid connections." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // These endpoints are behind the same Cloudflare Access policy as /api/ledger.
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      return Response.json({ error: "This action must come from the manager page." }, { status: 403 });
    }
    const body = await request.json() as Record<string, unknown>;
    const kind = kindOf(body.kind);
    if (!kind) return Response.json({ error: "Choose Venmo or Amex." }, { status: 400 });
    const action = String(body.action || "");
    const connection = await getPlaidConnection(kind);
    if (action === "link") {
      if (Boolean(connection) === (body.reconnect !== true)) {
        return Response.json({ error: connection ? "Already connected. Use reconnect." : "No connection to repair." }, { status: 409 });
      }
      if (new URL(plaidRedirectUri()).origin !== new URL(request.url).origin) {
        return Response.json({ error: "PLAID_REDIRECT_URI must use this site's exact production origin." }, { status: 400 });
      }
      return Response.json(await createLinkToken(kind, connection));
    }
    if (action === "exchange") {
      if (connection) return Response.json({ error: "Already connected." }, { status: 409 });
      const publicToken = String(body.publicToken || "");
      if (!publicToken.startsWith("public-")) return Response.json({ error: "Invalid Plaid authorization." }, { status: 400 });
      const connected = await connectItem(kind, publicToken);
      const newConnection = await getPlaidConnection(kind);
      if (newConnection && connected.accounts.length) await syncConnection(newConnection);
      return Response.json({ connected });
    }
    if (action === "reconnect_complete") {
      if (!connection) return Response.json({ error: "Connection not found." }, { status: 404 });
      const refreshed = await refreshConnectedAccounts(connection);
      const updated = await getPlaidConnection(kind);
      return Response.json({ reconnected: true, warning: refreshed.warning,
        ...(updated && refreshed.selected ? await syncConnection(updated) : {}) });
    }
    if (action === "sync") {
      if (!connection) return Response.json({ error: "Connection not found." }, { status: 404 });
      const synced = await syncConnection(connection);
      return Response.json({ ...synced, ...(kind === "amex" ? { audit: await auditAmexBalance(connection) } : {}) });
    }
    if (action === "audit") {
      if (kind !== "amex" || !connection) return Response.json({ error: "Connect Amex checking first." }, { status: 400 });
      const synced = await syncConnection(connection);
      return Response.json({ ...synced, audit: await auditAmexBalance(connection) });
    }
    if (action === "disconnect") {
      await disconnectPlaid(kind);
      return Response.json({ disconnected: true });
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Plaid request failed." }, { status: 500 });
  }
}
