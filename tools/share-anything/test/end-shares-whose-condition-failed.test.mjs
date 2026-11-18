// tools/share-anything/test/end-shares-whose-condition-failed.test.mjs
//
// The sweep that ends a run share when the person's own end rule says so, over a stand-in records door
// (tools/records-door/test/fake-door.mjs) that holds exactly the rights the sweep's row declares. How long a share lasts is the
// person's choice and by default it has no end; the engine keeps the rule beside the grant and reads none of it, so a share
// ends when the sweep withdraws it. Every name, label and time is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { shareAnything } from '../do-work/share-anything.mjs';
import { endSharesWhoseConditionFailed, endOf } from '../do-work/end-shares-whose-condition-failed.mjs';
import data from '../read-data/share-anything.json' with { type: 'json' };
import rows from '../tool-rows.json' with { type: 'json' };

const shareRow = rows.records[0].payload;
const sweepRow = rows.records.find(row => row.payload.id === 'tool:end-shares-whose-condition-failed').payload;
const sweepRights = sweepRow.invoke.records.rights;
// The share tool's rights for the labels it is asked for, as its row declares them, and the sweep's, side by side on one door.
const shareRights = labels => labels.flatMap(label => shareRow.invoke.records.rights.map(right => ({
  ...right, ...(right.id && typeof right.id === 'object' ? { id: label } : {}),
})));

async function open(rights, runGrants = {}) {
  const door = await startFakeDoor({ rights, runGrants });
  return { door, records_door: openRecordsDoor({ descriptor: door.descriptor }), runGrants };
}
const share = (records_door, grant, rule, now) => shareAnything({ op: 'share', can: ['run'], grant, tools: ['tool:sample-a'], with: ['member-a'], ...rule, now }, { door: records_door });
const sweep = (records_door, now) => endSharesWhoseConditionFailed({ now }, { door: records_door });

const DAY = 86_400_000;
const T = Date.parse('2026-01-01T00:00:00.000Z');
const at = days => new Date(T + days * DAY).toISOString();
const both = labels => [...shareRights(labels), ...sweepRights];

test('a share with no rule never ends, however long it goes unused', async () => {
  const label = 'sharing:no-rule';
  const { door, records_door, runGrants } = await open(both([label]));
  try {
    const answer = await share(records_door, label, {}, at(0));
    assert.equal(answer.ends, null, 'no end by default');
    assert.equal(Object.hasOwn(runGrants[label], 'ends'), false, 'nothing is kept for an end');
    runGrants[label].last_used = null;
    const swept = await sweep(records_door, at(100_000));
    assert.deepEqual(swept.ended, []);
    assert.equal(swept.never, 1);
    assert.equal(Object.hasOwn(runGrants, label), true, 'it stands until the person stops it');
  } finally { await door.close(); }
});

test('an until rule ends the share once its time has passed', async () => {
  const label = 'sharing:until';
  const { door, records_door, runGrants } = await open(both([label]));
  try {
    await share(records_door, label, { until: at(10) }, at(0));
    assert.deepEqual(runGrants[label].ends, { until: at(10), since: at(0) }, 'the rule is kept beside the grant as given');
    runGrants[label].last_used = at(9);
    assert.deepEqual((await sweep(records_door, at(9))).ended, [], 'before its time it stands, used or not');
    assert.deepEqual((await sweep(records_door, at(11))).ended, [label]);
    assert.equal(Object.hasOwn(runGrants, label), false, 'withdrawn');
  } finally { await door.close(); }
});

test('an unused-days rule ends a share that many days after its last use, and each use starts the days again', async () => {
  const labels = ['sharing:never-used', 'sharing:used-day-20', 'sharing:used-daily'];
  const { door, records_door, runGrants } = await open(both(labels));
  try {
    for (const label of labels) await share(records_door, label, { unused_days: 30 }, at(0));
    runGrants[labels[0]].last_used = null;
    runGrants[labels[1]].last_used = at(20);
    runGrants[labels[2]].last_used = at(45);
    assert.deepEqual((await sweep(records_door, at(29))).ended, [], 'inside the 30 days nothing is withdrawn');
    assert.deepEqual((await sweep(records_door, at(31))).ended, [labels[0]], 'never used, it ends 30 days after the rule was set');
    assert.deepEqual((await sweep(records_door, at(51))).ended, [labels[1]], 'used on day 20, it ends on day 50');
    assert.deepEqual((await sweep(records_door, at(76))).ended, [labels[2]], 'used last on day 45, it ends on day 75');
    assert.equal(door.calls.filter(call => call.method === 'sharing.withdraw').length, 3, 'one withdrawal each');
  } finally { await door.close(); }
});

