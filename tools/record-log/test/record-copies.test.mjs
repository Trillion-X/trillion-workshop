// test/record-copies.test.mjs
// What every write now carries (what it replaced) and what that buys from the same log row: undo that leaves a field
// changed since alone, a record read as it was, a layer of changes merged in one write or dropped for nothing, an
// order-free checksum, and a device copy of the store settled with its leader by root, rows and differing buckets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { undoTransaction, readAt, inverseOf } from '../do-work/record-time.mjs';
import { recordLayer, recordLayers } from '../do-work/record-layers.mjs';
import { answerSettle, settleWith, changesAfter, byContent, KEPT_APART } from '../do-work/record-sync.mjs';
import { storeSums } from '../do-work/record-digest.mjs';

const small = { page_bytes: 512, memtable_bytes: 4096, cache_bytes: 8192, big_bytes: 2048 };
const opened = (host = sqliteHost(':memory:')) => ({ host, store: recordLogStore(host.sql, { transaction: host.transaction, runs: small }) });
function counted(host) {
  let written = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => {
    const result = exec(query, ...params);
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) written += host.db.prepare('SELECT changes() AS n').get().n;
    return result;
  };
  return () => written;
}

test('a write carries what it replaced, in the same one row', () => {
  const { host, store } = opened();
  const written = counted(host);
  store.write([{ id: 'n1', type: 'note', value: { text: 'one', room: 'a' } }]);
  const before = written();
  store.write([{ id: 'n1', type: 'note', value: { text: 'two', room: 'a', tag: 'x' } }]);
  assert.equal(written() - before, 1, 'still one row per write');
  const envelope = store.logAfter(null).rows.at(-1).envelopes[0];
  assert.deepEqual(envelope.was ?? envelope.prior, envelope.was ? { text: 'one' } : { type: 'note', value: { text: 'one', room: 'a' } });
  if (envelope.was) assert.deepEqual(envelope.added, ['tag']);
  store.write([{ id: 'n1', type: 'note', value: null }]);
  assert.deepEqual(store.logAfter(null).rows.at(-1).envelopes[0].prior, { type: 'note', value: { text: 'two', room: 'a', tag: 'x' } });
  assert.equal(inverseOf({ id: 'z', type: 't', value: {} }), null, 'an envelope written before it carried what it replaced has no undo');
});

test('undo takes a change back, leaves a field changed since alone, and can itself be undone', () => {
  const { store } = opened();
  store.write([{ id: 'n1', type: 'note', value: { text: 'one', room: 'a' } }], { transaction_id: 't1' });
  store.write([{ id: 'n1', type: 'note', value: { text: 'two', room: 'b' } }, { id: 'n2', type: 'note', value: { text: 'new' } }], { transaction_id: 't2' });
  store.write([{ id: 'n1', type: 'note', value: { text: 'two', room: 'c' } }], { transaction_id: 't3' });
  const undone = undoTransaction(store, 't2', { transaction_id: 'u1' });
  assert.deepEqual(store.read('n1'), { text: 'one', room: 'c' }, 'text went back; room changed since keeps its value');
  assert.equal(store.read('n2'), null, 'a record the change made is removed');
  assert.deepEqual(undone.conflicts.map(conflict => [conflict.id, conflict.field, conflict.here]), [['n1', 'room', 'c']]);
  undoTransaction(store, 'u1', { transaction_id: 'u2' });
  assert.deepEqual(store.read('n1'), { text: 'two', room: 'c' });
  assert.deepEqual(store.read('n2'), { text: 'new' });
  const again = undoTransaction(store, 'u1', { transaction_id: 'u3' });
  assert.equal(again.applied, 0, 'taking back the same change twice changes nothing more');
});

test('a record reads as it was at any moment the log still holds', async () => {
  const { store } = opened();
  const moments = [];
  const pause = () => new Promise(resolve => setTimeout(resolve, 3));
  store.write([{ id: 'n1', type: 'note', value: { text: 'one' } }]);
  await pause(); moments.push(new Date().toISOString()); await pause();
  store.write([{ id: 'n1', type: 'note', value: { text: 'two', room: 'a' } }]);
  await pause(); moments.push(new Date().toISOString()); await pause();
  store.write([{ id: 'n1', type: 'task', value: { title: 'other kind' } }]);
  await pause(); moments.push(new Date().toISOString()); await pause();
  store.write([{ id: 'n1', type: 'task', value: null }]);
  assert.deepEqual(readAt(store, 'n1', moments[0]), { type: 'note', value: { text: 'one' }, complete: true, kept_from: null });
  assert.deepEqual(readAt(store, 'n1', moments[1]).value, { text: 'two', room: 'a' });
  assert.deepEqual(readAt(store, 'n1', moments[2]), { type: 'task', value: { title: 'other kind' }, complete: true, kept_from: null });
  assert.equal(readAt(store, 'n1', '2000-01-01T00:00:00Z').value, null, 'before it was made it did not exist');
  assert.equal(store.read('n1'), null);
});

