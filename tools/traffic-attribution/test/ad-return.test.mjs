// tools/traffic-attribution/test/ad-return.test.mjs
// Paid acquisition measured and fed back: what ad spend brings back per source, campaign or keyword
// (tool:measure-ad-return, through tools/unit-economics' formulas), ad click ids kept with the first touch and never
// offered as a breakdown, and conversions prepared for Meta's Conversions API and Google's Data Manager API
// (tool:prepare-ad-conversions). Each tool runs the way its row runs it: its argv, in the folder its workdir stands for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { browserTrafficVisit } from '../read-data/browser-traffic-visit.ts';
import { prepareAdConversions } from '../do-work/prepare-ad-conversions.mjs';

const tools = resolve(import.meta.dirname, '../..');
const rows = JSON.parse(readFileSync(resolve(tools, 'traffic-attribution/records.json'), 'utf8')).things.map(thing => thing.payload);

/** Run a tool by its row: each package_files item's `at` stands for that tool folder here, the whole input fills argv. */
function runBundled(toolId, input) {
  const row = rows.find(item => item.id === toolId);
  assert.ok(row, `${toolId} is a row in records.json`);
  const places = new Map([row.invoke.files.package_files].flat().map(item => [item.at, resolve(tools, item.package)]));
  assert.ok(places.has(row.invoke.workdir), `${toolId} runs in one of its own folders`);
  const argv = row.invoke.argv.map(item => (typeof item === 'string' ? item : JSON.stringify(input)));
  const ran = spawnSync(process.execPath, argv.slice(1), { cwd: places.get(row.invoke.workdir), encoding: 'utf8' });
  if (ran.status !== 0) return { refused: ran.stderr.trim() };
  return JSON.parse(ran.stdout.trim().split('\n').at(-1));
}

test('every row\'s sample run gives what its verify says', () => {
  for (const row of rows) {
    for (const check of row.verify.filter(item => item.kind === 'sample-run')) {
      const answer = runBundled(row.id, check.input);
      const picked = check.output_selector.slice(1).match(/[^.[\]]+/g).reduce((value, key) => value?.[key], answer);
      assert.ok(JSON.stringify(picked).includes(check.contains), `${row.id}: ${check.output_selector} contains ${check.contains}`);
    }
  }
});

// $1,000 on Google brings 200 visitors, 50 sign-ups and 10 customers paying $100 a month; $300 on Facebook brings 100
// visitors, 10 sign-ups and 1 customer; 40 visitors come direct and 3 of them pay. 80% gross margin, 10% monthly churn.
function fixture() {
  const visits = [];
  const conversions = [];
  const people = (prefix, count, signals, signups, payers) => {
    for (let at = 0; at < count; at += 1) {
      const visitor = `${prefix}${at}`;
      visits.push({ visitor, signals: { ...signals, ...(signals.source === 'google' ? { gclid: `Cj0K${at}` } : {}) } });
      if (at < signups) conversions.push({ visitor, outcome: 'signup' });
      if (at < payers) conversions.push({ visitor, outcome: 'payment', value: 100 });
    }
  };
  people('g', 200, { source: 'google', utm_campaign: 'crm for dentists' }, 50, 10);
  people('f', 100, { source: 'facebook', utm_campaign: 'creative-07' }, 10, 1);
  people('d', 40, { source: 'direct' }, 0, 3);
  return {
    project: { id: 'acme', outcomes: ['signup', 'payment'] },
    visits, conversions,
    paying_outcome: 'payment', signup_outcome: 'signup', gross_margin: 0.8, monthly_churn: 0.1,
    spend: [{ source: 'google', amount: 1000 }, { source: 'facebook', amount: 300 }],
  };
}

