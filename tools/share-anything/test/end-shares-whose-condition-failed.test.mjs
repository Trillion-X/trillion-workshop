// tools/share-anything/test/end-shares-whose-condition-failed.test.mjs
//
// The sweep that ends a run share once its end has passed (the sharer's own `until`, or the default 90 days with no use), over a
// stand-in records door (tools/records-door/test/fake-door.mjs) that holds exactly the rights the sweep's row declares. The engine
// holds no end: a share ends when the sweep withdraws it. Every name, label and time is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { shareAnything } from '../do-work/share-anything.mjs';
import { endSharesWhoseConditionFailed } from '../do-work/end-shares-whose-condition-failed.mjs';
import { checkEveryMs, unusedDays, unusedMs, unusedSeconds } from '../read-data/access-ends-when-unused.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const shareRow = rows.records[0].payload;
const sweepRow = rows.records.find(row => row.payload.id === 'tool:end-shares-whose-condition-failed').payload;
const sweepRights = sweepRow.invoke.records.rights;
// The share tool's rights for the labels it is asked for, as its row declares them, and the sweep's, side by side on one door.
const shareRights = labels => labels.flatMap(label => shareRow.invoke.records.rights.map(right => ({
  ...right, ...(right.id && typeof right.id === 'object' ? { id: label } : {}),
  ...(right.grant && typeof right.grant === 'object' ? { grant: label } : {}),
})));

async function open(rights, runGrants = {}, records = []) {
  const door = await startFakeDoor({ rights, runGrants, records });
  return { door, records_door: openRecordsDoor({ descriptor: door.descriptor }), runGrants };
}
const share = (records_door, grant, until, now) => shareAnything({ op: 'share', can: ['run'], grant, tools: ['tool:sample-a'], with: ['member-a'], until, now }, { door: records_door });

const DAY = 86_400_000;
const T = Date.parse('2026-01-01T00:00:00.000Z');
const at = days => new Date(T + days * DAY).toISOString();
const wholeShareRights = labels => [...shareRights(labels), ...sweepRights];

test('the one default is 90 days, rendered to seconds for Better Auth and to a check cadence of a hundredth of it', () => {
  assert.equal(unusedDays, 90);
  assert.equal(unusedSeconds, 7_776_000);
  assert.equal(checkEveryMs, unusedMs / 100);
  assert.deepEqual(sweepRow.wakes, [{ id: 'check-unused-grants', on: { time: { every_ms: checkEveryMs } }, budget: { steps: 1, wall_ms: 120000 } }]);
});

test('every run share is written with its condition row before it is kept, and the row holds the default and the sharer\'s own end', async () => {
  const labels = ['sharing:ends-soon', 'sharing:never-ends'];
  const { door, records_door } = await open(wholeShareRights(labels));
  try {
    await share(records_door, labels[0], at(10), at(0));
    await share(records_door, labels[1], undefined, at(0));
    assert.deepEqual(door.kept.get('grant-end:sharing:ends-soon').value, { grant: labels[0], unused_days: 90, since: at(0), ends_at: at(10) });
    assert.deepEqual(door.kept.get('grant-end:sharing:never-ends').value, { grant: labels[1], unused_days: 90, since: at(0) }, 'a share given no end still holds the default');
    const order = door.calls.map(call => call.method).filter(method => ['records:write', 'sharing.keep'].includes(method));
    assert.deepEqual(order.slice(0, 2), ['records:write', 'sharing.keep'], 'the row is written first, so a grant never stands without it');
  } finally { await door.close(); }
});

test('a grant whose row cannot be written is not kept at all', async () => {
  const label = 'sharing:no-row';
  const { door, records_door, runGrants } = await open([...shareRights([label]).filter(right => right.kind !== 'grant-end')]);
  try {
    await assert.rejects(() => share(records_door, label, undefined, at(0)), /may not reach|refused/i);
    assert.equal(door.calls.some(call => call.method === 'sharing.keep'), false);
    assert.deepEqual(Object.keys(runGrants), []);
  } finally { await door.close(); }
});

