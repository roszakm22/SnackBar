# SnackBar Ledger

A Cloudflare-hosted tracker for Det 930's snack bar. It imports Venmo statement CSVs, reviews transactions one at a time, tracks the cash box, audits the card balance, and reports day-by-day performance.

## What it tracks

- Money-in-only Venmo CSV imports with automatic duplicate detection
- Optional Plaid sync for Venmo Personal receipts and American Express charges; new activity enters the manager's review queue
- One-at-a-time classification as snack bar or personal
- Approved revenue, expenses, net performance, and a running growth-after-expenses chart
- Cash-box counts, deposits, and withdrawals
- Card balance audits against approved Venmo sales, posted card expenses, and non-sales deposits
- Semester-aware outlooks based on weekday-specific performance across the latest 14 completed operating days, with D1-backed closure periods that pause projections; tracked goals preserve their original date and pace for later comparison
- Starting card funds included in all-time net performance and outlook progress
- Donations and other card deposits that affect the audit without counting as income
- Manual ledger entries
- Public performance overview at `/`
- Public customer leaderboard with a selectable date range
- Public monthly awards at `/awards`: Bronze at $15, Silver at $25, Gold at $35, and Platinum at $50
- Permanent award history, finalized with a manager confirmation when the first statement from a new month is imported
- Private review, cash box, card audit, outlooks, and ledger workspace at `/manage`

Personal transactions are removed after classification. Only an irreversible source key is retained so the same transaction is not imported again.

## Cloudflare setup

This is a Vinext Cloudflare Worker with a D1 database.

1. Connect this GitHub repository to a Cloudflare Workers Builds project.
2. Use `npm run deploy` as the deploy command. It builds the Worker, applies the checked-in D1 migrations, and deploys the app.
3. In **Zero Trust > Access controls > Applications**, create a self-hosted application for the deployed hostname and protect both of these paths with the same Allow policy:
   - `/manage`
   - `/api/ledger`
4. Limit the Allow policy to the email addresses that should manage the snack bar. The exact path rules also cover their child routes unless a more-specific Access application overrides them.
5. Disable or separately protect Worker preview URLs so a preview deployment cannot bypass the management policy.
6. To enable Plaid, create a Plaid developer Trial account with Transactions access and add these **encrypted Worker secrets** in Cloudflare (never commit their values):
   - `PLAID_CLIENT_ID` and `PLAID_SECRET` from Plaid's Production dashboard
   - `PLAID_TOKEN_KEY`: a persistent random 32-byte key encoded as base64 (generate once with `openssl rand -base64 32`); changing it makes stored connections unreadable
   - `PLAID_REDIRECT_URI`: the full production URL ending in `/manage`, for example `https://your-worker.example.com/manage`
   - `PLAID_ENV`: `production` (or `sandbox` when testing with test accounts)
7. Add that same redirect URL under **Allowed redirect URIs** in the Plaid dashboard. In **Connections** on `/manage`, link Venmo Personal and American Express separately. Select only the card accounts you use for the snack bar. The site saves encrypted Plaid access tokens in D1; the secrets stay in Cloudflare.

The Worker has a Cron Trigger every four hours to fetch posted transactions. The manager can also select **Sync now**. Plaid itself checks institutions on its own schedule, so a sync may find no new data immediately after payment. Use **Reconnect** when an institution requires renewed permission; this repairs the existing Plaid Item. On the Plaid Trial plan, disconnecting does not return one of the 10 lifetime connection slots.

### Teams notifications

SnackBar can send a private Teams chat message when Plaid imports new Venmo payments. Payments imported together are grouped after ten minutes. It also sends a daily metrics report at 5 PM America/Chicago (including days with zero pending). The report contains approved revenue, expenses, operating balance, outlook, and review counts. It does not include payer names or notes. Alerts start only after configuration and do not backfill older transactions.

