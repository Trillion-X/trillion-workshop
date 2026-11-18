import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './policy-fixtures.json' with { type: 'json' };
import { createHQSharing } from '../read-data/hq-sharing.mjs';
import { createJourney } from '../read-data/journey.mjs';
import { createCustomersHQ } from '../read-data/customers-hq.mjs';

const DAY = 86400000;
const choices = createHQSharing(fixtures.sharing);
const journey = createJourney(fixtures.reports);

test('a choice that is not kept reads as the default, and only the signed-in account can change it', () => {
  assert.deepEqual(choices.sharingOf(null), { activity: true, content: false, set_at: null, via: 'default' });
  assert.deepEqual(choices.defaultSharing({ account: 'member', signedIn: 'member', kept: null, now: new Date('2026-11-01T00:00:00Z') }), {
    key: 'hq-sharing:member', value: { activity: true, content: false, set_at: '2026-11-01T00:00:00.000Z', via: 'sign_up' } });
  assert.equal(choices.defaultSharing({ account: 'member', signedIn: 'member', kept: { activity: false } }), null, 'a kept choice is never replaced by the default');
  assert.throws(() => choices.sharingChange({ account: 'other', signedIn: 'member', kept: null, patch: { activity: true } }), /signed-in account/);
  assert.throws(() => choices.defaultSharing({ account: 'other', signedIn: 'member', kept: null }), /signed-in account/);
});

test('content stays off until it is chosen, cannot be on while activity is off, and turning activity off asks for erasure', () => {
  const on = choices.sharingChange({ account: 'member', signedIn: 'member', kept: choices.sharingOf(null), patch: { content: true } });
  assert.deepEqual(on.value, { activity: true, content: true, set_at: on.value.set_at, via: 'settings' });
  assert.equal(on.erase, false);
  const off = choices.sharingChange({ account: 'member', signedIn: 'member', kept: on.value, patch: { activity: false } });
  assert.equal(off.value.content, false, 'turning activity off turns content off too');
  assert.equal(off.erase, true);
  assert.equal(off.activity_was, true);
  assert.equal(choices.sharingChange({ account: 'member', signedIn: 'member', kept: off.value, patch: { content: true } }).value.content, false);
  assert.deepEqual(choices.sharingKeys('member'), ['hq-sharing:member']);
});

test('a kept choice that cannot be read counts as off for content and as the default for activity', () => {
  assert.deepEqual(choices.sharingOf({ activity: 'yes', content: 'yes' }), { activity: true, content: false, set_at: null, via: 'default' });
});

test('journey rows keep only the facts a kind names, cut labels, and words only with content', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const events = [
    { kind: 'report', facts: { kind: 'bug', sent_by: 'ai', harness: 'Codex' }, words: { note: 'private', where: 'Files' }, at: now - 20 },
    { kind: 'client_error', facts: { path: '/files', category: 'script', email: 'a@example.com' }, at: now - 10 },
    { kind: 'made-up', facts: {} },
  ];
  assert.deepEqual(journey.journeyRows('a', events, { activity: true, content: false }, { now }), [
    { account: 'a', at: now - 20, surface: 'report', kind: 'report', label: 'bug', facts: { sent_by: 'ai', harness: 'Codex' } },
    { account: 'a', at: now - 10, surface: 'app', kind: 'client_error', label: '/files', facts: { category: 'script' } },
  ]);
  const withWords = journey.journeyRows('a', events.slice(0, 1), { activity: true, content: true }, { now });
  assert.deepEqual(withWords[0].facts.words, { where: 'Files', note: 'private' });
});

test('no journey rows are made for the operator account or for an account that shares no activity', () => {
  const events = [{ kind: 'tool_run', facts: { tool: 'x' } }];
  assert.deepEqual(journey.journeyRows('hq', events, { activity: true }, { operatorAccount: 'hq' }), []);
  assert.deepEqual(journey.journeyRows('member', events, { activity: false }), []);
  assert.deepEqual(journey.journeyRows('member', [], { activity: true }), []);
});

test('summaries keep trouble ordering, retention and word consent; sweep and erasure name the right rows', () => {
  const now = Date.now();
  const policy = fixtures.reports.journey;
  const rows = [
    ...journey.journeyRows('a', [
      { kind: 'report', facts: { kind: 'bug' }, words: { note: 'not allowed' }, at: now - 20 },
      { kind: 'client_error', facts: { path: '/files', category: 'script' }, at: now - 10 },
      { kind: 'tool_run', facts: { tool: 'old' }, at: now - (policy.keep_days + 1) * DAY },
    ], { activity: true, content: false }, { now }),
    ...journey.journeyRows('b', [{ kind: 'tool_run', facts: { tool: 'new' }, at: now }], { activity: true }, { now }),
  ].map((row, index) => ({ id: `row-${index}`, ...row }));
  const read = journey.summarizeJourneys(rows, now);
  assert.deepEqual(read.map(row => row.account), ['a', 'b']);
  assert.equal(read[0].struggling, true);
  assert.equal(read[0].total, 2);
  assert.equal(read[0].recent, 2);
  assert.deepEqual(read[0].by_kind, { client_error: 1, report: 1 });
  assert.deepEqual(read[0].timeline.map(row => row.kind), ['client_error', 'report']);
  assert.ok(!JSON.stringify(read).includes('not allowed'));
  assert.deepEqual(journey.expiredJourneyIds(rows, now), ['row-2']);
  assert.deepEqual(journey.journeyIdsOf(rows, 'a'), ['row-0', 'row-1', 'row-2']);
});

test('the Customers entry refuses every nonoperator before it reads reports or journeys, and gives the operator values', async () => {
  let reads = 0;
  const hq = createCustomersHQ(fixtures.reports, { htmlPage: (page, headers) => ({ page, headers }) });
  const env = { operatorAccount: 'hq', accountName: async () => null };
  const values = async () => { reads++; return { rows: [], journeys: [] }; };
  const url = new URL('https://app.example/work/api/customers');
  const request = new Request(url);
  const refused = await hq.answerCustomers(request, { env, userId: 'other', url, origin: url.origin, values });
  assert.equal(refused.status, 404);
  assert.equal(reads, 0);
  const allowed = await hq.answerCustomers(request, { env, userId: 'hq', url, origin: url.origin, values });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { reports: [], report_count: 0, customers: [] });
  assert.equal(reads, 1);
  assert.deepEqual(Object.values(hq.customersPage({ reports: [], customers: [] }, url.origin).headers), ['customer-scope']);
});
