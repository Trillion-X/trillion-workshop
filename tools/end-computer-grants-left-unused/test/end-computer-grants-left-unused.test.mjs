// tools/end-computer-grants-left-unused/test/end-computer-grants-left-unused.test.mjs
//
// The sweep that ends a computer grant left unused and reminds the person first, over a stand-in records door
// (tools/records-door/test/fake-door.mjs) that holds exactly the rights the sweep's row declares and answers the engine's
// computer grants door the way it does: a grant is listed with when it was accepted and last used, a withdraw only ends it, and
// nothing a run is given makes one. Every tool, capability and time is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { endComputerGrantsLeftUnused } from '../do-work/end-computer-grants-left-unused.mjs';
import data from '../read-data/end-computer-grants-left-unused.json' with { type: 'json' };
import rows from '../tool-rows.json' with { type: 'json' };

const row = rows.records.find(entry => entry.payload.id === 'tool:end-computer-grants-left-unused').payload;
const rights = row.invoke.records.rights;
const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const ago = days => NOW - days * DAY;
const reminderId = (tool, capability, since) => `${data.reminder.prefix}${encodeURIComponent(tool)}:${encodeURIComponent(capability)}:${since}`;
const sweep = (records_door, input = {}) => endComputerGrantsLeftUnused({ now: new Date(NOW).toISOString(), ...input }, { door: records_door });

async function open(computerGrants, records = [], doorRights = rights) {
  const door = await startFakeDoor({ rights: doorRights, computerGrants, records });
  return { door, records_door: openRecordsDoor({ descriptor: door.descriptor }) };
}

test('a grant unused for the window is withdrawn, one inside it is kept, and a use moves the window', async () => {
  const { door, records_door } = await open({
    'tool:sample-a': [{ capability: 'read-a-folder', granted_at: ago(100), last_used: null }],
    'tool:sample-b': [{ capability: 'read-a-folder', granted_at: ago(100), last_used: ago(10) }],
    'tool:sample-c': [{ capability: 'read-a-folder', granted_at: ago(30), last_used: null }],
  });
  try {
    const answer = await sweep(records_door);
    assert.deepEqual(answer.ended, ['tool:sample-a read-a-folder'], 'accepted 100 days ago and never used');
    assert.equal(answer.waiting, 2);
    assert.deepEqual(door.computerGrants['tool:sample-a'], [], 'its next run finds no grant');
    assert.equal(door.computerGrants['tool:sample-b'].length, 1, 'used 10 days ago, accepted 100 days ago: the use renewed it');
    assert.equal(door.computerGrants['tool:sample-c'].length, 1);
    const again = await sweep(records_door);
    assert.deepEqual(again.ended, [], 'a second sweep finds nothing more to end');
    assert.equal(door.calls.filter(call => call.method === 'grants:withdraw').length, 1, 'one withdrawal');
  } finally { await door.close(); }
});

test('the window and the reminder come from the data and may be given other days', async () => {
  const { door, records_door } = await open({ 'tool:sample-a': [{ capability: 'read-a-folder', granted_at: ago(20), last_used: null }] });
  try {
    assert.equal(data.unused_days, 90);
    assert.equal(data.remind_days, 7);
    assert.deepEqual((await sweep(records_door)).ended, [], '20 days is inside ninety');
    assert.deepEqual((await sweep(records_door, { unused_days: 15, remind_days: 2 })).ended, ['tool:sample-a read-a-folder']);
    await assert.rejects(() => sweep(records_door, { unused_days: 10, remind_days: 10 }), /fewer than unused_days/);
    await assert.rejects(() => sweep(records_door, { unused_days: 'ninety' }), /number of days/);
  } finally { await door.close(); }
});