test('both rules together: the earlier end ends it', () => {
  const ends = { until: at(100), unused_days: 30, since: at(0) };
  assert.deepEqual(endOf(ends, at(10)), { at: T + 40 * DAY, reason: 'unused' });
  assert.deepEqual(endOf(ends, at(95)), { at: T + 100 * DAY, reason: 'until' });
  assert.equal(endOf({ since: at(0) }, null), null, 'a rule naming neither ends nothing');
});

test('the person changes a rule and the next sweep acts on it; removing it makes the share never end', async () => {
  const label = 'sharing:mine';
  const { door, records_door, runGrants } = await open(both([label]));
  try {
    const first = await share(records_door, label, { unused_days: 30 }, at(0));
    const key = first.people[0].key;
    runGrants[label].last_used = null;
    // Longer: 365 days instead of 30, set on day 20.
    const longer = await shareAnything({ op: 'end', can: ['run'], grant: label, unused_days: 365, now: at(20) }, { door: records_door });
    assert.deepEqual(longer.ends, { unused_days: 365, since: at(20) });
    assert.deepEqual((await sweep(records_door, at(200))).ended, [], 'the longer rule stands');
    assert.equal(runGrants[label].people[0].principal, 'member-a', 'the people stay');
    assert.equal(first.people[0].key, key);
    // Shorter: until day 210.
    await shareAnything({ op: 'end', can: ['run'], grant: label, until: at(210), now: at(200) }, { door: records_door });
    assert.deepEqual(runGrants[label].ends, { until: at(210), since: at(200) }, 'a new rule replaces the old one whole');
    // Removed: neither given, the share has no end, and a person added later does not bring one back.
    const none = await shareAnything({ op: 'end', can: ['run'], grant: label, now: at(205) }, { door: records_door });
    assert.equal(none.ends, null);
    assert.match(none.said, /no end/);
    assert.equal(Object.hasOwn(runGrants[label], 'ends'), false);
    await shareAnything({ op: 'share', can: ['run'], grant: label, tools: ['tool:sample-a'], with: ['member-b'], now: at(300) }, { door: records_door });
    assert.equal(Object.hasOwn(runGrants[label], 'ends'), false, 'the removal sticks');
    assert.deepEqual((await sweep(records_door, at(5000))).ended, []);
    assert.equal(Object.hasOwn(runGrants, label), true);
  } finally { await door.close(); }
});

test('adding a person or stopping one keeps the rule the share has', async () => {
  const label = 'sharing:team';
  const { door, records_door, runGrants } = await open(both([label]));
  try {
    await shareAnything({ op: 'share', can: ['run'], grant: label, tools: ['tool:sample-a'], with: ['member-a', 'member-b'], unused_days: 30, now: at(0) }, { door: records_door });
    await shareAnything({ op: 'share', can: ['run'], grant: label, tools: ['tool:sample-a'], with: ['member-c'], now: at(5) }, { door: records_door });
    assert.deepEqual(runGrants[label].ends, { unused_days: 30, since: at(0) });
    await shareAnything({ op: 'stop', can: ['run'], grant: label, principal: 'member-a' }, { door: records_door });
    assert.deepEqual(runGrants[label].ends, { unused_days: 30, since: at(0) });
    const seen = await shareAnything({ op: 'access', can: ['run'], grant: label, now: at(6) }, { door: records_door });
    assert.deepEqual(seen.ends, { unused_days: 30, since: at(0) });
    assert.match(seen.said, /30 days with no use/);
  } finally { await door.close(); }
});