test('CAC, LTV, LTV:CAC and payback per source, the paid total and the blended total', () => {
  const answer = runBundled('tool:measure-ad-return', fixture());
  const pick = ({ value, spend, visitors, signups, customers, revenue, cost_per_signup, cac, revenue_per_customer_per_month, ltv, ltv_to_cac, payback_months, meets_target }) => ({ value, spend, visitors, signups, customers, revenue, cost_per_signup, cac, revenue_per_customer_per_month, ltv, ltv_to_cac, payback_months, meets_target });
  assert.deepEqual(answer.rows.map(pick), [
    // CAC 1000/10 = 100; contribution 100 x 0.8 = 80 a month; lifetime 1/0.1 = 10 months; LTV 800; 8x; payback 100/80.
    { value: 'google', spend: 1000, visitors: 200, signups: 50, customers: 10, revenue: 1000, cost_per_signup: 20, cac: 100, revenue_per_customer_per_month: 100, ltv: 800, ltv_to_cac: 8, payback_months: 1.25, meets_target: true },
    // CAC 300; LTV 800; 2.67x, below 5x; payback 300/80.
    { value: 'facebook', spend: 300, visitors: 100, signups: 10, customers: 1, revenue: 100, cost_per_signup: 30, cac: 300, revenue_per_customer_per_month: 100, ltv: 800, ltv_to_cac: 2.67, payback_months: 3.75, meets_target: false },
    { value: 'direct', spend: null, visitors: 40, signups: 0, customers: 3, revenue: 300, cost_per_signup: null, cac: null, revenue_per_customer_per_month: 100, ltv: 800, ltv_to_cac: null, payback_months: null, meets_target: null },
  ]);
  assert.deepEqual(pick(answer.paid), { value: 'Paid', spend: 1300, visitors: 300, signups: 60, customers: 11, revenue: 1100, cost_per_signup: 21.67, cac: 118.18, revenue_per_customer_per_month: 100, ltv: 800, ltv_to_cac: 6.77, payback_months: 1.48, meets_target: true });
  assert.equal(answer.total.customers, 14, 'the blended total counts the direct customers too');
  assert.equal(answer.total.cac, 92.86);
  assert.equal(answer.rows[1].display.meets_target, 'Below 5x');
  assert.equal(answer.rows[0].display.cac, '$100.00');
  assert.deepEqual(answer.spend_from, [{ from: 'entered', rows: 2, amount: 1300 }]);
});

test('spend read from the Meta Ads and Google Ads answers joins visits by campaign', () => {
  const input = {
    ...fixture(), break_down_by: 'utm_campaign', spend: undefined,
    spend_answers: [
      { shape: 'meta-ads-campaign-spend', facts: { source: 'facebook' }, answer: { data: [{ campaign_id: '120', campaign_name: 'creative-07', spend: '300.00', account_currency: 'USD', date_start: '2026-10-01', date_stop: '2026-10-15' }, { campaign_id: '121', campaign_name: 'creative-08', spend: '45.50', account_currency: 'USD' }], paging: {} } },
      { shape: 'google-ads-campaign-spend', facts: { source: 'google' }, answer: { results: [{ campaign: { id: '987', name: 'crm for dentists' }, customer: { currencyCode: 'USD' }, metrics: { costMicros: '1000000000', clicks: '412' } }] } },
    ],
  };
  delete input.spend;
  const answer = runBundled('tool:measure-ad-return', input);
  const byValue = Object.fromEntries(answer.rows.map(row => [row.value, row]));
  assert.equal(byValue['crm for dentists'].spend, 1000, 'Google gives micros; 1,000,000,000 micros is $1,000');
  assert.equal(byValue['crm for dentists'].ltv_to_cac, 8);
  assert.equal(byValue['creative-07'].spend, 300);
  assert.equal(byValue['creative-08'].spend, 45.5, 'a campaign that spent and brought nobody is still a row');
  assert.equal(byValue['creative-08'].visitors, 0);
  assert.equal(byValue['(not tagged)'].visitors, 40, 'visitors with no campaign are counted, not dropped');
  assert.deepEqual(answer.spend_from.map(item => [item.rows, item.amount]), [[2, 345.5], [1, 1000]]);
});

test('what the numbers cannot give is null and said, never a made-up figure', () => {
  const { gross_margin: _margin, spend: _spend, ...input } = fixture();
  const answer = runBundled('tool:measure-ad-return', input);
  assert.equal(answer.total.ltv, null);
  assert.equal(answer.total.cac, null);
  assert.ok(answer.unknown.some(line => /gross_margin/.test(line)));
  assert.ok(answer.unknown.some(line => /No spend was given/.test(line)));
});