test('a layer reads as if made, merges in one write with conflicts kept, and is dropped for nothing', () => {
  const { host, store } = opened();
  store.write([{ id: 'n1', type: 'note', value: { text: 'one', room: 'a' } }, { id: 'n2', type: 'note', value: { text: 'keep' } }]);
  const written = counted(host);
  const layer = recordLayer(store, host.sql, 'draft-1', { transaction: host.transaction });
  layer.write([{ id: 'n1', type: 'note', value: { text: 'layered', room: 'a' } }, { id: 'n3', type: 'note', value: { text: 'made' } }]);
  layer.write([{ id: 'n2', type: 'note', value: null }]);
  assert.equal(written(), 2, 'one row per layer write, the store untouched');
  assert.deepEqual(layer.read('n1'), { text: 'layered', room: 'a' });
  assert.equal(layer.read('n2'), null);
  assert.deepEqual(store.read('n1'), { text: 'one', room: 'a' });
  assert.deepEqual(recordLayers(host.sql), ['draft_1']);
  assert.equal(layer.diff().length, 3);
  store.write([{ id: 'n1', type: 'note', value: { text: 'changed meanwhile', room: 'b' } }]);
  const rowsBefore = store.logAfter(null, { limit: 1000 }).rows.length;
  const merged = layer.merge();
  assert.equal(store.logAfter(null, { limit: 1000 }).rows.length - rowsBefore, 1, 'the whole layer is one write');
  assert.deepEqual(store.read('n1'), { text: 'changed meanwhile', room: 'b' });
  assert.equal(store.read('n2'), null);
  assert.deepEqual(store.read('n3'), { text: 'made' });
  assert.deepEqual(merged.conflicts.map(conflict => conflict.field), ['text']);
  assert.equal(layer.size, 1, 'the conflicted record stays in the layer');
  layer.merge();
  assert.deepEqual(store.read('n1'), { text: 'layered', room: 'b' }, 'merged again once seen, the layer value wins its field');
  const other = recordLayer(store, host.sql, 'scratch', { transaction: host.transaction });
  other.write([{ id: 'n9', type: 'note', value: { text: 'never' } }]);
  const beforeDrop = written();
  other.discard();
  assert.equal(written(), beforeDrop, 'dropping a layer writes no row');
  assert.equal(store.read('n9'), null);
  assert.deepEqual(recordLayers(host.sql), []);
});

test('the checksum is order-free, kept across restarts, and worked out once for a store written before it', () => {
  const a = opened();
  const b = opened();
  a.store.write([{ id: 'x', type: 't', value: { n: 1 } }]);
  a.store.write([{ id: 'y', type: 't', value: { n: 2, m: 'z' } }]);
  a.store.write([{ id: 'x', type: 't', value: { n: 3 } }]);
  // The same changes taken in the other order (each with the stamps it was written with) give the same root.
  const [net] = changesAfter(a.store, null).rows;
  b.store.applyChanges([{ ...net, envelopes: [...net.envelopes].reverse() }], {}, { prefer: byContent, keep_apart: KEPT_APART });
  assert.equal(a.store.checksum().root, b.store.checksum().root);
  b.store.write([{ id: 'y', type: 't', value: null }]);
  assert.notEqual(a.store.checksum().root, b.store.checksum().root);
  const root = a.store.checksum().root;
  a.store.checkpoint();
  const reopened = recordLogStore(a.host.sql, { transaction: a.host.transaction, runs: small });
  assert.equal(reopened.checksum().root, root, 'kept beside the pages');
  a.host.sql.exec("UPDATE record_keys_meta SET value = CAST(json_extract(value, '$.at') AS TEXT) WHERE key = 'covered'");
  const rebuilt = recordLogStore(a.host.sql, { transaction: a.host.transaction, runs: small });
  assert.equal(rebuilt.checksum().root, root, 'worked out from the records when it was never kept');
  const empty = storeSums();
  assert.equal(opened().store.checksum().root, empty.root());
});

// A leader answering the one settle request, as the hosted store answers a device (JSON both ways, as over HTTP).
const leaderOf = store => async request => JSON.parse(JSON.stringify(answerSettle(store, JSON.parse(JSON.stringify(request)))));
const settleCopy = (copy, send, state = {}) => settleWith(copy, send, { id: 'device', state });

