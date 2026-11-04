import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords, setRecordEngine } from '../src/record-engine.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

const ACTOR = { actor: { by: 'synthetic-content-retraction-test' } };
const resultId = id => `agent-handoff-result:${id}`;
const historyId = id => `${resultId(id)}:corrections`;
const job = (id, extra = {}) => ({
  handoff_id: id,
  job: `Synthetic job ${id}`,
  state: 'finished',
  handed_at: '2026-10-13T12:00:00.000Z',
  to_agent: 'worker',
  taken_by: 'worker',
  generation: 1,
  priority: 0,
  ...extra,
});

function owner(t, engine) {
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  setRecordEngine(host.sql, engine);
  const records = openRecords(host.sql, { transaction: host.transaction, hash: value => value });
  return { host, records, store: agentRecordStore({ records, transaction: host.transaction }) };
}

for (const engine of ['record-log', 'eeaf']) test(`${engine} retires detached result and correction records only when the final handoff drops them`, t => {
  const { records, store } = owner(t, engine);
  const id = `content-${engine}`;
  const originalResult = { answer: 'Original answer', evidence: ['first', 'second'] };
  const originalHistory = [{ evidence: 'Correction evidence', prior_result: { answer: 'Prior answer' } }];
  const receipt = { source: 'verified-test-source', byte_length: 14 };
  const original = job(id, {
    result: originalResult,
    result_source_receipt: receipt,
    corrections: originalHistory,
  });

  store.putHandoff(original);
  assert.deepEqual(store.handoff(id).result, originalResult);
  assert.deepEqual(store.handoff(id).corrections, originalHistory);
  assert.ok(records.read(resultId(id)));
  assert.ok(records.read(historyId(id)));

  const cleared = { ...store.handoff(id), result: null, result_source_receipt: null, corrections: [] };
  store.putHandoff(cleared);
  assert.equal(records.read(resultId(id)), null, 'clearing the result retracts its detached payload');
  assert.equal(records.read(historyId(id)), null, 'clearing corrections retracts their detached history');
  assert.equal(store.handoff(id).result, null);
  assert.deepEqual(store.handoff(id).corrections, []);

  // An absent detached record is not materialized as a tombstone, and clearing it repeatedly stays harmless.
  const emptyId = `empty-${engine}`;
  store.putHandoff(job(emptyId, { result: null, corrections: [] }));
  assert.equal(records.typeOf(resultId(emptyId)), null);
  assert.equal(records.typeOf(historyId(emptyId)), null);
  store.putHandoff({ ...store.handoff(emptyId), result: null, corrections: [] });
  store.putHandoff({ ...store.handoff(id), result: null, corrections: [] });
  assert.equal(records.read(resultId(id)), null);
  assert.equal(records.read(historyId(id)), null);

  // In one transaction a clear followed by a replacement must keep the replacement payloads.
  const replacementResult = { answer: 'Replacement answer', evidence: ['new evidence'] };
  const replacementHistory = [{ evidence: 'Replacement correction', prior_result: originalResult }];
  store.transaction(() => {
    store.putHandoff({ ...original, result: null, result_source_receipt: null, corrections: [] });
    store.putHandoff({ ...original, result: replacementResult, result_source_receipt: receipt, corrections: replacementHistory });
  });
  assert.ok(records.read(resultId(id)));
  assert.ok(records.read(historyId(id)));
  assert.deepEqual(store.handoff(id).result, replacementResult);
  assert.deepEqual(store.handoff(id).corrections, replacementHistory);

  // Force the owner to flush pending retractions inside the SQL transaction, then roll that transaction back.
  assert.throws(() => store.transaction(() => {
    store.putHandoff({ ...store.handoff(id), result: null, result_source_receipt: null, corrections: [] });
    store.openHandoffs({ limit: 1 });
    throw new Error('synthetic rollback after retraction flush');
  }), /synthetic rollback after retraction flush/);
  assert.deepEqual(store.handoff(id).result, replacementResult, 'rollback restores the handoff reference');
  assert.deepEqual(store.handoff(id).corrections, replacementHistory, 'rollback restores the history reference');
  assert.ok(records.read(resultId(id)), 'rollback restores the detached result');
  assert.ok(records.read(historyId(id)), 'rollback restores detached history');

  // The same writer can then commit the pending retractions on a fresh transaction.
  store.putHandoff({ ...store.handoff(id), result: null, result_source_receipt: null, corrections: [] });
  assert.equal(records.read(resultId(id)), null);
  assert.equal(records.read(historyId(id)), null);
});

test('cold record-log typesOf preserves mixed types, tombstones, absence, large roots and duplicate IDs', t => {
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  const options = {
    transaction: host.transaction,
    runs: { page_bytes: 1024, memtable_bytes: 4096, cache_bytes: 0 },
    slot_bytes: 512,
  };
  const writer = recordLogStore(host.sql, options);
  writer.write([
    { id: 'small', type: 'note', value: { text: 'small root' } },
    { id: 'large-a', type: 'note', value: { text: 'A'.repeat(60_000) } },
    { id: 'large-b', type: 'other-note', value: { text: 'B'.repeat(60_000) } },
    { id: 'retired', type: 'note', value: { text: 'older value' } },
    ...Array.from({ length: 70 }, (_, n) => ({ id: `group-${String(n).padStart(3, '0')}`,
      type: n % 2 ? 'note' : 'other-note', value: { text: n < 3 ? 'large root'.repeat(130_000) : `root ${n}` } })),
  ], ACTOR);
  writer.checkpoint();
  writer.write([{ id: 'retired', type: 'note', value: null }], ACTOR);
  writer.checkpoint();
  // An older packed projection keeps only type/sequence at the id root and the value at its separate key.
  const keys = keptRuns(host.sql, { prefix: 'record_keys', transaction: host.transaction, ...options.runs });
  const legacy = keys.get('i\u0000large-b');
  keys.put(`r\u0000${legacy[0]}\u0000${legacy[1]}\u0000large-b`, legacy[2]);
  keys.put('i\u0000large-b', legacy.slice(0, 2));
  keys.flush();

  // A new store has no resident id slots; the answer must come from the persisted key roots.
  const cold = recordLogStore(host.sql, options);
  const ids = ['large-a', 'retired', 'missing', 'large-b', 'small', 'large-a', 'missing'];
  const found = cold.typesOf(ids);
  assert.deepEqual([...found], [
    ['large-a', 'note'],
    ['retired', null],
    ['missing', null],
    ['large-b', 'other-note'],
    ['small', 'note'],
  ]);
  assert.equal(cold.typeOf('large-a'), found.get('large-a'));
  assert.equal(cold.typeOf('retired'), found.get('retired'));
  assert.equal(cold.typeOf('missing'), found.get('missing'));
  const groupedIds = Array.from({ length: 70 }, (_, n) => `group-${String(n).padStart(3, '0')}`).reverse();
  const grouped = cold.typesOf([...groupedIds, ...groupedIds.slice(0, 3), 'missing']);
  assert.deepEqual([...grouped.keys()], [...groupedIds, 'missing'], 'cross-page batches preserve first-request order');
  for (const [id, kind] of grouped) assert.equal(kind, id === 'missing' ? null : Number(id.slice(-3)) % 2 ? 'note' : 'other-note');

  // The public record owner forwards the same batch contract after a reload.
  setRecordEngine(host.sql, 'record-log');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: value => value });
  assert.deepEqual(records.typesOf(ids), found);
});
