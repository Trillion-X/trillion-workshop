// The three rows of keep-copies-in-step over a person's own rows, against the records door stand-in
// (tools/records-door/test/fake-door.mjs), which checks rights and `expected` the way the engine does. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { KEPT_APART } from '../read-data/catch-up.mjs';
import settings from '../read-data/catch-up.json' with { type: 'json' };
import { sayHowThisDeviceStands, settleTwoVersions } from '../do-work/copies.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const SEE = rowOf(ROWS, 'tool:see-if-my-copies-are-in-step');
const HERE = rowOf(ROWS, 'tool:say-how-this-device-stands');
const SETTLE = rowOf(ROWS, 'tool:settle-two-versions');
const NOW = '2026-01-10T12:00:00.000Z';
const DEVICES = 'setting:catch_up_devices';

const note = (id, value) => ({ id, type: 'note', value });
const kept = (record, type, field, value) => ({ id: `${KEPT_APART}:${record}`, type: KEPT_APART, value: { [`${field}|sample`]: { record, record_type: type, field, value } } });
const PERSON = [
  { id: DEVICES, type: 'setting', value: { value: [{ device_id: 'd-sample01', title: 'Sample laptop', kind: 'computer', state: 'caught-up', waiting: 0, at: '2026-01-10T11:00:00.000Z', seen_at: '2026-01-10T11:00:00.000Z' }] } },
  note('plan-7', { title: 'Launch plan', due: 'Friday', status: 'Draft' }),
  kept('plan-7', 'note', 'due', 'Monday'),
  { id: 'task-3', type: 'task', value: { title: 'Sample task', done: false } },
  kept('task-3', 'task', 'done', true),
];

test('the read answers the devices and the note kept apart, and names the other kinds kept apart', async () => {
  const positions = [{ copy: 'sample-copy', settled_at: '2026-01-10T10:00:00.000Z' }];
  const { status, result } = await answerOf(SEE, { thing_type: 'note', positions }, { records: PERSON });
  assert.equal(status, 0);
  assert.deepEqual(result.devices.map(device => [device.device_id, device.state]), [['d-sample01', 'caught-up'], ['sample-copy', settings.copy_state]]);
  assert.equal(result.devices[1].title, settings.words.copy_title, 'a copy no device names is shown by itself, never by its id');
  assert.equal(result.versions.length, 1);
  const [apart] = result.versions;
  assert.deepEqual(apart.thing, { kind: 'note', id: 'plan-7', title: 'Launch plan' });
  assert.deepEqual(apart.sides.map(side => side.value.due), ['Friday', 'Monday']);
  assert.deepEqual(result.other_kinds, ['task']);
});

test('a read without the kind of record refuses and says what to send', async () => {
  // The row's rights fill from input.thing_type, so the engine never starts a run without it: the input fills the
  // rights, and the program is handed a standard input without the kind, to prove it refuses one all the same.
  const { status, error } = await answerOf(SEE, { thing_type: 'note' }, { records: PERSON, stdin: {} });
  assert.notEqual(status, 0);
  assert.match(error ?? '', /thing_type/);
});

test('a device report is written once, and again only when what the person sees changed', async () => {
  const report = { device_id: 'd-sample02', title: 'Sample phone', kind: 'phone', state: 'waiting', waiting: 2, request_key: 'report-1', now: NOW };
  const first = await answerOf(HERE, report, { records: PERSON });
  assert.equal(first.status, 0);
  assert.equal(first.result.written, true);
  const rows = first.kept.find(record => record.id === DEVICES).value.value;
  assert.deepEqual(rows.map(device => device.device_id), ['d-sample02', 'd-sample01'], 'newest first, the others kept');
  const again = await answerOf(HERE, { ...report, request_key: 'report-2' }, { records: first.kept });
  assert.equal(again.result.written, false, 'the same state is not written again');
  const refused = await answerOf(HERE, { device_id: 'x', state: 'caught-up', request_key: 'report-3' }, { records: PERSON });
  assert.match(refused.error ?? '', /which device/);
});

test('keep one writes the chosen version and removes the kept versions in one write', async () => {
  const { status, result, kept: after } = await answerOf(SETTLE, { id: `${KEPT_APART}:plan-7`, keep: 'one', side: 'kept-1', thing_type: 'note', request_key: 'settle-1' }, { records: PERSON });
  assert.equal(status, 0);
  assert.deepEqual(result.written, ['plan-7', `${KEPT_APART}:plan-7`]);
  const byId = new Map(after.map(record => [record.id, record]));
  assert.equal(byId.get('plan-7').value.due, 'Monday');
  assert.equal(byId.get(`${KEPT_APART}:plan-7`)?.value ?? null, null);
  assert.ok(byId.get(`${KEPT_APART}:task-3`), 'a version of another kind is left alone');
});

test('keep both keeps the other version under the first free name', async () => {
  const taken = note(`plan-7${settings.both_suffix}1`, { title: 'An unrelated sample' });
  const { status, result, kept: after } = await answerOf(SETTLE, { id: `${KEPT_APART}:plan-7`, keep: 'both', thing_type: 'note', request_key: 'settle-2' }, { records: [...PERSON, taken] });
  assert.equal(status, 0);
  assert.deepEqual(result.written, [`plan-7${settings.both_suffix}2`, `${KEPT_APART}:plan-7`]);
  const byId = new Map(after.map(record => [record.id, record]));
  assert.deepEqual(byId.get(`plan-7${settings.both_suffix}1`).value, taken.value);
  assert.equal(byId.get(`plan-7${settings.both_suffix}2`).value.due, 'Monday');
  assert.equal(byId.get('plan-7').value.due, 'Friday');
});

test('a record changed between the read and the write answers conflict and writes nothing', async () => {
  const fake = await startFakeDoor({ rights: SETTLE.invoke.records.rights.map(right => ({ ...right, kind: typeof right.kind === 'string' ? right.kind : 'note' })), records: PERSON });
  try {
    const door = openRecordsDoor({ descriptor: fake.descriptor });
    const racing = {
      ...door,
      async readRecord(type, id) {
        const held = await door.readRecord(type, id);
        if (id === 'plan-7') await door.write([{ id, type, value: { title: 'Launch plan', due: 'Sunday', status: 'Draft' } }], { key: 'other-device' });
        return held;
      },
    };
    const answer = await settleTwoVersions({ id: `${KEPT_APART}:plan-7`, keep: 'one', side: 'kept-1', thing_type: 'note', request_key: 'settle-3' }, { door: racing });
    assert.deepEqual(answer, { settled: null, written: [], conflict: true });
    assert.equal(fake.kept.get('plan-7').value.due, 'Sunday', 'the other device\'s write stands');
    assert.ok(fake.kept.get(`${KEPT_APART}:plan-7`).value, 'the kept versions stay');
  } finally { await fake.close(); }
});

test('the same device report sent again with its request key writes nothing twice', async () => {
  const fake = await startFakeDoor({ rights: HERE.invoke.records.rights, records: PERSON });
  try {
    const door = openRecordsDoor({ descriptor: fake.descriptor });
    const report = { device_id: 'd-sample03', state: 'offline', request_key: 'report-4', now: NOW };
    assert.equal((await sayHowThisDeviceStands(report, { door })).written, true);
    const once = fake.kept.get(DEVICES).value;
    await sayHowThisDeviceStands(report, { door });
    assert.deepEqual(fake.kept.get(DEVICES).value, once);
  } finally { await fake.close(); }
});
