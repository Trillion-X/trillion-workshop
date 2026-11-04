// What a person pays out is read from their bank feeds and receipt emails and turned into one row per merchant:
// names cleaned, connected services matched, a payment counted once, billing cycle, trend, duplicates, window and totals.
import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorFor, cycleOf, merchantKey, merchantsFrom } from '../src/money-out.mjs';

const DAY = 86_400_000;
// 2026-10-09 12:00 UTC.
const NOW = Date.parse('2026-10-09T12:00:00Z');
const ago = days => new Date(NOW - days * DAY).toISOString();
const pay = (id, merchant, amount, days, extra = {}) => ({ id, merchant, amount, at: ago(days), ...extra });
const bank = payments => ({ source: { id: 'bank', label: 'Bank feed', group: 'Bank', kind: 'bank' }, payments });
const mail = payments => ({ source: { id: 'mail', label: 'Receipts', group: 'Email', kind: 'mail' }, payments });
const run = (sources, connectors = []) => merchantsFrom({ sources, connectors, now: NOW });
const find = (answer, key) => answer.merchants.find(merchant => merchant.key === key);

test('bank strings are reduced to the name a person knows the merchant by', () => {
  const cases = [
    ['CLOUDFLARE* SF CA 12345', 'cloudflare'],
    ['CLOUDFLARE* ABC', 'cloudflare'],
    ['Cloudflare, Inc.', 'cloudflare'],
    ['SQ *BLUE BOTTLE', 'blue bottle'],
    ['TST* JOES DINER', 'joes diner'],
    ['PAYPAL *NETFLIX', 'netflix'],
    ['GOOGLE *GSUITE_xyz', 'google'],
    ['OPENAI *CHATGPT SUBSCR', 'openai'],
    ['AMAZON WEB SERVICES AWS.AMAZON.CO WA', 'amazon web services aws amazon'],
    ['Fly.io', 'fly'],
    ['STARBUCKS #1234 WA', 'starbucks'],
  ];
  for (const [raw, key] of cases) assert.equal(merchantKey(raw), key, raw);
});

test('a merchant matches a connector by name or by its domain word, and a look-alike does not match', () => {
  const connectors = [
    { vendor: 'cloudflare', name: 'Cloudflare', domain: 'cloudflare.com', logo: 'https://example.test/cf.svg' },
    { vendor: 'fly', name: 'Fly.io', domain: 'fly.io', logo: 'https://example.test/fly.svg' },
  ];
  const answer = run([bank([
    pay('1', 'CLOUDFLARE* ABC', 20, 3),
    pay('2', 'Fly.io', 7, 4),
    pay('3', 'Flyover Pizza', 12, 5),
  ])], connectors);
  const cloudflare = find(answer, 'cloudflare');
  assert.equal(cloudflare.vendor, 'cloudflare');
  assert.equal(cloudflare.logo, 'https://example.test/cf.svg');
  assert.equal(cloudflare.title, 'Cloudflare');
  assert.equal(find(answer, 'fly').vendor, 'fly');
  const pizza = find(answer, 'flyover pizza');
  assert.equal(pizza.vendor, null);
  assert.equal(pizza.logo, null);
  assert.equal(connectorFor('flyover pizza', connectors), null);
});

test('a bank payment and its receipt count once, and the bank row takes the receipt plan', () => {
  const answer = run([
    bank([pay('b1', 'CLOUDFLARE* ABC', 20, 2)]),
    mail([pay('m1', 'Cloudflare, Inc.', 20.4, 3, { plan: 'Pro' })]),
  ]);
  assert.equal(answer.merchants.length, 1);
  const [merchant] = answer.merchants;
  assert.equal(merchant.plan, 'Pro');
  assert.deepEqual(merchant.charges.map(charge => [charge.id, charge.source, charge.plan]), [['b1', 'bank', 'Pro']]);
  assert.equal(merchant.days_90, 20);
  assert.deepEqual(answer.sources.map(source => [source.id, source.count, source.days_90]), [['bank', 1, 20], ['mail', 0, 0]]);
  assert.equal(answer.total.days_90, 20);
});

test('a monthly bill has its cycle, its cost a month and its renewal date', () => {
  const answer = run([bank([pay('1', 'Gym Club', 20, 70), pay('2', 'Gym Club', 20, 40), pay('3', 'Gym Club', 20, 10)])]);
  const gym = find(answer, 'gym club');
  assert.equal(gym.cycle, 'monthly');
  assert.equal(gym.month, 20);
  assert.equal(gym.last_at, ago(10));
  assert.equal(gym.last_amount, 20);
  assert.equal(gym.renews_at, new Date(NOW - 10 * DAY + 30 * DAY).toISOString().slice(0, 10));
  assert.equal(gym.days_90, 60);
});

test('yearly and weekly billing are read from the gap between charges', () => {
  assert.equal(cycleOf(365), 'yearly');
  assert.equal(cycleOf(360), 'yearly');
  assert.equal(cycleOf(7), 'weekly');
  assert.equal(cycleOf(15), null);
  const answer = run([bank([pay('1', 'Weekly Greens', 12, 14), pay('2', 'Weekly Greens', 12, 7)])]);
  const greens = find(answer, 'weekly greens');
  assert.equal(greens.cycle, 'weekly');
  assert.equal(greens.month, Math.round(((12 * 52) / 12) * 100) / 100);
});

