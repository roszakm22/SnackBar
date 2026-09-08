# SnackBar Ledger

A Cloudflare-hosted tracker for Det 930's snack bar. It imports Venmo statement CSVs, reviews transactions one at a time, tracks the cash box, audits the card balance, and reports day-by-day performance.

## What it tracks

- Venmo CSV imports with automatic duplicate detection
- One-at-a-time classification as snack bar or personal
- Approved revenue, expenses, net performance, and customer totals
- Cash-box counts, deposits, and withdrawals
- Card balance audits against approved Venmo activity
- Manual ledger entries

Personal transactions are removed after classification. Only an irreversible source key is retained so the same transaction is not imported again.

## Cloudflare setup

This is a Vinext Cloudflare Worker with a D1 database.

1. Create a D1 database named `snackbar-ledger` in Cloudflare.
2. Add `CLOUDFLARE_D1_DATABASE_ID` as a build environment variable using that database's ID.
3. Connect this GitHub repository to a Cloudflare Workers Builds project.
4. Use `npm run deploy` as the deploy command. It builds the Worker, applies the checked-in D1 migrations, and deploys the app.
5. Protect the Worker with Cloudflare Access before importing financial data.

For local development, run `npm ci` followed by `npm run dev`. The local Worker uses a project-local D1 database.

## Commands

- `npm run dev` — local development
- `npm run build` — production build
- `npm run deploy` — build, migrate the remote D1 database, and deploy
- `npm run db:generate` — generate a migration after schema changes
