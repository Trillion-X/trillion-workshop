// The three rows of keep-copies-in-step over the rows a request carries. No row is handed a records door: what they
// work from is in the request and what to keep is in the answer. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import { KEPT_APART } from '../read-data/catch-up.mjs';
import settings from '../read-data/catch-up.json' with { type: 'json' };
import { seeIfMyCopiesAreInStep, sayHowThisDeviceStands, settleTwoVersions } from '../do-work/copies.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
const SEE = rowOf(ROWS, 'tool:see-if-my-copies-are-in-step');
const HERE = rowOf(ROWS, 'tool:say-how-this-device-stands');
const SETTLE = rowOf(ROWS, 'tool:settle-two-versions');
const NOW = '2026-01-10T12:00:00.000Z';

const note = (id, value) => ({ id, type: 'note', value });
const kept = (record, type, field, value) => ({ id: `${KEPT_APART}:${record}`, type: KEPT_APART, value: { [`${field}|sample`]: { record, record_type: type, field, value } } });
const DEVICES = [{ device_id: 'd-sample01', title: 'Sample laptop', kind: 'computer', state: 'caught-up', waiting: 0, at: '2026-01-10T11:00:00.000Z', seen_at: '2026-01-10T11:00:00.000Z' }];
const PERSON = [
  note('plan-7', { title: 'Launch plan', due: 'Friday', status: 'Draft' }),
  kept('plan-7', 'note', 'due', 'Monday'),
  { id: 'task-3', type: 'task', value: { title: 'Sample task', done: false } },
  kept('task-3', 'task', 'done', true),
];

test('the read answers the devices and the note kept apart, and names the other kinds kept apart', () => {
  const positions = [{ copy: 'sample-copy', settled_at: '2026-01-10T10:00:00.000Z' }];
  const result = seeIfMyCopiesAreInStep({ thing_type: 'note', positions, devices: DEVICES, records: PERSON });
  assert.deepEqual(result.devices.map(device => [device.device_id, device.state]), [['d-sample01', 'caught-up'], ['sample-copy', settings.copy_state]]);
  assert.equal(result.devices[1].title, settings.words.copy_title, 'a copy no device names is shown by itself, never by its id');
  assert.equal(result.versions.length, 1);
  const [apart] = result.versions;
  assert.deepEqual(apart.thing, { kind: 'note', id: 'plan-7', title: 'Launch plan' });
  assert.deepEqual(apart.sides.map(side => side.value.due), ['Friday', 'Monday']);
  assert.deepEqual(result.other_kinds, ['task']);
});

test('a read without the kind of record refuses and says what to send', () => {
  assert.throws(() => seeIfMyCopiesAreInStep({ devices: DEVICES, records: PERSON }), /thing_type/);
  assert.throws(() => seeIfMyCopiesAreInStep({ thing_type: 'note', records: 'none' }), /records is a list/);
});

test('a device report is answered as the next device list, and as nothing to write when what the person sees did not change', () => {
  const report = { device_id: 'd-sample02', title: 'Sample phone', kind: 'phone', state: 'waiting', waiting: 2, now: NOW, devices: DEVICES };
  const first = sayHowThisDeviceStands(report);
  assert.equal(first.written, true);
  assert.deepEqual(first.devices.map(device => device.device_id), ['d-sample02', 'd-sample01'], 'newest first, the others kept');
  const again = sayHowThisDeviceStands({ ...report, devices: first.devices });
  assert.equal(again.written, false, 'the same state is not written again');
  assert.equal(again.devices, undefined);
  assert.throws(() => sayHowThisDeviceStands({ device_id: 'x', state: 'caught-up', devices: DEVICES }), /which device/);
});

test('keep one answers the chosen version and the removal of the kept versions, each standing on what was handed in', () => {
  const result = settleTwoVersions({ id: `${KEPT_APART}:plan-7`, keep: 'one', side: 'kept-1', thing_type: 'note', records: PERSON });
  assert.deepEqual(result.written, ['plan-7', `${KEPT_APART}:plan-7`]);
  const byId = new Map(result.writes.map(write => [write.id, write]));
  assert.equal(byId.get('plan-7').value.due, 'Monday');
  assert.deepEqual(byId.get('plan-7').expected, { type: 'note', value: { title: 'Launch plan', due: 'Friday', status: 'Draft' } });
  assert.equal(byId.get(`${KEPT_APART}:plan-7`).value, null);
  assert.equal(byId.has(`${KEPT_APART}:task-3`), false, 'a version of another kind is left alone');
});

test('keep both keeps the other version under the first free name, written only while that name is absent', () => {
  const taken = note(`plan-7${settings.both_suffix}1`, { title: 'An unrelated sample' });
  const result = settleTwoVersions({ id: `${KEPT_APART}:plan-7`, keep: 'both', thing_type: 'note', records: [...PERSON, taken] });
  assert.deepEqual(result.written, [`plan-7${settings.both_suffix}2`, `${KEPT_APART}:plan-7`]);
  const byId = new Map(result.writes.map(write => [write.id, write]));
  assert.equal(byId.get(`plan-7${settings.both_suffix}2`).value.due, 'Monday');
  assert.equal(byId.get(`plan-7${settings.both_suffix}2`).expected, null);
  assert.equal(byId.has(`plan-7${settings.both_suffix}1`), false, 'the record already there is not touched');
});

test('versions no longer kept apart, or a choice not made, are refused with what to send', () => {
  assert.throws(() => settleTwoVersions({ id: `${KEPT_APART}:nope`, keep: 'one', thing_type: 'note', records: PERSON }), /not kept apart any more/);
  assert.throws(() => settleTwoVersions({ id: `${KEPT_APART}:plan-7`, keep: 'whatever', thing_type: 'note', records: PERSON }), /Say what to keep/);
  assert.throws(() => settleTwoVersions({ id: `${KEPT_APART}:plan-7`, keep: 'one', records: PERSON }), /thing_type/);
});

test('the rows declare no records door, and the route that keeps a report through its values door is its own row', () => {
  for (const row of [SEE, HERE, SETTLE]) {
    assert.equal(row.invoke.records, undefined, row.id);
    assert.ok(row.input_schema.properties.records || row.input_schema.properties.devices, row.id);
  }
  assert.ok(SEE.input_schema.required.includes('thing_type'));
  assert.ok(!SETTLE.input_schema.required.includes('request_key') && !HERE.input_schema.required.includes('request_key'));
});