test('a rule that cannot be read is left alone, a share listed with no last use is judged by its until alone, and a bad rule is refused', async () => {
  const { door, records_door, runGrants } = await open(sweepRights, {
    'sharing:odd': { label: 'sharing:odd', ends: { until: 'tomorrow' } },
    'sharing:no-fact': { label: 'sharing:no-fact', ends: { unused_days: 30, since: at(0) } },
    'sharing:no-fact-until': { label: 'sharing:no-fact-until', ends: { unused_days: 30, until: at(5), since: at(0) } },
    'other:outside': { label: 'other:outside', ends: { until: at(1) } },
  });
  try {
    const answer = await sweep(records_door, at(400));
    assert.deepEqual(answer.ended, ['sharing:no-fact-until'], 'its until still ends it; a share in use is never ended on a use that could not be read');
    assert.equal(answer.waiting, 2);
    assert.equal(answer.unjudged, 2);
    assert.match(answer.said, /2 shares have no last use the engine answers/);
    assert.equal(Object.hasOwn(runGrants, 'other:outside'), true, 'a share outside the sharing labels is never listed');
  } finally { await door.close(); }
  const label = 'sharing:bad-rule';
  const refused = await open(shareRights([label]));
  try {
    await assert.rejects(() => share(refused.records_door, label, { unused_days: 0 }, at(0)), /whole number of days/);
    await assert.rejects(() => share(refused.records_door, label, { until: at(-1) }, at(0)), /future time/);
    await assert.rejects(() => shareAnything({ op: 'end', can: ['view'], grant: label }, { door: refused.records_door }), /takes an end rule/);
    assert.equal(refused.door.calls.some(call => call.method === 'sharing.keep'), false);
  } finally { await refused.door.close(); }
});

test('the sweep row can only end or read a share, never keep one, and wakes at the engine\'s own grain of a last use', async () => {
  assert.deepEqual(sweepRights, [{ at: '@own-records', id: 'sharing:*', operations: ['sharing.withdraw', 'sharing.list'] }], 'no records right: the shares and their rules come from the engine\'s share list');
  assert.equal(data.run.check_every_ms, 3_600_000);
  assert.deepEqual(sweepRow.wakes, [{ id: 'check-unused-grants', on: { time: { every_ms: data.run.check_every_ms } }, budget: { steps: 1, wall_ms: 120000 } }]);
  const { door, records_door } = await open(sweepRights);
  try {
    await assert.rejects(() => records_door.sharing('sharing.keep', { label: 'sharing:x', on: true, sharing: { grant: {}, people: [] } }), /may not reach|refused/i);
  } finally { await door.close(); }
});

test('a sweep over many shares costs one list of them, so an hourly wake is cheap', async () => {
  const count = 2000;
  const grants = Object.fromEntries(Array.from({ length: count }, (_, index) => [`sharing:g${index}`,
    { label: `sharing:g${index}`, last_used: at(index % 80), ...(index % 2 ? { ends: { unused_days: 90, since: at(0) } } : {}) }]));
  const { door, records_door } = await open(sweepRights, grants);
  try {
    const started = performance.now();
    const answer = await sweep(records_door, at(89));
    const elapsed = performance.now() - started;
    assert.deepEqual([answer.ended.length, answer.waiting, answer.never], [0, count / 2, count / 2]);
    const calls = door.calls.reduce((all, call) => ({ ...all, [call.method]: (all[call.method] ?? 0) + 1 }), {});
    assert.equal(calls['sharing.list'], 1, 'one list of every share');
    assert.equal(calls['sharing.withdraw'] ?? 0, 0);
    // Reported, not asserted as a rate: measured on a stand-in door in one process.
    console.log(`sweep of ${count} shares: ${calls['sharing.list']} list, ${elapsed.toFixed(0)} ms in process`);
  } finally { await door.close(); }
});

test('a share kept before the engine stopped reading ends is kept again from its own people and then stands without one', async () => {
  const grant = 'sharing:team-tools';
  const oldKey = 'a'.repeat(64);
  const { door, records_door, runGrants } = await open(shareRights([grant]), {
    [grant]: { label: grant, party: 'jwt:fake-owner', grant: { tools: ['tool:sample-a'], identity: 'none', journal: 'input' },
      people: [{ principal: 'member-a', key_blake3: oldKey }], expires_at: '2999-01-01T00:00:00.000Z' },
  });
  try {
    await shareAnything({ op: 'share', can: ['run'], grant, tools: ['tool:sample-a'], with: ['member-b'] }, { door: records_door });
    const kept = runGrants[grant];
    assert.equal(Object.hasOwn(kept, 'expires_at') || Object.hasOwn(kept, 'ends'), false, 'kept again, the entry holds no end and no rule');
    assert.deepEqual(kept.people.map(person => person.principal), ['member-a', 'member-b']);
    assert.equal(kept.people[0].key_blake3, oldKey, 'the person already shared with keeps the key they have');
  } finally { await door.close(); }
});