test('an unused grant ends after its 90 days, a used one does not, and each use starts the days again', async () => {
  const labels = ['sharing:never-used', 'sharing:used-day-80', 'sharing:used-daily'];
  const { door, records_door, runGrants } = await open(wholeShareRights(labels));
  try {
    for (const label of labels) await share(records_door, label, undefined, at(0));
    runGrants[labels[0]].last_used = null;
    runGrants[labels[1]].last_used = at(80);
    runGrants[labels[2]].last_used = at(99);
    const before = await endSharesWhoseConditionFailed({ now: at(89) }, { door: records_door });
    assert.deepEqual(before.ended, [], 'inside the 90 days nothing is withdrawn');
    const day91 = await endSharesWhoseConditionFailed({ now: at(91) }, { door: records_door });
    assert.deepEqual(day91.ended, [labels[0]], 'the grant never used ends 90 days after it was made');
    assert.deepEqual(Object.keys(runGrants).sort(), [labels[1], labels[2]].sort());
    assert.equal(door.kept.has('grant-end:sharing:never-used'), false, 'its condition row went with it');
    assert.deepEqual(door.kept.get('grant-ended:sharing:never-used').value, { grant: labels[0], ended_at: at(91), reason: 'unused', unused_days: 90 }, 'the ended record the Connections page reads');
    const day171 = await endSharesWhoseConditionFailed({ now: at(171) }, { door: records_door });
    assert.deepEqual(day171.ended, [labels[1]], 'used on day 80, it ends on day 170: each use starts the 90 days again');
    assert.deepEqual(Object.keys(runGrants), [labels[2]]);
    const day189 = await endSharesWhoseConditionFailed({ now: at(189) }, { door: records_door });
    assert.deepEqual(day189.ended, [labels[2]], 'used last on day 99, it ends on day 189');
    assert.equal(door.calls.filter(call => call.method === 'sharing.withdraw').length, 3, 'one withdrawal each');
  } finally { await door.close(); }
});

test('a grant made again at an ended label clears its ended record, and a sweep finds nothing left', async () => {
  const label = 'sharing:again';
  const { door, records_door, runGrants } = await open(wholeShareRights([label]));
  try {
    await share(records_door, label, undefined, at(0));
    runGrants[label].last_used = null;
    await endSharesWhoseConditionFailed({ now: at(91) }, { door: records_door });
    assert.equal(door.kept.has(`grant-ended:${label}`), true);
    await share(records_door, label, undefined, at(100));
    assert.equal(door.kept.has(`grant-ended:${label}`), false, 'a new grant is not "ended"');
    assert.equal(door.kept.get(`grant-end:${label}`).value.since, at(100));
    const again = await endSharesWhoseConditionFailed({ now: at(101) }, { door: records_door });
    assert.deepEqual(again.ended, []);
  } finally { await door.close(); }
});

test('the person can edit their row or remove it, and neither is written back by a later share', async () => {
  const label = 'sharing:mine';
  const { door, records_door, runGrants } = await open(wholeShareRights([label]));
  try {
    await share(records_door, label, undefined, at(0));
    runGrants[label].last_used = null;
    // Longer: 365 days instead of 90.
    const row = door.kept.get(`grant-end:${label}`);
    row.value = { ...row.value, unused_days: 365 };
    assert.deepEqual((await endSharesWhoseConditionFailed({ now: at(200) }, { door: records_door })).ended, [], 'their longer window stands');
    // Removed: the grant has no end, and a second person added later does not bring the default back.
    door.kept.delete(`grant-end:${label}`);
    await shareAnything({ op: 'share', can: ['run'], grant: label, tools: ['tool:sample-a'], with: ['member-b'], now: at(300) }, { door: records_door });
    assert.equal(door.kept.has(`grant-end:${label}`), false, 'the removal sticks');
    assert.deepEqual((await endSharesWhoseConditionFailed({ now: at(2000) }, { door: records_door })).ended, []);
    assert.equal(Object.hasOwn(runGrants, label), true);
  } finally { await door.close(); }
});

test('a grant the engine lists with no last use is judged by its fixed end alone and said to be unjudged', async () => {
  const labels = ['sharing:no-fact', 'sharing:fixed-end'];
  const { door, records_door } = await open(wholeShareRights(labels));
  try {
    await share(records_door, labels[0], undefined, at(0));
    await share(records_door, labels[1], at(5), at(0));
    const answer = await endSharesWhoseConditionFailed({ now: at(400) }, { door: records_door });
    assert.deepEqual(answer.ended, [labels[1]], 'its own end still ends it; a share in use is never ended on a use that could not be read');
    assert.equal(answer.unjudged, 2);
    assert.match(answer.said, /2 grants have no last use the engine answers/);
  } finally { await door.close(); }
});