test('spend in another currency, a click-id breakdown and an unknown spend shape are refused by name', () => {
  assert.match(runBundled('tool:measure-ad-return', { ...fixture(), spend: [{ source: 'google', amount: 10, currency: 'EUR' }] }).refused, /Spend is in EUR but the project counts revenue in USD/);
  assert.match(runBundled('tool:measure-ad-return', { ...fixture(), break_down_by: 'gclid' }).refused, /gclid is an ad click id/);
  assert.match(runBundled('tool:measure-ad-return', { ...fixture(), spend_answers: [{ shape: 'tiktok', answer: {} }] }).refused, /shape must be one of/);
  assert.match(runBundled('tool:measure-ad-return', { ...fixture(), paying_outcome: '' }).refused, /paying_outcome must name/);
});

test('a click id stays with the first touch and is never offered as a breakdown', () => {
  const answer = runBundled('tool:break-down-visits-and-sales', { project: { id: 'acme' }, visits: [{ visitor: 'v1', signals: { source: 'google', gclid: 'Cj0K1', utm_campaign: 'a' } }, { visitor: 'v2', signals: { source: 'facebook', fbclid: 'IwAR', fbc: 'fb.1.1.IwAR' } }] });
  assert.deepEqual(answer.can_break_down_by, ['source', 'utm_campaign']);
});

test('the browser capture keeps the Meta cookies and makes fbc from fbclid, within the signal limits', () => {
  const stored = new Map();
  const io = cookies => ({ search: '?utm_source=facebook&fbclid=IwAR0abc', referrer: '', getStored: key => stored.get(key) ?? null, setStored: (key, value) => stored.set(key, value), generateObserverId: () => 'obs1', now: '2026-10-15T10:00:00.000Z', getCookie: name => cookies[name] });
  const made = browserTrafficVisit('acme', io({ _fbp: 'fb.1.1700000000000.42' }));
  assert.equal(made.signals.fbclid, 'IwAR0abc');
  assert.equal(made.signals.fbp, 'fb.1.1700000000000.42');
  assert.equal(made.signals.fbc, `fb.1.${Date.parse('2026-10-15T10:00:00.000Z')}.IwAR0abc`);
  stored.clear();
  const kept = browserTrafficVisit('acme', io({ _fbc: 'fb.1.1690000000000.IwAR0abc' }));
  assert.equal(kept.signals.fbc, 'fb.1.1690000000000.IwAR0abc', 'the cookie Meta set wins over a made one');
  stored.clear();
  const long = browserTrafficVisit('acme', io({ _fbp: 'x'.repeat(300) }));
  assert.equal(long.signals.fbp, undefined, 'a value over the signal size limit is not kept');
});

const sha = value => createHash('sha256').update(value).digest('hex');
const destinations = [
  { id: 'meta', shape: 'meta-conversions-api', on: true, account: { pixel_id: '555' }, events: { signup: 'CompleteRegistration', payment: 'Purchase' } },
  { id: 'google', shape: 'google-ads-conversions', on: true, account: { operating_account_id: '1234567890' }, events: { signup: '111', payment: '222' } },
];
const conversionInput = () => ({
  project: { id: 'acme' },
  destinations,
  visits: [
    { visitor: 'v1', signals: { source: 'google', gclid: 'Cj0KCQ' }, at: '2026-10-14T09:00:00Z' },
    { visitor: 'v2', signals: { source: 'facebook', fbclid: 'IwAR0x', fbp: 'fb.1.1.2' }, at: '2026-10-14T08:00:00Z' },
    { visitor: 'v3', signals: { source: 'direct' } },
  ],
  conversions: [
    { visitor: 'v1', outcome: 'signup', at: '2026-10-14T09:05:00Z', email: ' Jo.Doe+ads@Gmail.com ' },
    { visitor: 'v1', outcome: 'payment', at: '2026-10-15T09:05:00Z', value: 100, event_id: 'inv_1' },
    { visitor: 'v2', outcome: 'payment', at: '2026-10-15T10:00:00Z', value: 100, phone: '+1 (650) 555-1212' },
    { visitor: 'v3', outcome: 'signup', at: '2026-10-01T00:00:00Z' },
  ],
  now: '2026-10-16T00:00:00Z',
});

test('sending conversions is off until a destination is turned on', () => {
  for (const off of [undefined, [], [{ ...destinations[0], on: false }], [{ ...destinations[0], on: 'yes' }]]) {
    const answer = prepareAdConversions({ ...conversionInput(), destinations: off });
    assert.deepEqual(answer.sends, []);
    assert.match(answer.said, /off for this project/);
  }
});

