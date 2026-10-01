import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { businessDate, businessMonthBounds, isCardExpense } from '../lib/ledger-math.ts';

const state = mkdtempSync(join(tmpdir(), 'snackbar-workflows-'));
const port = 8873;
const base = `http://127.0.0.1:${port}`;
const wrangler = 'node_modules/wrangler/bin/wrangler.js';
const config = ['--config', 'dist/server/wrangler.json'];
const local = ['--local', '--persist-to', state, ...config];
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
let worker;
let logs = '';
const today = businessDate();
const get = async (path = '/api/ledger') => {
  const response = await fetch(base + path);
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`${response.status}: ${raw}\n${logs}`); }
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
};
const post = async (action, fields = {}, status = 200) => {
  const response = await fetch(base + '/api/ledger', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ action, ...fields }) });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`${response.status}: ${raw}\n${logs}`); }
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
};
const operating = (data) => data.openingCardBalanceCents + data.nonSalesDepositsCents + data.days.reduce((sum, row) => sum + row.revenueCents - row.expenseCents, 0);

before(async () => {
  execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', ...local], { env, stdio: 'pipe' });
  const now = Date.now();
  const fixtures = join(state, 'fixtures.sql');
  writeFileSync(fixtures, `INSERT INTO transactions (id,source_key,occurred_at,amount_cents,source,direction,counterparty,note,original_type,original_status,classification,created_at) VALUES
    ('donation','plaid:test-donation',${now},1000,'amex','incoming','Donor','','Plaid transaction','Posted','pending',${now}),
    ('refund','plaid:test-refund',${now},500,'amex','incoming','Shop','','Plaid transaction','Posted','pending',${now}),
    ('recorded','plaid:test-recorded',${now},20000,'amex','incoming','Donor','','Plaid transaction','Posted','pending',${now});`);
  execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', ...local, '--file', fixtures], { env, stdio: 'pipe' });
  worker = spawn(process.execPath, [wrangler, 'dev', ...config, '--persist-to', state, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', chunk => logs += chunk);
  worker.stderr.on('data', chunk => logs += chunk);
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/api/overview')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(logs);
});
after(() => { worker?.kill('SIGTERM'); });

test('cash, deposits, purchases, refunds and audit differences stay consistent', async () => {
  await post('card_baseline', { balance: '100' });
  await post('card_adjustment', { amount: '200', note: 'Donation' });
  await post('cash_count', { bills: '0', coins: '0' });
  await post('manual', { amount: '50', date: today, direction: 'incoming', source: 'cash', counterparty: 'Cash sale' });
  assert.equal((await post('cash_count', { bills: '50' })).calculatedChangeCents, 0, 'manual cash sales must not be counted twice');
  await post('manual', { amount: '20', date: today, direction: 'outgoing', source: 'cash', counterparty: 'Cash supplies' });
  assert.equal((await post('cash_count', { bills: '30' })).calculatedChangeCents, 0);
  let ledger = await get();
  assert.equal(ledger.pendingCardOutflows.length, 0, 'cash purchases must never wait for Amex');
  const cashExpense = ledger.ledger.find(row => row.counterparty === 'Cash supplies');
  await post('card_outflow_apply', { transactionId: cashExpense.id }, 400);
  await post('cash_to_card', { amount: '30' });
  assert.equal((await post('cash_count', { bills: '0' })).calculatedChangeCents, 0);
  assert.equal(operating(await get('/api/overview')), 33000, 'moving existing cash must not create new funds');
  await post('manual', { amount: '25', date: today, direction: 'outgoing', source: 'manual', counterparty: 'Card supplies' });
  ledger = await get();
  assert.equal(ledger.cardAudit.expectedBalanceCents, 33000, 'unapplied expense does not change card expectation');
  const expense = ledger.pendingCardOutflows[0];
  await post('card_outflow_apply', { transactionId: expense.id });
  await post('card_outflow_apply', { transactionId: expense.id });
  assert.equal((await get()).cardAudit.expectedBalanceCents, 30500, 'apply must be idempotent');
  assert.equal((await post('card_audit', { balance: '300' })).varianceCents, -500);
  assert.equal((await get()).cardAudit.expectedBalanceCents, 30500, 'an audit must preserve an unresolved difference');
  assert.equal((await post('card_audit', { balance: '300' })).varianceCents, -500);
  await post('card_baseline', { balance: '300' });
  assert.equal((await get()).cardAudit.expectedBalanceCents, 30000);
  await post('review', { ids: ['donation'], classification: 'card_deposit' });
  assert.equal(operating(await get('/api/overview')), 31500, 'imported donation increases operating funds');
  await post('review', { ids: ['recorded'], classification: 'card_confirmed' });
  assert.equal(operating(await get('/api/overview')), 31500, 'confirming an existing donation must not duplicate it');
  await post('review', { ids: ['refund'], classification: 'card_refund' });
  const overview = await get('/api/overview');
  assert.equal(operating(overview), 32000);
  assert.equal(overview.days.reduce((sum, row) => sum + row.revenueCents, 0), 5000, 'refunds are not sales');
  assert.equal(overview.days.reduce((sum, row) => sum + row.expenseCents, 0), 4000, 'refund reduces spending');
  assert.equal(overview.days.reduce((sum, row) => sum + row.saleCount, 0), 0, 'cash counts are not individual purchases');
  assert.equal((await get()).cardAudit.expectedBalanceCents, 31500);
  assert.equal((await get('/api/awards')).current.length, 0);
  await post('manual', { amount: '4', date: today, direction: 'outgoing', source: 'manual', counterparty: 'Duplicate test' });
  const duplicate = (await get()).ledger.find(row => row.counterparty === 'Duplicate test');
  await post('delete', { id: duplicate.id });
  assert.equal((await get()).ledger.some(row => row.id === duplicate.id), false);
  await post('delete', { id: expense.id }, 409);
  await post('card_audit', { balance: '' }, 400);
  const noOrigin = await fetch(base + '/api/ledger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'card_baseline', balance: '0' }) });
  assert.equal(noOrigin.status, 403);
});

test('unreviewed Venmo receipts count immediately and personal review reverses them', async () => {
  const before = operating(await get('/api/overview'));
  const csv = `ID,Datetime,Type,Status,From,To,Amount (total),Note\nprovisional-1,${today},Payment,Complete,Pat,SnackBar,+12.00,Snack`;
  await post('import', { csv, fileName: 'provisional.csv' });
  const pending = (await get()).pending.find(row => row.counterparty === 'Pat');
  assert.ok(pending);
  assert.ok((await get()).ledger.some(row => row.id === pending.id));
  assert.equal(operating(await get('/api/overview')), before + 1200);
  assert.equal((await get('/api/awards')).current.find(row => row.name === 'Pat').amountCents, 1200);
  await post('review', { ids: [pending.id], classification: 'personal' });
  assert.equal(operating(await get('/api/overview')), before);
  assert.equal((await get('/api/awards')).current.some(row => row.name === 'Pat'), false);
  assert.equal((await get()).ledger.some(row => row.id === pending.id), false);
  await post('import', { csv, fileName: 'provisional.csv' });
  assert.equal(operating(await get('/api/overview')), before, 'excluded payment stays excluded on re-import');
  const secondCsv = `ID,Datetime,Type,Status,From,To,Amount (total),Note\nprovisional-2,${today},Payment,Complete,Kim,SnackBar,+15.00,Snack`;
  await post('import', { csv: secondCsv, fileName: 'provisional-2.csv' });
  const second = (await get()).pending.find(row => row.counterparty === 'Kim');
  assert.equal(operating(await get('/api/overview')), before + 1500);
  await post('review', { ids: [second.id], classification: 'snack_bar' });
  assert.equal(operating(await get('/api/overview')), before + 1500, 'confirming a provisional sale does not count it twice');
});

test('CSV duplicates, manual awards and month close behave as expected', async () => {
  const previous = new Date(`${today.slice(0,7)}-01T12:00:00Z`); previous.setUTCMonth(previous.getUTCMonth() - 1);
  const date = previous.toISOString().slice(0,10);
  const csv = `ID,Datetime,Type,Status,From,To,Amount (total),Note\n1,${date},Payment,Complete,Alex,SnackBar,+15.00,Snacks\n1,${date},Payment,Complete,Alex,SnackBar,+15.00,Snacks\n2,${date},Payment,Complete,SnackBar,Shop,-5.00,Expense`;
  const imported = await post('import', { csv, fileName: 'test.csv' });
  assert.equal(imported.imported, 1);
  assert.equal(imported.duplicates, 1);
  assert.equal(imported.skipped, 1);
  await post('finalize_awards_month', { month: date.slice(0,7) }, 400);
  const pending = (await get()).pending.find(row => row.source === 'venmo');
  await post('review', { ids: [pending.id], classification: 'snack_bar' });
  await post('manual', { amount: '10', date, direction: 'incoming', counterparty: 'Alex', countTowardAwards: true });
  await post('finalize_awards_month', { month: date.slice(0,7) });
  const awards = await get('/api/awards');
  assert.equal(awards.history.find(row => row.name === 'Alex').tier, 'Silver');
  await post('manual', { amount: '10', date, direction: 'incoming', counterparty: 'Alex', countTowardAwards: true }, 400);
});

test('legacy cash transfers are distinguished from donations during migration', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE card_adjustments(id TEXT, occurred_at INTEGER,created_at INTEGER,amount_cents INTEGER,note TEXT);
    CREATE TABLE cash_box_events(event_type TEXT,ledger_transaction_id TEXT,occurred_at INTEGER,created_at INTEGER,amount_cents INTEGER,note TEXT);
    INSERT INTO card_adjustments VALUES ('transfer',1,1,3000,'Cash moved'),('donation',2,2,20000,'Donation');
    INSERT INTO cash_box_events VALUES ('withdrawal',NULL,1,1,3000,'Cash moved');`);
  db.exec(readFileSync('drizzle/0013_separate_cash_transfers.sql','utf8'));
  assert.equal(db.prepare("SELECT kind FROM card_adjustments WHERE id='transfer'").get().kind,'cash_transfer');
  assert.equal(db.prepare("SELECT kind FROM card_adjustments WHERE id='donation'").get().kind,'deposit');
  db.close();
});

test('dates and card-expense eligibility use the intended business rules', () => {
  assert.equal(businessDate(new Date('2026-10-01T03:30:00Z')), '2026-09-30');
  assert.equal(businessMonthBounds('2026-09').end.toISOString(), '2026-10-01T05:00:00.000Z');
  assert.equal(businessMonthBounds('2026-11').end.toISOString(), '2026-12-01T06:00:00.000Z');
  assert.equal(isCardExpense({ amountCents: -500, classification: 'snack_bar', source: 'cash' }), false);
});

test('all public and manager pages render successfully', async () => {
  for (const path of ['/', '/manage', '/awards', '/awards/print?month=2026-08']) {
    const response = await fetch(base + path);
    const html = await response.text();
    assert.equal(response.status, 200, path);
    assert.match(html, /Snack Bar|SnackBar|awards/i, path);
    assert.doesNotMatch(html, /Internal Server Error|ReferenceError|TypeError:/, path);
  }
});