test('a row that names no readable end is left alone, and a refused withdrawal removes no row', async () => {
  const { door, records_door, runGrants } = await open(sweepRights, { 'sharing:a': { label: 'sharing:a' }, 'sharing:outside': { label: 'other:outside' } }, [
    { id: 'grant-end:sharing:a', type: 'grant-end', value: { grant: 'sharing:a', ends_at: 'tomorrow' } },
    { id: 'grant-end:other:outside', type: 'grant-end', value: { grant: 'other:outside', ends_at: '2020-01-01T00:00:00.000Z' } },
  ]);
  try {
    const answer = await endSharesWhoseConditionFailed({ now: '2026-01-01T00:00:00.000Z' }, { door: records_door });
    assert.deepEqual(answer.ended, []);
    assert.equal(answer.waiting, 2, 'an end that is not a time, and a grant outside the sharing labels, are counted as waiting');
    assert.equal(door.kept.size, 2);
    assert.equal(Object.keys(runGrants).length, 2);

    // A grant named by a row inside the sharing labels that the door will not withdraw (it is not this run's) stops the sweep.
    const refused = await open([sweepRights[0], { grant: 'sharing:only-this', operations: ['sharing.withdraw', 'sharing.list'] }], { 'sharing:other': { label: 'sharing:other' } }, [
      { id: 'grant-end:sharing:other', type: 'grant-end', value: { grant: 'sharing:other', ends_at: '2020-01-01T00:00:00.000Z' } },
    ]);
    try {
      await assert.rejects(() => endSharesWhoseConditionFailed({ now: '2026-01-01T00:00:00.000Z' }, { door: refused.records_door }), /may not reach|refused/i);
      assert.equal(refused.door.kept.has('grant-end:sharing:other'), true, 'its row stays, so the next sweep tries again');
      assert.equal(Object.hasOwn(refused.runGrants, 'sharing:other'), true);
    } finally { await refused.door.close(); }
  } finally { await door.close(); }
});

test('the sweep row can only end or read a share, never keep one, and writes only the rows of its own kinds', async () => {
  assert.deepEqual(sweepRights[2], { grant: 'sharing:*', operations: ['sharing.withdraw', 'sharing.list'] });
  assert.deepEqual(sweepRights[0], { kind: 'grant-end', prefix: 'grant-end:', operations: ['records:list', 'records:write'] });
  assert.deepEqual(sweepRights[1], { kind: 'grant-ended', prefix: 'grant-ended:', operations: ['records:write'] });
  const { door, records_door } = await open(sweepRights);
  try {
    await assert.rejects(() => records_door.sharing('sharing.keep', { label: 'sharing:x', on: true, sharing: { grant: {}, people: [] } }), /may not reach|refused/i);
  } finally { await door.close(); }
});

test('a sweep over many grants costs one list of rows and one read of each grant, so waking it every hundredth of the window is cheap', async () => {
  const count = 2000;
  const grants = Object.fromEntries(Array.from({ length: count }, (_, index) => [`sharing:g${index}`, { label: `sharing:g${index}`, last_used: at(index % 80) }]));
  const rows = Object.keys(grants).map(label => ({ id: `grant-end:${label}`, type: 'grant-end', value: { grant: label, unused_days: 90, since: at(0) } }));
  const { door, records_door } = await open(sweepRights, grants, rows);
  try {
    const started = performance.now();
    const answer = await endSharesWhoseConditionFailed({ now: at(89) }, { door: records_door });
    const elapsed = performance.now() - started;
    assert.equal(answer.ended.length, 0);
    assert.equal(answer.waiting, count);
    const calls = door.calls.reduce((all, call) => ({ ...all, [call.method]: (all[call.method] ?? 0) + 1 }), {});
    assert.equal(calls['sharing.list'], count, 'one read of each grant');
    assert.ok(calls['records:list'] >= 1 && calls['records:list'] <= Math.ceil(count / 100) + 1, `row pages: ${calls['records:list']}`);
    assert.equal(calls['sharing.withdraw'] ?? 0, 0);
    // Reported, not asserted as a rate: measured on a stand-in door in one process.
    console.log(`sweep of ${count} grants: ${calls['sharing.list']} grant reads, ${calls['records:list']} row pages, ${elapsed.toFixed(0)} ms in process`);
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
    assert.equal(Object.hasOwn(kept, 'expires_at'), false, 'kept again, the entry holds no end');
    assert.deepEqual(kept.people.map(person => person.principal), ['member-a', 'member-b']);
    assert.equal(kept.people[0].key_blake3, oldKey, 'the person already shared with keeps the key they have');
  } finally { await door.close(); }
});
