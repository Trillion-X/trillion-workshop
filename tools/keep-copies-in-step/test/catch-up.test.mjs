// Whether every copy is in step (read-data/catch-up.mjs, moved from trillion src/catch-up.mjs with its tests,
// trillion test/catch-up.test.mjs): a device's report is written only when something the person would see changed; a
// record two copies changed apart is read from the kept-apart record the record store keeps, as the record now and the
// other version; settling writes what was chosen and then removes the kept versions, and keep both keeps the other
// version as a record of its own. The old tests forked two record-log stores to make the kept-apart record; the record
// store is not in this repository, so `forked()` writes the kept-apart record that fork left (record-sync.mjs: the
// record as one copy wrote it, the other copy's `due` kept under kept-apart:<id>). Then each row runs against the
// records door stand-in (tools/records-door/test/fake-door.mjs), which checks rights and `expected` as the engine does.
// Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRow, rowOf } from '../../records-door/test/run-row.mjs';
import { catchUp, KEPT_APART } from '../read-data/catch-up.mjs';
import settings from '../read-data/catch-up.json' with { type: 'json' };

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const SEE = rowOf(ROWS, 'tool:see-copies-in-step');
const SAY = rowOf(ROWS, 'tool:say-how-this-copy-stands');
const SETTLE = rowOf(ROWS, 'tool:settle-two-versions');

// A record store in memory, with the calls the moved code makes (ids, read, typeOf, write).
function memory(rows = []) {
  const kept = new Map(rows.map(row => [row.id, row]));
  return {
    kept,
    ids: (type, { limit } = {}) => [...kept.values()].filter(row => row.type === type).map(row => row.id).slice(0, limit),
    read: id => structuredClone(kept.get(id)?.value ?? null),
    typeOf: id => kept.get(id)?.type ?? null,
    write: writes => { for (const { id, type, value } of writes) value === null ? kept.delete(id) : kept.set(id, { id, type, value: structuredClone(value) }); },
  };
}
// Two copies that both changed the launch plan's `due` apart, settled both ways: the store keeps both versions.
const PLAN = { title: 'Launch plan', due: 'Friday', status: 'Draft' };
const keptApart = (due = 'Monday') => ({ id: `${KEPT_APART}:plan-7`, type: KEPT_APART, value: { 'due|sample-checksum': { record: 'plan-7', record_type: 'note', field: 'due', value: due } } });
const forkedRows = () => [{ id: 'plan-7', type: 'note', value: { ...PLAN } }, keptApart()];
const forked = () => memory(forkedRows());
function deviceRows() {
  let rows = [];
  let writes = 0;
  return { writes: () => writes, devices: () => rows, putDevices: value => { writes += 1; rows = value; } };
}

test('a device is written when what the person sees changes, not on every report', () => {
  let clock = Date.parse('2026-10-05T09:00:00Z');
  const rows = deviceRows();
  const copies = catchUp(rows, { records: memory(), now: () => clock, limits: { ...settings, most_devices: 3 } });
  const report = over => copies.here({ device_id: 'd-1234abcd', title: 'Chrome on Mac', kind: 'computer', state: 'caught-up', waiting: 0, at: clock, ...over });
  assert.equal(report().written, true);
  clock += 60_000;
  assert.equal(report().written, false, 'the same state a minute later is not written again');
  assert.equal(report({ state: 'waiting', waiting: 2 }).written, true, 'changes waiting is written');
  clock += 3_700_000;
  assert.equal(report({ state: 'waiting', waiting: 2 }).written, true, 'an hour on, its last catch-up is written again');
  assert.equal(rows.writes(), 3);
  for (const id of ['d-aaaaaaaa', 'd-bbbbbbbb', 'd-cccccccc']) copies.here({ device_id: id, state: 'caught-up' });
  assert.deepEqual(rows.devices().map(device => device.device_id), ['d-cccccccc', 'd-bbbbbbbb', 'd-aaaaaaaa'], 'at most most_devices, newest first');
  assert.throws(() => copies.here({ device_id: 'x', state: 'caught-up' }), /which device/);
  assert.throws(() => copies.here({ device_id: 'd-1234abcd' }), /how this device stands/);
});