test('a device copy settles with its leader: both offline edits land, a field both changed settles on the later write on both and keeps the other version', async () => {
  const leader = opened().store;
  const copy = opened().store;
  leader.write([{ id: 'n1', type: 'note', value: { text: 'one', room: 'a' } }, { id: 'n2', type: 'note', value: { text: 'two' } }]);
  let settled = await settleCopy(copy, leaderOf(leader));
  assert.ok(settled.equal);
  assert.deepEqual(copy.read('n1'), { text: 'one', room: 'a' });
  // Both sides change while apart.
  copy.write([{ id: 'n1', type: 'note', value: { text: 'one', room: 'copy room' } }, { id: 'c1', type: 'note', value: { text: 'made on the device' } }]);
  copy.write([{ id: 'n2', type: 'note', value: { text: 'device text' } }]);
  leader.write([{ id: 'n2', type: 'note', value: { text: 'leader text' } }, { id: 'l1', type: 'note', value: { text: 'made on the leader' } }]);
  settled = await settleCopy(copy, leaderOf(leader), settled.state);
  assert.ok(settled.equal, 'roots equal after one settle');
  for (const store of [leader, copy]) {
    assert.deepEqual(store.read('n1'), { text: 'one', room: 'copy room' });
    assert.deepEqual(store.read('c1'), { text: 'made on the device' });
    assert.deepEqual(store.read('l1'), { text: 'made on the leader' });
    assert.deepEqual(store.read('n2'), { text: 'leader text' }, 'the later write wins on both, whichever side it was made on');
    const apart = Object.values(store.read('kept-apart:n2')).map(version => version.value).sort();
    assert.deepEqual(apart, ['device text', 'leader text'], 'both versions are kept beside it');
  }
  assert.ok(settled.conflicts.some(conflict => conflict.id === 'n2' && conflict.field === 'text'));
  const again = await settleCopy(copy, leaderOf(leader), settled.state);
  assert.ok(again.equal);
  assert.equal(again.sent + again.took + again.records_taken, 0, 'settling again moves nothing');
});

test('a copy whose leader no longer keeps the rows settles by the buckets that differ', async () => {
  const leader = opened();
  const copy = opened().store;
  for (let index = 0; index < 300; index += 1) leader.store.write([{ id: `r${index}`, type: 'note', value: { index } }]);
  let settled = await settleCopy(copy, leaderOf(leader.store));
  assert.ok(settled.equal);
  // The leader changes a few records, then its log rows go (as when its history leaves the database).
  leader.store.write([{ id: 'r5', type: 'note', value: { index: 'five' } }, { id: 'r9', type: 'note', value: null }]);
  leader.store.checkpoint();
  const sealed = leader.store.sealLog();
  for (const table of leader.store.sealedLogs()) leader.host.sql.exec(`DELETE FROM ${table}`);
  assert.ok(sealed);
  settled = await settleCopy(copy, leaderOf(leader.store), settled.state);
  assert.ok(settled.equal);
  assert.ok(settled.buckets_taken > 0 && settled.buckets_taken <= 2, `only the differing buckets (${settled.buckets_taken})`);
  assert.deepEqual(copy.read('r5'), { index: 'five' });
  assert.equal(copy.read('r9'), null);
  assert.deepEqual(copy.read('r200'), { index: 200 });
});

test('a copy settled from nothing takes everything and checks by root', async () => {
  const leader = opened().store;
  for (let index = 0; index < 50; index += 1) leader.write([{ id: `r${index}`, type: 'note', value: { index } }]);
  const copy = opened().store;
  const settled = await settleCopy(copy, leaderOf(leader));
  assert.ok(settled.equal);
  assert.equal(settled.took, 50);
  assert.equal(copy.lastLogId(), copy.logAfter(null, { limit: 1000 }).last, 'the copy knows its newest row');
});

test('the checksum moved one field at a time equals the one worked out from every record, through write-outs, restarts and rollbacks', () => {
  const host = sqliteHost(':memory:');
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, runs: small });
  let store = open();
  let seed = 11;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 3000; round += 1) {
    const id = `r${Math.floor(random() * 300)}`;
    const roll = random();
    if (roll < 0.15) store.write([{ id, type: 'note', value: null }]);
    else if (roll < 0.2) store.write([{ id, type: 'task', value: { title: `t${round}` } }]);
    else store.write([{ id, type: 'note', value: { text: `v${Math.floor(random() * 5)}`, ...(random() < 0.5 ? { extra: round } : {}) } }]);
    if (round % 400 === 399) { store.checkpoint(); store = open(); }
    if (round % 777 === 0) {
      try { host.transaction(() => { store.write([{ id: 'rolled', type: 'note', value: { round } }]); throw new Error('roll back'); }); } catch { store.forgetCached(); }
    }
  }
  const kept = store.checksum().root;
  store.checkpoint();
  host.sql.exec("UPDATE record_keys_meta SET value = CAST(json_extract(value, '$.at') AS TEXT) WHERE key = 'covered'");
  assert.equal(open().checksum().root, kept);
});
