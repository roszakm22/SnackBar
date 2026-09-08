# SnackBar Ledger

A Cloudflare-hosted tracker for Det 930's snack bar. It imports Venmo statement CSVs, reviews transactions one at a time, tracks the cash box, audits the card balance, and reports day-by-day performance.

## What it tracks

- Money-in-only Venmo CSV imports with automatic duplicate detection
- One-at-a-time classification as snack bar or personal
- Approved revenue, expenses, net performance, and a running growth-after-expenses chart
- Cash-box counts, deposits, and withdrawals
- Card balance audits against approved Venmo sales, posted card expenses, and non-sales deposits
- Automatic 7-, 30-, and 90-day outlooks based on the latest 28 days of revenue and expenses
- Starting card funds included in all-time net performance and outlook progress
- Donations and other card deposits that affect the audit without counting as income
- Manual ledger entries
- Public performance overview at `/`
- Public customer leaderboard with a selectable date range
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

The root page and `/api/overview` stay public. That API returns daily aggregates, leaderboard totals, and operational timestamps; it does not return Venmo notes, individual transactions, cash balances, or current card balances.

The production D1 database is already configured as `snackbar-ledger` with the `DB` binding.

For local development, run `npm ci` followed by `npm run dev`. The local Worker uses a project-local D1 database.

## Commands

- `npm run dev` — local development
- `npm run build` — production build
- `npm run deploy` — build, migrate the remote D1 database, and deploy
- `npm run db:generate` — generate a migration after schema changes