test('a record changed apart on two copies reads as the record now and the other version, and keep one settles it', () => {
  const records = forked();
  const copies = catchUp(deviceRows(), { records });
  const [apart] = copies.read().versions;
  assert.equal(apart.id, `${KEPT_APART}:plan-7`);
  assert.deepEqual(apart.thing, { kind: 'note', id: 'plan-7', title: 'Launch plan' });
  assert.equal(apart.sides.length, 2);
  const [now, other] = apart.sides;
  assert.equal(now.current, true);
  assert.deepEqual(new Set([now.value.due, other.value.due]), new Set(['Friday', 'Monday']), 'both versions of due, nothing else differs');
  assert.equal(other.value.status, 'Draft');
  assert.throws(() => copies.settle({ id: apart.id, keep: 'one', side: 'tablet' }), /which version/);
  assert.throws(() => copies.settle({ id: apart.id, keep: 'merged' }), /merged value/);
  assert.equal(copies.read().versions.length, 1, 'a refused settle keeps both versions');
  const settled = copies.settle({ id: apart.id, keep: 'one', side: other.id });
  assert.deepEqual(settled.written, ['plan-7', apart.id]);
  assert.equal(records.read('plan-7').due, other.value.due, 'the version chosen is the record now');
  assert.equal(records.read(apart.id), null, 'the kept versions go once the choice is written');
  assert.equal(copies.read().versions.length, 0);
  assert.throws(() => copies.settle({ id: apart.id, keep: 'both' }), /not kept apart/);
});

test('keep both keeps the other version as its own record; a merge writes the value given', () => {
  const both = forked();
  const copies = catchUp(deviceRows(), { records: both });
  const [apart] = copies.read().versions;
  copies.settle({ id: apart.id, keep: 'both' });
  assert.equal(both.read(`plan-7${settings.both_suffix}1`).due, apart.sides[1].value.due);
  assert.equal(both.read('plan-7').due, apart.sides[0].value.due);
  assert.equal(both.read(apart.id), null);

  const merged = forked();
  const merging = catchUp(deviceRows(), { records: merged });
  const [kept] = merging.read().versions;
  merging.settle({ id: kept.id, keep: 'merged', value: { title: 'Launch plan', due: 'Tuesday', status: 'Ready' } });
  assert.deepEqual(merged.read('plan-7'), { title: 'Launch plan', due: 'Tuesday', status: 'Ready' });
});

test('keep both preserves earlier retained copies and unrelated records at its proposed identity', () => {
  const records = forked();
  const copies = catchUp(deviceRows(), { records });
  const firstId = `plan-7${settings.both_suffix}1`;
  const unrelated = { title: 'An ordinary independent record', due: 'Never replace this' };
  records.write([{ id: firstId, type: 'note', value: unrelated }]);
  const [first] = copies.read().versions;
  const settled = copies.settle({ id: first.id, keep: 'both' });
  const retained = settled.written.filter(id => id !== first.id);
  assert.equal(retained.length, first.sides.length - 1);
  assert.deepEqual(records.read(firstId), unrelated);
  const saved = retained.map(id => [id, records.read(id)]);
  // A later conflict of the same record must allocate another identity, never replace a previously retained side.
  records.write([{ id: first.id, type: KEPT_APART, value: { conflict: { record: 'plan-7', record_type: 'note', field: 'due', value: 'Saturday' } } }]);
  const again = copies.settle({ id: first.id, keep: 'both' });
  assert.equal(again.written.some(id => retained.includes(id)), false);
  for (const [id, value] of saved) assert.deepEqual(records.read(id), value);
  assert.deepEqual(records.read(firstId), unrelated);
});

