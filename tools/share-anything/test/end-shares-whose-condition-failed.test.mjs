// tools/share-anything/test/end-shares-whose-condition-failed.test.mjs
//
// The sweep that ends a run share once the end its sharer gave it has passed, over a stand-in records door (tools/records-door/test/
// fake-door.mjs) that holds exactly the rights the sweep's row declares. The engine holds no end: a share ends when the sweep
// withdraws it. Every name, label and time is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { shareAnything } from '../do-work/share-anything.mjs';
import { endSharesWhoseConditionFailed } from '../do-work/end-shares-whose-condition-failed.mjs';
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

test('a share whose end has passed is withdrawn and its row removed, a share still inside its end and one with no end stand', async () => {
  const labels = ['sharing:ends-soon', 'sharing:ends-late', 'sharing:never-ends'];
  const { door, records_door, runGrants } = await open([...shareRights(labels), ...sweepRights]);
  try {
    await share(records_door, labels[0], '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    await share(records_door, labels[1], '2999-01-01T00:00:00.000Z');
    await share(records_door, labels[2]);
    assert.deepEqual(Object.keys(runGrants).sort(), [...labels].sort());
    assert.equal(door.kept.has('grant-end:sharing:never-ends'), false, 'a share given no end holds no condition row');

    const before = await endSharesWhoseConditionFailed({ now: '2026-01-01T12:00:00.000Z' }, { door: records_door });
    assert.deepEqual(before.ended, [], 'inside its end nothing is withdrawn');
    assert.equal(before.waiting, 2);
    assert.equal(Object.keys(runGrants).length, 3);

    const after = await endSharesWhoseConditionFailed({ now: '2026-01-03T00:00:00.000Z' }, { door: records_door });
    assert.deepEqual(after.ended, ['sharing:ends-soon']);
    assert.equal(after.waiting, 1);
    assert.deepEqual(Object.keys(runGrants).sort(), ['sharing:ends-late', 'sharing:never-ends'], 'the next call of the ended share is refused: it is no longer kept');
    assert.equal(door.kept.has('grant-end:sharing:ends-soon'), false, 'its condition row went with it');
    assert.equal(door.kept.has('grant-end:sharing:ends-late'), true);
    const again = await endSharesWhoseConditionFailed({ now: '2026-01-03T00:00:00.000Z' }, { door: records_door });
    assert.deepEqual(again.ended, [], 'a second sweep finds nothing to end');
    assert.equal(door.calls.filter(call => call.method === 'sharing.withdraw').length, 1, 'one withdrawal');
  } finally { await door.close(); }
});

test('a row that names no readable time is left alone, and a refused withdrawal removes no row', async () => {
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

test('the sweep row can only end or read a share, never keep one, and wakes every five minutes', async () => {
  assert.deepEqual(sweepRights[1], { grant: 'sharing:*', operations: ['sharing.withdraw', 'sharing.list'] });
  assert.deepEqual(sweepRights[0], { kind: 'grant-end', prefix: 'grant-end:', operations: ['records:list', 'records:write'] });
  assert.deepEqual(sweepRow.wakes, [{ id: 'every-five-minutes', on: { time: { every_ms: 300000 } }, budget: { steps: 1, wall_ms: 120000 } }]);
  const { door, records_door } = await open(sweepRights);
  try {
    await assert.rejects(() => records_door.sharing('sharing.keep', { label: 'sharing:x', on: true, sharing: { grant: {}, people: [] } }), /may not reach|refused/i);
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
