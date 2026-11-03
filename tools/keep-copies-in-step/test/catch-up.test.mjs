// Moved from trillion test/catch-up.test.mjs with its assertions unchanged.
//
// Whether every copy is in step, as the person's store answers it (read-data/catch-up.mjs): a device's report is written
// only when something the person would see changed; a record two copies changed apart is read from the kept-apart record
// the record store keeps, as the record now and the other version; settling writes what was chosen and then removes the
// kept versions, and keep both keeps the other version as a record of its own.
//
// The original forked two real record-log stores (trillion parts/record-log) to make the kept-apart record; the Workshop
// has no record log, so `forked()` here writes the same two rows that fork leaves: the record as one copy's version and
// the kept-apart record holding the other copy's `due`. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { catchUp, handleCatchUpRequest, KEPT_APART } from '../read-data/catch-up.mjs';
import settings from '../read-data/catch-up.json' with { type: 'json' };

// A record store with the surface catch-up.mjs reads: ids(type, { limit }), read(id), typeOf(id), write([...]).
function memoryRecords() {
  const rows = new Map();
  return {
    ids: (type, { limit } = {}) => [...rows].filter(([, row]) => row.type === type).map(([id]) => id).slice(0, limit),
    read: id => rows.get(id)?.value ?? null,
    typeOf: id => rows.get(id)?.type ?? null,
    write: writes => { for (const { id, type, value } of writes) { if (value === null) rows.delete(id); else rows.set(id, { type, value }); } },
  };
}
function store(name) {
  return { name, records: memoryRecords() };
}
// Two copies that both changed the launch plan's `due` apart, settled both ways: the store keeps both versions.
async function forked() {
  const left = store('left');
  left.records.write([{ id: 'plan-7', type: 'note', value: { title: 'Launch plan', due: 'Friday', status: 'Draft' } }]);
  left.records.write([{ id: `${KEPT_APART}:plan-7`, type: KEPT_APART, value: { 'due|sample-checksum': { record: 'plan-7', record_type: 'note', field: 'due', value: 'Monday' } } }]);
  return left.records;
}
function deviceRows() {
  let rows = [];
  let writes = 0;
  return { writes: () => writes, devices: () => rows, putDevices: value => { writes += 1; rows = value; } };
}

test('a device is written when what the person sees changes, not on every report', () => {
  let clock = Date.parse('2026-10-05T09:00:00Z');
  const rows = deviceRows();
  const copies = catchUp(rows, { records: store('here').records, now: () => clock, limits: { ...settings, most_devices: 3 } });
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

test('a record changed apart on two copies reads as the record now and the other version, and keep one settles it', async () => {
  const records = await forked();
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

test('keep both keeps the other version as its own record; a merge writes the value given', async () => {
  const both = await forked();
  const copies = catchUp(deviceRows(), { records: both });
  const [apart] = copies.read().versions;
  copies.settle({ id: apart.id, keep: 'both' });
  assert.equal(both.read(`plan-7${settings.both_suffix}1`).due, apart.sides[1].value.due);
  assert.equal(both.read('plan-7').due, apart.sides[0].value.due);
  assert.equal(both.read(apart.id), null);

  const merged = await forked();
  const merging = catchUp(deviceRows(), { records: merged });
  const [kept] = merging.read().versions;
  merging.settle({ id: kept.id, keep: 'merged', value: { title: 'Launch plan', due: 'Tuesday', status: 'Ready' } });
  assert.deepEqual(merged.read('plan-7'), { title: 'Launch plan', due: 'Tuesday', status: 'Ready' });
});

test('keep both preserves earlier retained copies and unrelated records at its proposed identity', async () => {
  const records = await forked();
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

test('the routes answer through the store road, and a copy of the records is listed as a device', async () => {
  const records = await forked();
  const positions = { list: () => [{ copy: 'mac-copy', took_through: '9', settled_at: '2026-10-05T09:00:00.000Z' }] };
  const copies = catchUp(deviceRows(), { records, positions });
  const ask = (method, path, body) => handleCatchUpRequest(copies, new Request(`https://person${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }));
  assert.equal((await ask('POST', '/catch-up/here', { device_id: 'd-1234abcd', state: 'offline' })).status, 200);
  const read = await (await ask('GET', '/catch-up')).json();
  assert.deepEqual(read.devices.map(device => [device.device_id, device.state, device.title]), [['d-1234abcd', 'offline', ''], ['mac-copy', settings.copy_state, settings.words.copy_title]], 'a copy no device names is listed by itself, never by its id');
  assert.equal(read.versions[0].thing.title, 'Launch plan');
  const refused = await ask('POST', '/catch-up/settle', { id: read.versions[0].id, keep: 'some' });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /what to keep/);
  assert.equal((await ask('POST', '/catch-up/settle', { id: read.versions[0].id, keep: 'one', side: 'now' })).status, 200);
  assert.equal(records.read(read.versions[0].id), null);
  assert.equal((await ask('GET', '/catch-up/nothing')).status, 404);
  // The device that keeps that copy names it: one row, as of the copy's later settle.
  await ask('POST', '/catch-up/here', { device_id: 'd-1234abcd', state: 'caught-up', at: '2026-10-05T08:00:00.000Z', copy_id: 'mac-copy' });
  const named = await (await ask('GET', '/catch-up')).json();
  assert.deepEqual(named.devices.map(device => [device.device_id, device.at]), [['d-1234abcd', '2026-10-05T09:00:00.000Z']]);
});
