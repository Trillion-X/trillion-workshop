// Ported from old trillion test/spend-merchants.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The old test read the Spend screen of old src/spend-meter.mjs spendMeter, which made its merchant
// rows with src/money-out.mjs merchantsFrom (src/spend-meter.mjs:262 at the tag). spendMeter runs nowhere (searched
// spendMeter, spend-budget:, connect:money in trillion-workshop tools/, trillion-apps web/, trillion-rust src/); merchantsFrom
// is src/money-out.mjs here. So the checks on what merchantsFrom decides are made on it, over the same payments: the order,
// the cost a month (spendMeter's per_month is merchantsFrom's month), trend, cycle, plan and the Duplicate flag; the screen's
// words "Flat" and "Duplicate" are spendMeter's for merchantsFrom's trend.change "flat" and flag_duplicate. Left out with
// the Spend screen: the items list (its ids, kinds, inside addresses and words), Cloudflare's lines under its merchant and
// its usage reading (the Unused flag and the free allowance), the totals with lines at the top, and the connect cards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, merchantsFrom } from '../src/money-out.mjs';

// 2026-10-04 12:00 UTC, in a billing month that started on the 26th.
const NOON = Date.parse('2026-10-04T12:00:00Z');
const DAY = 86_400_000;
const ago = days => new Date(NOON - days * DAY).toISOString();
const gmail = { id: 'gmail', label: 'Gmail', group: 'Email', kind: 'mail' };
const chase = { id: 'chase', label: 'Chase', group: 'Bank', kind: 'bank' };
const amex = { id: 'amex', label: 'Amex', group: 'Bank', kind: 'bank' };
const descriptors = [{ vendor: 'cloudflare', name: 'Cloudflare', domain: 'cloudflare.com' }];
const sources = [
  { source: gmail, payments: [
    { id: 'cf-3', merchant: 'Cloudflare, Inc.', amount: 5, at: ago(3), plan: 'Workers Paid' },
    { id: 'cf-33', merchant: 'Cloudflare, Inc.', amount: 5, at: ago(33), plan: 'Workers Paid' },
    { id: 'cf-63', merchant: 'Cloudflare, Inc.', amount: 5, at: ago(63), plan: 'Workers Paid' },
    { id: 'notion-10', merchant: 'Notion Labs', amount: 20, at: ago(10), plan: 'Plus' },
    { id: 'notion-40', merchant: 'Notion Labs', amount: 20, at: ago(40), plan: 'Plus' },
    { id: 'notion-70', merchant: 'Notion Labs', amount: 20, at: ago(70), plan: 'Plus' },
    { id: 'figma-7', merchant: 'Figma', amount: 144, at: ago(7) },
    { id: 'figma-372', merchant: 'Figma', amount: 144, at: ago(372) },
  ] },
  // Vercel from two bank accounts, four days apart for the same amount: a duplicate.
  { source: chase, payments: [
    { id: 'vercel-10', merchant: 'Vercel', amount: 9, at: ago(10), account: 'acct-1' },
    { id: 'vercel-40', merchant: 'Vercel', amount: 9, at: ago(40), account: 'acct-1' },
    { id: 'vercel-70', merchant: 'Vercel', amount: 9, at: ago(70), account: 'acct-1' },
  ] },
  { source: amex, payments: [{ id: 'vercel-14', merchant: 'Vercel', amount: 9, at: ago(14), account: 'acct-2' }] },
];

const merchantsOf = rows => merchantsFrom({ sources: rows, connectors: descriptors, now: NOON }).merchants;
const merchant = (rows, title) => merchantsOf(rows).find(row => row.title === title);

test('every merchant a person pays is a row, biggest monthly cost first, with its trend and checks', () => {
  const merchants = merchantsOf(sources);
  assert.deepEqual(merchants.map(row => row.title), ['Notion Labs', 'Figma', 'Vercel', 'Cloudflare']);
  assert.deepEqual(merchants.map(row => row.month), [20, 12, 9, 5]);
  assert.equal(merchant(sources, 'Notion Labs').trend.change, 'flat');
  assert.equal(merchant(sources, 'Figma').cycle, 'yearly');
  assert.equal(merchant(sources, 'Cloudflare').plan, 'Workers Paid');
});

test('two charges to one merchant from two accounts close together are flagged Duplicate', () => {
  assert.deepEqual(merchant(sources, 'Vercel').flags, [defaults.flag_duplicate]);
  assert.deepEqual(merchant(sources, 'Notion Labs').flags, []);
});

test('with no money source connected there are no merchants', () => {
  assert.equal(merchantsOf([]).length, 0);
});
