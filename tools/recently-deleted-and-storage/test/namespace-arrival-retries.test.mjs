// Ported from old trillion test/namespace-arrival-retries.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The arrival fence (namespace-store.mjs keepWholeFiles' onArrivalWork rows and
// completeWholeFileArrivals) moved here byte for byte; the person store that ran organize/settle/scheduler on those rows
// is retired, so "arrival work happened" is read as the store handing back pending arrival rows, and a completed batch
// is the caller's completeWholeFileArrivals. Left out (no running owner, search in tools/recently-deleted-and-storage
// moved-from.json's adapted line): organizing into /Images/Image - <title>, the eeaf file-arrival record, results'
// alias titles, the byte-release refusal and the scheduler's arm count.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../namespace-store.mjs';

const id = n => `1f:${n.toString(16).padStart(64, '0')}`;
const file = (n = 1, extra = {}) => ({ identity: id(n), byte_length: 10, origin: 'test', key: `file-${n}`,
  media_type: 'image/png', name: `/Kept/Photo-${n}.png`, modified_at_ms: 1000, ...extra });

// The old store-cost-for-tests costingHost, as far as node:sqlite tells it: statements run, rows handed back, and rows
// written (SQLite's total_changes()).
function costingHost() {
  const host = sqliteHost(':memory:');
  let measuring = false, cost = null;
  const sql = { exec(query, ...params) {
    const cursor = host.sql.exec(query, ...params);
    if (!measuring) return cursor;
    const rows = cursor.toArray();
    cost.statements += 1; cost.read += rows.length;
    return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const changes = () => host.sql.exec('SELECT total_changes() AS n').toArray()[0].n;
  return { host, sql, measure(fn) {
    cost = { statements: 0, read: 0, written: 0 };
    const before = changes();
    measuring = true;
    try { fn(); } finally { measuring = false; }
    cost.written = changes() - before;
    return cost;
  } };
}
// One arrival as the retired person store ran it: keep, and when there is arrival work, do it and complete it.
function arrive(namespace, files, { fail = false } = {}) {
  let pending = [];
  const kept = namespace.keepWholeFiles(files, rows => { pending = rows; });
  if (pending.length && !fail) namespace.completeWholeFileArrivals(pending);
  return { kept, work: pending.length };
}

test('an old namespace schema gains arrival fences without changing its held file', () => {
  const store = costingHost(), first = file(1, { key: null, name: null });
  store.sql.exec(`CREATE TABLE namespace_files (
    identity TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, media_type TEXT,
    origin TEXT NOT NULL, key TEXT NOT NULL, part_bytes INTEGER NOT NULL,
    stored_at TEXT NOT NULL, checked_at TEXT NOT NULL, checked_part INTEGER
  )`);
  store.sql.exec(`INSERT INTO namespace_files
    (identity, byte_length, media_type, origin, key, part_bytes, stored_at, checked_at, checked_part)
    VALUES (?, 10, 'image/png', 'test', 'legacy-object', 0, ?, ?, NULL)`,
  first.identity, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  const namespace = namespaceStore(store.sql);
  const columns = new Set(store.sql.exec('PRAGMA table_info(namespace_files)').toArray().map(row => row.name));
  for (const column of ['prefix_identity', 'arrival_revision', 'arrival_completed_revision']) assert.ok(columns.has(column));
  assert.deepEqual({ ...store.sql.exec('SELECT arrival_revision, arrival_completed_revision FROM namespace_files WHERE identity = ?', first.identity).toArray()[0] },
    { arrival_revision: null, arrival_completed_revision: null });
  const before = namespace.locate(first.identity);
  let pending;
  assert.deepEqual(namespace.keepWholeFiles([first], rows => { pending = rows; }), { kept: 1, again: [] });
  assert.equal(pending.length, 1); assert.ok(pending[0].arrival_revision);
  assert.deepEqual(namespace.locate(first.identity), before);
  namespace.completeWholeFileArrivals(pending);
  const reopened = namespaceStore(store.sql);
  assert.deepEqual(reopened.keepWholeFiles([first], rows => { pending = rows; }), { kept: 1, again: [] });
  assert.deepEqual(pending, []); assert.deepEqual(reopened.locate(first.identity), before);
});

test('completed unchanged batches skip arrival work at 200 and 800 aliases', () => {
  const costs = [];
  for (const aliases of [200, 800]) {
    const store = costingHost(), namespace = namespaceStore(store.sql);
    const files = Array.from({ length: 8 }, (_, n) => file(n + 1));
    namespace.keepWholeFiles(files);
    namespace.addAliases(files[0].identity, Array.from({ length: aliases }, (_, n) => id(1000 + n)));
    assert.deepEqual(arrive(namespace, files).kept, { kept: 8, again: [] });
    let kept;
    costs.push(store.measure(() => { kept = arrive(namespace, files); }));
    const cost = costs.at(-1);
    console.log(`unchanged replay at ${aliases} aliases: ${cost.statements} statements, ${cost.read} read, ${cost.written} written`);
    assert.deepEqual(kept, { kept: { kept: 8, again: [] }, work: 0 });
    assert.equal(cost.written, 0);
    assert.ok(cost.statements <= 120, JSON.stringify(cost));
  }
  assert.equal(costs[0].statements, costs[1].statements);
  assert.equal(costs[0].read, costs[1].read);
});

test('aliases, metadata, names, prefixes and new files retain arrival work', () => {
  const store = costingHost(), namespace = namespaceStore(store.sql);
  const first = file(), alias = id(100);
  arrive(namespace, [first]);
  const changes = [{ ...first, aliases: [alias] }, { ...first, aliases: [alias], modified_at_ms: 0 },
    { ...first, aliases: [alias], modified_at_ms: 0, name: '/Kept/Another.png' },
    { ...first, aliases: [alias], modified_at_ms: 0, name: '/Kept/Another.png', prefix_identity: id(300) }, file(2)];
  for (const changed of changes) {
    const once = arrive(namespace, [changed]);
    assert.deepEqual(once, { kept: { kept: 1, again: [] }, work: 1 });
    assert.equal(arrive(namespace, [changed]).work, 0);
  }
  assert.equal(store.sql.exec('SELECT modified_at_ms FROM namespace_names WHERE name = ?', first.name).toArray()[0].modified_at_ms, 0);
  assert.equal(namespace.locate(first.identity).prefix_identity, id(300));
});

test('every supplied root name for the same pending identity is kept for arrival work', () => {
  const store = costingHost(), namespace = namespaceStore(store.sql);
  let pending;
  namespace.keepWholeFiles([file(1, { name: '/first.png' }), file(1, { name: '/second.png' })], rows => { pending = rows; });
  assert.deepEqual(pending.map(row => row.identity), [id(1)], 'one arrival row for the one identity');
  assert.equal(namespace.entry('/first.png').identity, id(1));
  assert.equal(namespace.entry('/second.png').identity, id(1));
});

test('older arrivals complete once and remain complete after reopening', () => {
  const store = costingHost(), namespace = namespaceStore(store.sql);
  const old = file(); namespace.keepWholeFiles([old]);
  assert.equal(arrive(namespace, [old]).work, 1);
  assert.equal(arrive(namespace, [old]).work, 0);
  const reopened = namespaceStore(store.sql);
  assert.equal(arrive(reopened, [old]).work, 0);
});

test('missing bytes cause no arrival work', () => {
  const store = costingHost(), namespace = namespaceStore(store.sql);
  let pending = null;
  assert.deepEqual(namespace.keepWholeFiles([file(2, { key: null })], rows => { pending = rows; }), { kept: 0, again: [id(2)] });
  assert.equal(pending, null, 'no arrival callback for a batch with nothing accepted');
});

test('a failed arrival leaves unchanged arrivals pending', () => {
  const store = costingHost(), namespace = namespaceStore(store.sql);
  const first = file();
  assert.deepEqual(arrive(namespace, [first], { fail: true }), { kept: { kept: 1, again: [] }, work: 1 });
  assert.equal(arrive(namespace, [first]).work, 1);
  assert.equal(arrive(namespace, [first]).work, 0);
});

test('older completion cannot hide a newer failed arrival during held work', () => {
  const store = costingHost(), namespace = namespaceStore(store.sql);
  const first = file();
  let earlier;
  namespace.keepWholeFiles([first], rows => { earlier = rows; });
  const changed = { ...first, aliases: [id(200)] };
  assert.equal(arrive(namespace, [changed], { fail: true }).work, 1);
  namespace.completeWholeFileArrivals(earlier);
  assert.equal(arrive(namespace, [changed]).work, 1);
  assert.equal(arrive(namespace, [changed]).work, 0);
});

test('an older token cannot complete a deleted and re-created file', () => {
  const store = costingHost(), namespace = namespaceStore(store.sql), first = file();
  let before, after, pending;
  namespace.keepWholeFiles([first], rows => { before = rows; }); assert.equal(before.length, 1);
  store.sql.exec('DELETE FROM namespace_files WHERE identity = ?', first.identity);
  namespace.keepWholeFiles([first], rows => { after = rows; }); assert.equal(after.length, 1);
  assert.notEqual(before[0].arrival_revision, after[0].arrival_revision);
  namespace.completeWholeFileArrivals(before);
  namespace.keepWholeFiles([first], rows => { pending = rows; }); assert.deepEqual(pending, after);
  namespace.completeWholeFileArrivals(after);
  namespace.keepWholeFiles([first], rows => { pending = rows; }); assert.deepEqual(pending, []);
});