1. In Power Automate or Teams Workflows, create a flow using **When a Teams webhook request is received**. For a secret URL managed only by you, choose its **Anyone** authentication option; do not share the URL.
2. Add **Parse JSON** with Content set using the `triggerBody()` expression. Paste the schema below. Do not include the Message Card `@type` or `@context` fields in the schema; Power Automate's editor interprets keys starting with `@` as expressions.

   ```json
   {
     "type": "object",
     "properties": {
       "kind": { "type": "string" },
       "title": { "type": "string" },
       "revenueToday": { "type": "string" },
       "revenueWeek": { "type": "string" },
       "expensesWeek": { "type": "string" },
       "balance": { "type": "string" },
       "pace": { "type": "string" },
       "projection": { "type": "string" },
       "goal": { "type": "string" },
       "review": { "type": "string" },
       "text": { "type": "string" }
     },
     "required": ["text"]
   }
   ```

3. Add a **Condition**: parsed `kind` **is equal to** `report`. In **If yes**, add **Post a message in a chat or channel** as Flow bot to yourself. Enter the following as separate paragraphs in its Message editor, inserting each value as **Dynamic content** from Parse JSON (do not paste expressions as plain text):

   **[title]**

   **Revenue**  
   Today: [revenueToday]  
   Last 7 days: [revenueWeek]  
   Expenses, last 7 days: [expensesWeek]  
   Operating balance: [balance]

   **Outlook**  
   Revenue pace: [pace]  
   Next month: [projection]  
   Tracked goal: [goal]

   **Review queue**  
   [review]

   In **If no**, add another **Post a message in a chat or channel** action with only the parsed `text` dynamic content. This handles both the test message and grouped Venmo alerts.
4. Save the flow, copy its webhook URL, and add it in Cloudflare to the production `snackbar-ledger` Worker as an **encrypted secret** named `TEAMS_FLOW_URL`. Treat the URL like a password; never put it in GitHub or a screenshot.
5. Open **Connections** in SnackBar and select **Send report now** to check formatting; use **Send test message** to check the other branch. If the webhook accepts the request but the chat has no message, inspect the flow's run history and the Teams action.

The four-hour Plaid sync stays in place. A separate ten-minute cron dispatches grouped notifications; setting the secret enables both alerts without reconnecting Venmo or Amex. If the flow fails, unsent payment alerts retry on later cron runs. Remove the secret to pause notifications.

Venmo's Plaid descriptions may not include the payer's name. Check and edit each name in the review queue before approving it; missing names are blocked from approval. Amex checking deposits enter review as either Venmo transfers or other deposits; neither counts as another sale. Confirmed deposits update the card audit. Amex purchases enter review as expenses and, once approved, wait under **Expenses waiting to post** until you apply them to the card audit. When Amex is connected, the audit uses confirmed Amex transfers instead of Venmo sales to track money reaching the account. If a cash-to-card transfer was already recorded manually, choose **Already recorded cash transfer** on the matching Amex credit so it is not counted twice. Check for duplicate manual deposits and expenses before applying imported activity. After each scheduled sync (or **Refresh Amex balance**), Plaid reads the existing Amex checking connection’s current posted balance and creates an automatic card audit when no Amex items or approved expenses remain to review. The first eligible balance sets the baseline; you can still enter a manual balance if Plaid Balance is unavailable. Outgoing Venmo transfers are ignored; incoming Amex refunds must be classified in review. CSV import still works for historical dates before Venmo was connected; overlapping CSVs are blocked to avoid double-counting. To close a month when using Plaid, review all of its Venmo payments and then use **Finalize awards** in Connections. Verify the last Plaid sync before closing, because late posted transactions cannot be included after an award month is finalized.

The root page, `/awards`, `/api/overview`, and `/api/awards` stay public. The overview API returns daily aggregates, leaderboard totals, and operational timestamps. The awards API returns customer names, monthly purchase totals, and earned tiers. Neither API returns Venmo notes, individual transactions, cash balances, or current card balances.

The production D1 database is already configured as `snackbar-ledger` with the `DB` binding.

For local development, run `npm ci` followed by `npm run dev`. The local Worker uses a project-local D1 database.

## Commands

- `npm run dev` — local development
- `npm run build` — production build
- `npm run deploy` — build, migrate the remote D1 database, and deploy
- `npm run db:generate` — generate a migration after schema changes