test('a reminder is made once a week before the end, left as the person leaves it, and removed when the grant is used or ended', async () => {
  const since = ago(85);
  const { door, records_door } = await open({ 'tool:sample-a': [{ capability: 'read-a-folder', granted_at: since, last_used: null }] });
  const id = reminderId('tool:sample-a', 'read-a-folder', since);
  try {
    const first = await sweep(records_door);
    assert.equal(first.reminded, 1);
    assert.deepEqual(first.ended, []);
    const made = door.kept.get(id);
    assert.equal(made.type, data.reminder.kind);
    assert.deepEqual(made.value.collection_id, [data.reminder.list]);
    assert.match(made.value.title, /tool:sample-a/);
    assert.match(made.value.title, /2026-06-06/, 'it names the day the grant ends');
    // The person finished the task: a later sweep does not make it again.
    door.kept.set(id, { ...made, value: { ...made.value, done: true } });
    assert.equal((await sweep(records_door)).reminded, 0);
    assert.equal(door.kept.get(id).value.done, true);
    // A use between two sweeps renews the grant, so the reminder is stale and goes.
    door.computerGrants['tool:sample-a'][0].last_used = ago(1);
    const renewed = await sweep(records_door);
    assert.equal(renewed.reminded, 0);
    assert.equal(door.kept.has(id), false, 'the grant was used since');
    // Left unused past the window, the grant ends and its reminder is gone with it.
    const second = await sweep(records_door, { now: new Date(NOW + 100 * DAY).toISOString() });
    assert.deepEqual(second.ended, ['tool:sample-a read-a-folder']);
    assert.equal([...door.kept.keys()].filter(key => key.startsWith(data.reminder.prefix)).length, 0);
  } finally { await door.close(); }
});

test('a grant that names no time is left alone, one the engine holds as nothing is not touched, and a refused withdrawal writes no reminder', async () => {
  const { door, records_door } = await open({
    'tool:sample-a': [{ capability: 'read-a-folder', granted_at: null, last_used: null }],
    'tool:sample-b': [{ capability: 'read-a-folder', granted: false, unread: 'until', granted_at: ago(500), last_used: null }],
  });
  try {
    const answer = await sweep(records_door);
    assert.deepEqual(answer.ended, []);
    assert.equal(answer.waiting, 1, 'no readable time counts as waiting');
    assert.equal(door.computerGrants['tool:sample-b'].length, 1, 'a grant that holds nothing as it stands is the person\'s to offer again');
    assert.equal(door.calls.filter(call => call.method === 'grants:withdraw').length, 0);
  } finally { await door.close(); }
  const narrow = await open({ 'tool:other': [{ capability: 'read-a-folder', granted_at: ago(500), last_used: null }] },
    [], [rights[0], { 'computer-grant': 'tool:only-this', operations: ['grants:withdraw', 'grants:list'] }]);
  try {
    await assert.rejects(() => sweep(narrow.records_door), /may not reach|refused/i);
    assert.equal(narrow.door.computerGrants['tool:other'].length, 1);
  } finally { await narrow.door.close(); }
});

test('the sweep row can only end or read computer grants, never make one, and wakes every six hours', async () => {
  assert.deepEqual(rights[1], { 'computer-grant': '*', operations: ['grants:withdraw', 'grants:list'] });
  assert.deepEqual(rights[0], { kind: data.reminder.kind, prefix: data.reminder.prefix, operations: ['records:list', 'records:write'] });
  assert.deepEqual(row.wakes, [{ id: 'every-six-hours', on: { time: { every_ms: 21_600_000 } }, budget: { steps: 1, wall_ms: 120_000 } }]);
  const { door, records_door } = await open({ 'tool:sample-a': [{ capability: 'read-a-folder', granted_at: ago(1), last_used: null }] });
  try {
    await assert.rejects(() => records_door.computerGrants('grants:grant', { offer: 'x' }), /refused/i);
    await assert.rejects(() => records_door.computerGrants('grants:withdraw', { capability: 'read-a-folder' }), /refused/i);
    const noGrantsRight = await open({}, [], [rights[0]]);
    try {
      await assert.rejects(() => noGrantsRight.records_door.computerGrants('grants:list', {}), /not handed the computer grants/);
    } finally { await noGrantsRight.door.close(); }
  } finally { await door.close(); }
});
