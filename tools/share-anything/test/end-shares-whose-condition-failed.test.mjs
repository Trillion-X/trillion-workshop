// tools/share-anything/test/end-shares-whose-condition-failed.test.mjs
//
// The sweep that ends a run share when the person's own end rule says so, as a function of the runs its caller lists from the
// store. How long a share lasts is the person's choice and by default it has no end; the rule is kept beside the grant and the
// engine reads none of it, so a share ends when the sweep's write withdraws it. Every name, label and time is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { endOf, endSharesWhoseConditionFailed } from '../do-work/end-shares-whose-condition-failed.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { assertNoRecordReach, callSweep, callTool, memoryStore } from './caller-store.mjs';

const DAY = 86_400_000;
const T = Date.parse('2026-01-01T00:00:00.000Z');
const at = days => new Date(T + days * DAY).toISOString();
const share = (store, grant, rule, now) => callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:sample-a'], with: ['member-a'], ...rule, now });
const sweepRow = rows.records.find(row => row.payload.id === 'tool:end-shares-whose-condition-failed').payload;

test('a share with no rule never ends, however long it goes unused', async () => {
  const store = memoryStore();
  await share(store, 'sharing:no-rule', {}, at(0));
  const swept = await callSweep(store, at(100_000), { 'sharing:no-rule': null });
  assert.deepEqual(swept.ended, []);
  assert.equal(swept.never, 1);
  assert.notEqual(await store.get('sharing:no-rule'), null);
});

test('a share with an until ends at that time, however it is used', async () => {
  const store = memoryStore();
  await share(store, 'sharing:until', { until: at(10) }, at(0));
  assert.deepEqual((await callSweep(store, at(9), { 'sharing:until': at(8) })).ended, [], 'before its time it stands, used or not');
  const after = await callSweep(store, at(11), { 'sharing:until': at(8) });
  assert.deepEqual(after.ended, ['sharing:until']);
  assert.equal(await store.get('sharing:until'), null, 'the write withdrew it');
});

test('unused_days ends a share that is never used after the days, and each use starts the days again', async () => {
  const store = memoryStore();
  const labels = ['sharing:never-used', 'sharing:used-day-20', 'sharing:used-day-45'];
  for (const label of labels) await share(store, label, { unused_days: 30 }, at(0));
  const lastUsed = { 'sharing:never-used': null, 'sharing:used-day-20': at(20), 'sharing:used-day-45': at(45) };
  assert.deepEqual((await callSweep(store, at(29), lastUsed)).ended, [], 'inside the 30 days nothing is withdrawn');
  assert.deepEqual((await callSweep(store, at(31), lastUsed)).ended, ['sharing:never-used'], 'never used, it ends 30 days after the rule was set');
  assert.deepEqual((await callSweep(store, at(51), lastUsed)).ended, ['sharing:used-day-20'], 'used on day 20, it ends on day 50');
  assert.deepEqual((await callSweep(store, at(76), lastUsed)).ended, ['sharing:used-day-45'], 'used last on day 45, it ends on day 75');
});

test('a sweep with nothing listed withdraws nothing, and an unreadable end is counted as waiting', () => {
  assert.deepEqual(endSharesWhoseConditionFailed({ now: at(5) }).writes, []);
  const odd = endSharesWhoseConditionFailed({ now: at(500), runs: [{ label: 'sharing:odd', ends: { until: 'not a time', since: at(0) } }] });
  assert.deepEqual(odd.ended, []);
  assert.equal(odd.waiting, 1);
});

test('a rule set again by op end is the one the sweep reads, and a later share keeps it', async () => {
  const store = memoryStore();
  const label = 'sharing:rule-run';
  await share(store, label, { unused_days: 30 }, at(0));
  await callTool(store, { op: 'end', can: ['run'], grant: label, unused_days: 365, now: at(20) });
  assert.deepEqual((await callSweep(store, at(200), { [label]: null })).ended, [], 'the longer rule stands');
  await callTool(store, { op: 'end', can: ['run'], grant: label, until: at(210), now: at(200) });
  assert.deepEqual((await callSweep(store, at(211), { [label]: null })).ended, [label], 'the new until is past');
});

test('a share the store lists with no last use is judged by until alone and counted as unjudged', () => {
  const runs = [{ label: 'sharing:unjudged', ends: { unused_days: 30, since: at(0) } }];
  const answer = endSharesWhoseConditionFailed({ now: at(400), runs });
  assert.deepEqual(answer.ended, []);
  assert.equal(answer.unjudged, 1);
  assert.match(answer.said, /no last use/);
});

test('endOf reads the earlier of until and unused_days, and never ends a share with neither', () => {
  assert.equal(endOf({ since: at(0) }, at(1)), null);
  assert.deepEqual(endOf({ until: at(10), unused_days: 3, since: at(0) }, at(2)), { at: T + 5 * DAY, reason: 'unused' });
  assert.deepEqual(endOf({ until: at(4), unused_days: 30, since: at(0) }, at(2)), { at: T + 4 * DAY, reason: 'until' });
});

test('the sweep row is a function over its runs: its own invoke, no records door, and its withdrawals are writes', () => {
  assertNoRecordReach(sweepRow);
  assert.deepEqual(sweepRow.invoke.argv.slice(1), ['/opt/workflows/do-work/run-a-function.mjs', '/opt/share-anything/do-work/end-shares-whose-condition-failed.mjs', 'endSharesWhoseConditionFailed']);
  const ends = { until: at(30), since: at(0) };
  const answer = endSharesWhoseConditionFailed({ now: at(40), runs: [{ label: 'sharing:w', grant: { tools: [] }, people: [], ends, last_used: null }] });
  assert.deepEqual(answer.writes, [{ kind: 'run-share', address: 'sharing:w', value: null, expect: { grant: { tools: [] }, people: [], ends } }]);
});