test('trend says up, down, flat and new against the 30 days before', () => {
  const answer = run([bank([
    pay('u1', 'Uprise Co', 10, 40), pay('u2', 'Uprise Co', 20, 5),
    pay('d1', 'Slide LLC', 20, 40), pay('d2', 'Slide LLC', 10, 5),
    pay('f1', 'Steady Ltd', 100, 40), pay('f2', 'Steady Ltd', 102, 5),
    pay('n1', 'Newbie Inc', 9, 5),
  ])]);
  const up = find(answer, 'uprise');
  assert.deepEqual(up.trend, { last_30: 20, prior_30: 10, change: 'up', percent: 100 });
  const down = find(answer, 'slide');
  assert.deepEqual(down.trend, { last_30: 10, prior_30: 20, change: 'down', percent: -50 });
  assert.equal(find(answer, 'steady').trend.change, 'flat');
  const fresh = find(answer, 'newbie');
  assert.equal(fresh.trend.change, 'new');
  assert.equal(fresh.trend.percent, null);
});

test('a monthly bill charged twice within five days from different accounts is flagged, and a steady one is not', () => {
  const answer = run([bank([
    pay('a1', 'Dupe Svc', 15, 70, { account: 'acct-1' }),
    pay('a2', 'Dupe Svc', 15, 40, { account: 'acct-1' }),
    pay('a3', 'Dupe Svc', 15, 38, { account: 'acct-2' }),
    pay('a4', 'Dupe Svc', 15, 10, { account: 'acct-1' }),
    pay('s1', 'Solo Svc', 15, 70, { account: 'acct-1' }),
    pay('s2', 'Solo Svc', 15, 40, { account: 'acct-1' }),
    pay('s3', 'Solo Svc', 15, 10, { account: 'acct-1' }),
  ])]);
  assert.deepEqual(find(answer, 'dupe svc').flags, ['duplicate']);
  assert.deepEqual(find(answer, 'solo svc').flags, []);
});

test('two merchants that map to one vendor are both flagged as duplicates', () => {
  const connectors = [{ vendor: 'cloudflare', name: 'Cloudflare', domain: 'cloudflare.com' }];
  const answer = run([bank([pay('1', 'CLOUDFLARE* A', 5, 3), pay('2', 'Cloudflare Workers Inc', 8, 2)])], connectors);
  assert.equal(answer.merchants.length, 2);
  assert.ok(answer.merchants.every(merchant => merchant.vendor === 'cloudflare' && merchant.flags.includes('duplicate')));
});

test('payments older than the 90-day window are left out', () => {
  const answer = run([bank([pay('old', 'Old Shop', 50, 91), pay('new', 'Old Shop', 4, 89)])]);
  assert.equal(answer.merchants.length, 1);
  assert.deepEqual(answer.merchants[0].charges.map(charge => charge.id), ['new']);
  assert.equal(answer.total.days_90, 4);
});

test('a yearly plan charged a year ago stays with its cost a month, and a monthly one still shows its charges', () => {
  // Charged 375 and 10 days ago: the gap is a year, so it is yearly. Its 365-day-old charge is in the lookback, not the window.
  const answer = run([bank([
    pay('y1', 'Yearly Tool', 120, 375), pay('y2', 'Yearly Tool', 120, 10),
    pay('g1', 'Gym Club', 20, 40), pay('g2', 'Gym Club', 20, 10),
  ])]);
  const yearly = find(answer, 'yearly tool');
  assert.equal(yearly.cycle, 'yearly');
  assert.equal(yearly.month, 10);
  assert.deepEqual(yearly.charges.map(charge => charge.id), ['y2']);
  assert.equal(yearly.days_90, 120);
  assert.equal(find(answer, 'gym club').cycle, 'monthly');
  assert.equal(find(answer, 'gym club').charges.length, 2);
  // A merchant with no charge in the window that is not yearly is left out.
  assert.equal(run([bank([pay('o1', 'Lapsed Shop', 9, 200), pay('o2', 'Lapsed Shop', 9, 170)])]).merchants.length, 0);
});

test('merchants are sorted biggest monthly cost first, and the totals add them up', () => {
  const answer = run([bank([
    pay('1', 'Small One', 5, 10),
    pay('2', 'Big One', 50, 10),
    pay('3', 'Mid One', 20, 10),
    pay('4', 'Mid One', 20, 20),
  ])]);
  assert.deepEqual(answer.merchants.map(merchant => merchant.key), ['big one', 'mid one', 'small one']);
  // No billing cycle here (one charge, or two ten days apart), so each month is its 90 days over three.
  assert.equal(answer.merchants.find(merchant => merchant.key === 'mid one').month, round2(40 / 3));
  assert.equal(answer.total.month, round2(50 / 3 + 40 / 3 + 5 / 3));
  assert.equal(answer.total.days_90, 95);
});

const round2 = value => Math.round(value * 100) / 100;

test('a payee matched to a connection only by its web address keeps its own name', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const sources = [{ source: { id: 'mail', label: 'Mail', group: 'Mail', kind: 'mail' }, payments: [{ id: 'p1', merchant: 'Google', amount: 5, at: '2026-09-29T17:20:26Z' }] }];
  const { merchants } = merchantsFrom({ sources, connectors: [{ vendor: 'google-account', name: 'Gmail', domain: 'google.com' }], now });
  assert.equal(merchants[0].title, 'Google');
  assert.equal(merchants[0].vendor, 'google-account');
});