test('each platform gets its own event shape, hashed by its own rule, with the first touch click ids', () => {
  const answer = prepareAdConversions(conversionInput());
  const meta = answer.sends.find(send => send.destination === 'meta');
  assert.equal(meta.tool_id, 'tool:meta-ads-send-conversion-events');
  assert.equal(meta.input.pixel_id, '555');
  assert.deepEqual(meta.input.data, [
    { event_name: 'CompleteRegistration', event_time: Date.parse('2026-10-14T09:05:00Z') / 1000, event_id: 'acme:v1:signup', action_source: 'website', user_data: { em: [sha('jo.doe+ads@gmail.com')] }, custom_data: { currency: 'USD' } },
    { event_name: 'Purchase', event_time: Date.parse('2026-10-15T10:00:00Z') / 1000, event_id: 'acme:v2:payment', action_source: 'website', user_data: { ph: [sha('16505551212')], fbc: `fb.1.${Date.parse('2026-10-14T08:00:00Z')}.IwAR0x`, fbp: 'fb.1.1.2' }, custom_data: { value: 100, currency: 'USD' } },
  ]);
  const google = Object.fromEntries(answer.sends.filter(send => send.destination === 'google').map(send => [send.input.conversion_action_id, send]));
  assert.equal(google['111'].tool_id, 'tool:google-ads-send-conversions');
  assert.deepEqual(google['111'].input.events, [{ transactionId: 'acme:v1:signup', eventTimestamp: '2026-10-14T09:05:00.000Z', eventSource: 'WEB', currency: 'USD', adIdentifiers: { gclid: 'Cj0KCQ' }, userData: { userIdentifiers: [{ emailAddress: sha('jodoe@gmail.com') }] } }]);
  assert.deepEqual(google['222'].input.events.map(event => event.transactionId), ['inv_1', 'acme:v2:payment']);
  assert.deepEqual(google['222'].input.events[1].userData, { userIdentifiers: [{ phoneNumber: sha('+16505551212') }] });
  assert.equal(google['222'].input.operating_account_id, '1234567890');
  const text = JSON.stringify(answer);
  assert.ok(!/jo\.?doe|5551212|555-1212/i.test(text), 'no plain email or phone leaves the tool');
  assert.deepEqual(answer.skipped.map(item => [item.destination, item.visitor, item.why.slice(0, 40)]), [
    ['meta', 'v1', 'Meta Conversions API matches an event by'],
    ['meta', 'v3', 'Meta Conversions API takes events up to '],
    ['google', 'v3', 'Google Ads conversions (Data Manager API'],
  ]);
  assert.deepEqual(prepareAdConversions(conversionInput()), answer, 'the same conversions prepare the same events, so a retry is counted once');
});

test('repeats need their own event id, a phone needs its country, and sends are cut to the platform limit', () => {
  const input = conversionInput();
  input.conversions = [input.conversions[1], { ...input.conversions[1] }, { visitor: 'v1', outcome: 'signup', at: '2026-10-15T00:00:00Z', phone: '650 555 1212' }];
  const answer = prepareAdConversions(input);
  assert.ok(answer.skipped.some(item => item.conversion === 1 && /event id inv_1/.test(item.why)));
  assert.ok(answer.skipped.some(item => item.conversion === 2 && /international form/.test(item.why)));
  const many = conversionInput();
  many.visits = Array.from({ length: 2501 }, (_, at) => ({ visitor: `v${at}`, signals: { gclid: `G${at}`, fbc: `fb.1.1.${at}` } }));
  many.conversions = many.visits.map(({ visitor }) => ({ visitor, outcome: 'payment', at: '2026-10-15T00:00:00Z', value: 100 }));
  const sends = prepareAdConversions(many).sends;
  assert.deepEqual(sends.filter(send => send.destination === 'meta').map(send => send.events), [1000, 1000, 501]);
  assert.deepEqual(sends.filter(send => send.destination === 'google').map(send => send.events), [2000, 501]);
  assert.throws(() => prepareAdConversions({ ...conversionInput(), destinations: [{ ...destinations[1], account: {} }] }), /needs account.operating_account_id/);
});
