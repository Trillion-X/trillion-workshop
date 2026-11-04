import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { RECORD_MODEL } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { bucketOf } from '../do-work/record-digest.mjs';
const id = 'arrival:page-proof';
const owner = prefix => { for (let n = 0;; n++) { const value = `message:${prefix}-${n}`; if (bucketOf(value) !== bucketOf(id)) return value; } };
const a = owner('a'), b = owner('b');
const material = byte => Buffer.alloc(32, byte).toString('base64');
function fixture() {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, model: RECORD_MODEL, slot_bytes: 0,
    runs: { page_bytes: 4096, cache_bytes: 0, filter_bytes: 0, memtable_bytes: 1 << 20, tail_rows: Infinity } };
  let store = recordLogStore(host.sql, options);
  store.takeErasureKeys({ [a]: material(7), [b]: material(9) });
  const value = message_id => ({ message_id, route: 'chat', job: 'private retained words', at: '2026-10-12T11:00:00.000Z' });
  store.write([{ id: a, type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: 'a' } },
    { id: b, type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: 'b' } },
    { id, type: 'arrival', value: value(a) }]);
  store.checkpoint(); store = recordLogStore(host.sql, options);
  const page = () => { const result = store.recordsInBucketsPage([bucketOf(id)], { key_owners: true });
    assert.deepEqual(result.records.map(record => record.id), [id]); assert.deepEqual(Object.keys(result), ['records', 'next']); return result; };
  const checked = result => { const ids = result.records.map(record => record.id);
    const actual = store.erasureKeys(ids, { from_page: result.records });
    assert.deepEqual(actual, store.erasureKeys(ids)); return actual; };
  return { host, options, store, value, page, checked };
}
test('authentic one-use pages preserve sealed side-owner keys and reject fabricated or changed caller payloads', () => {
  const f = fixture();
  try {
    const result = f.page();
    result.records[0].value = { invented: { key: b } };
    const actual = f.checked(result); assert.equal(actual[a], material(7)); assert.equal(b in actual, false);
    assert.deepEqual(f.checked(result), actual, 'consumed proof falls back to authentic current roots');
    const forged = { records: [{ id, type: 'arrival', value: { invented: { key: b } } }] };
    assert.deepEqual(f.checked(forged), actual, 'a caller array cannot authenticate owners');
    const mismatch = f.page();
    assert.deepEqual(f.store.erasureKeys([b], { from_page: mismatch.records }), f.store.erasureKeys([b]));
  } finally { f.host.db.close(); }
});
test('root writes, load and removal invalidate returned-page owner proofs before key discovery', () => {
  const f = fixture();
  try {
    const original = f.page(); f.store.write([{ id, type: 'arrival', value: f.value(b) }]);
    const changed = f.checked(original); assert.equal(changed[b], material(9)); assert.equal(a in changed, false);
    const beforeLoad = f.page(); f.store.load([{ id, type: 'arrival', seq: '001', value: original.records[0].value }], {});
    const loaded = f.checked(beforeLoad); assert.equal(loaded[a], material(7)); assert.equal(b in loaded, false);
    const beforeRemoval = f.page(); f.store.write([{ id, type: 'arrival', value: null }]);
    const removed = f.checked(beforeRemoval); assert.equal(a in removed, false); assert.equal(b in removed, false);
  } finally { f.host.db.close(); }
});
test('rolled-back writer and restored projections cannot reuse a prior owner proof', () => {
  const f = fixture();
  try {
    const original = f.page();
    assert.throws(() => f.host.transaction(() => { f.store.write([{ id, type: 'arrival', value: f.value(b) }]); throw Error('rollback'); }), /rollback/);
    f.store.forgetCached(); const found = f.checked(original); assert.equal(found[a], material(7)); assert.equal(b in found, false);
    const beforeErasure = f.page(); f.store.takeErasureKeys({ [a]: { erased: ['text'] } });
    assert.deepEqual(f.store.erasureKeys([id], { from_page: beforeErasure.records }), f.store.erasureKeys([id]));
  } finally { f.host.db.close(); }
});
test('default pages retain their original contract and untrusted proof requests retain accepted large-head fallback', () => {
  const host = sqliteHost(':memory:');
  try {
    const options = { transaction: host.transaction, slot_bytes: 0, runs: { cache_bytes: 0, filter_bytes: 0, tail_rows: Infinity } };
    let store = recordLogStore(host.sql, options);
    store.load([{ id: 'large', type: 'unmodeled', seq: '001', value: { text: 'x'.repeat(2 * 1024 * 1024 + 1024) } },
      { id: 'small', type: 'unmodeled', seq: '002', value: { text: 'small' } }], {}); store.loadDone({});
    store = recordLogStore(host.sql, options);
    const buckets = Array.from({ length: 256 }, (_, index) => index);
    const defaultPage = store.recordsInBucketsPage(buckets);
    const proofPage = store.recordsInBucketsPage(buckets, { key_owners: true });
    assert.deepEqual(proofPage, defaultPage);
    const ids = proofPage.records.map(record => record.id);
    assert.deepEqual(store.erasureKeys(ids, { from_page: proofPage.records }), store.erasureKeys(ids));
    assert.deepEqual(store.erasureKeys(ids, { from_page: structuredClone(proofPage.records) }), store.erasureKeys(ids));
  } finally { host.db.close(); }
});