// The old routes test (GET /catch-up, POST /catch-up/here, POST /catch-up/settle), through the rows instead.
test('the rows answer through the records door, and a copy of the records is listed as a device', async () => {
  const positions = [{ copy: 'mac-copy', took_through: '9', settled_at: '2026-10-05T09:00:00.000Z' }];
  let records = [...forkedRows(), { id: 'kept-apart:other', type: KEPT_APART, value: { '*|x': { record: 'task-1', record_type: 'task', field: '*', value: {} } } }];
  const run = async (row, input) => { const answer = await runRow(row, input, { records }); records = answer.kept; return answer; };
  assert.equal((await run(SAY, { device_id: 'd-1234abcd', state: 'offline' })).result.written, true);
  const read = (await run(SEE, { kind: 'note', positions })).result;
  assert.deepEqual(read.devices.map(device => [device.device_id, device.state, device.title]), [['d-1234abcd', 'offline', ''], ['mac-copy', settings.copy_state, settings.words.copy_title]], 'a copy no device names is listed by itself, never by its id');
  assert.equal(read.versions.length, 1, 'only the kind asked for');
  assert.equal(read.versions[0].thing.title, 'Launch plan');
  assert.deepEqual(read.other_kinds, { task: 1 });
  const refused = await run(SETTLE, { kind: 'note', id: read.versions[0].id, keep: 'some', request_key: 'settle-1' });
  assert.match(refused.result.error, /what to keep/);
  assert.equal(records.some(record => record.id === read.versions[0].id), true, 'a refused settle keeps both versions');
  const settled = await run(SETTLE, { kind: 'note', id: read.versions[0].id, keep: 'one', side: 'now', request_key: 'settle-2' });
  assert.deepEqual(settled.result.written, [read.versions[0].id]);
  assert.equal(records.some(record => record.id === read.versions[0].id), false);
  // The device that keeps that copy names it: one row, as of the copy's later settle.
  await run(SAY, { device_id: 'd-1234abcd', state: 'caught-up', at: '2026-10-05T08:00:00.000Z', copy_id: 'mac-copy' });
  const named = (await run(SEE, { kind: 'note', positions })).result;
  assert.deepEqual(named.devices.map(device => [device.device_id, device.at]), [['d-1234abcd', '2026-10-05T09:00:00.000Z']]);
});

test('keep both through the row writes the other version beside the names already taken', async () => {
  const records = [...forkedRows(), { id: `plan-7${settings.both_suffix}1`, type: 'note', value: { title: 'Taken' } }];
  const { result, kept } = await runRow(SETTLE, { kind: 'note', id: `${KEPT_APART}:plan-7`, keep: 'both', request_key: 'both-1' }, { records });
  assert.deepEqual(result.written, [`plan-7${settings.both_suffix}2`, `${KEPT_APART}:plan-7`]);
  const byId = new Map(kept.map(record => [record.id, record.value]));
  assert.equal(byId.get(`plan-7${settings.both_suffix}2`).due, 'Monday');
  assert.deepEqual(byId.get(`plan-7${settings.both_suffix}1`), { title: 'Taken' });
});

test('a settle and a read reach only the kind they name, and a run with no kind is refused', async () => {
  const wrongKind = await runRow(SETTLE, { kind: 'task', id: `${KEPT_APART}:plan-7`, keep: 'one', side: 'now', request_key: 'k-1' }, { records: forkedRows() });
  assert.match(wrongKind.error, /kind must be the kind of the record kept apart: note/);
  const seen = await runRow(SEE, { kind: 'task' }, { records: forkedRows() });
  assert.deepEqual([seen.result.versions, seen.result.other_kinds], [[], { note: 1 }]);
  const missing = await runRow(SEE, {}, { records: forkedRows() });
  assert.notEqual(missing.status, 0, 'a run with no kind is refused');
  assert.match(missing.error, /kind/);
});
