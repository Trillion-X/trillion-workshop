// Ported from old trillion test/execution-lookup.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. findExecutionRecords is this tool's src/execution-context.mjs. Left out: the test that cut
// PersonStore.activityTrace out of the retired src/person-store.mjs source and drove it; no running code has that entry
// point (searched the three repos for "activityTrace(": none outside held copies). The other four tests are the old ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executionReferencePage, findExecutionRecords } from '../src/execution-context.mjs';

function fixture(rows) {
  const values = new Map(rows.map(row => [row.id, row]));
  const pages = [], reads = [];
  return { pages, reads, eeaf: {
    typeOf: id => values.get(id)?.type ?? null,
    read: id => { reads.push(id); return values.get(id)?.value ?? null; },
    ids: (type, { before, limit }) => {
      assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 101);
      pages.push({ type, before, limit });
      return rows.filter(row => row.type === type && (before === undefined || row.id < before))
        .map(row => row.id).sort().reverse().slice(0, limit);
    },
    find: () => { throw new Error('A receipt lookup must not scan history until enough text matches'); },
  } };
}

test('native workflow addresses reuse their declared owner identity without reading execution history', () => {
  for (const [asked, target] of [
    ['run:987425d0c4a3e1d5f44616a4', 'run:987425d0c4a3e1d5f44616a4'],
    ['workflow-run:run:987425d0c4a3e1d5f44616a4', 'run:987425d0c4a3e1d5f44616a4'],
    ['workflow-output:run:987425d0c4a3e1d5f44616a4:inspect', 'workflow-output:run:987425d0c4a3e1d5f44616a4:inspect'],
  ]) {
    const f = fixture([{ id: 'execution:observed', type: 'execution', value: { links: { record_refs: [target] } } }]);
    const found = findExecutionRecords(f.eeaf, { item: asked, limit: 1 }, { references: (ref, options) => {
      assert.equal(ref, target);
      assert.equal(options.limit, 1);
      return { records: [{ id: 'execution:observed' }], coverage: { complete: true, index_complete: true, examined: 1 } };
    } });
    assert.equal(f.pages.length, 0);
    assert.equal(found.records[0].id, 'execution:observed');
    assert.equal(found.coverage.lookup, 'indexed_exact_match');
    assert.equal(found.coverage.lookup_target, target);
    assert.equal(found.coverage.candidate_records_examined, 0);
  }
});

test('sparse provider search pages raw candidates before matching and finds later records without replaying earlier pages', () => {
  const rows = Array.from({ length: 37 }, (_, i) => ({ id: `execution:${String(i).padStart(3, '0')}`, type: 'execution',
    value: { observation: { provider: 'mail', account: i === 12 ? 'other' : 'chosen', object_id: [1, 12, 20].includes(i) ? 'provider-id' : 'provider-id-extra' } } }));
  rows.push({ id: 'record:sent:late', type: 'record:sent', value: { provider: 'mail', provider_account: 'chosen', provider_id: 'provider-id' } });
  const f = fixture(rows), found = [];
  let cursor = null, calls = 0;
  do {
    const before = f.reads.length;
    const result = findExecutionRecords(f.eeaf, { item: 'provider-id', provider: 'mail', account: 'chosen', object_id: 'provider-id', limit: 3, cursor });
    assert.ok(result.coverage.candidate_records_examined <= 3);
    assert.ok(f.reads.length - before <= 3, 'only the selected raw candidate bodies are read');
    assert.equal(result.coverage.candidate_work_bounded, true);
    if (result.coverage.more) assert.equal(result.coverage.complete, false);
    found.push(...result.records.map(row => row.id));
    cursor = result.coverage.next_cursor;
    assert.ok(++calls < 20, 'continuation makes progress across both existing record kinds');
  } while (cursor);
  assert.deepEqual(found, ['execution:020', 'execution:001', 'record:sent:late']);
  assert.equal(f.reads.length, rows.length);
  assert.equal(new Set(f.reads).size, rows.length, 'no candidate is hydrated twice across pages');
});

test('a composite continuation advances the relation and raw-candidate owners separately and binds the provider account', () => {
  const target = 'external-object';
  const f = fixture(Array.from({ length: 5 }, (_, i) => ({ id: `execution:${i}`, type: 'execution', value: { links: { record_refs: [target] } } })));
  let relationCalls = 0;
  const references = (ref, { cursor }) => {
    assert.equal(ref, target);
    relationCalls += 1;
    if (cursor === null) return { records: [{ id: 'execution:4' }], coverage: { complete: false, examined: 1, more: true,
      next_cursor: JSON.stringify({ target, via: 'links.record_refs', position: 1 }) } };
    assert.deepEqual(JSON.parse(cursor), { target, via: 'links.record_refs', position: 1 });
    return { records: [], coverage: { complete: false, examined: 0, more: false, next_cursor: null } };
  };
  const first = findExecutionRecords(f.eeaf, { item: target, limit: 2 }, { references });
  assert.ok(first.coverage.next_cursor.startsWith('execution-lookup:'));
  const second = findExecutionRecords(f.eeaf, { item: target, limit: 2, cursor: first.coverage.next_cursor }, { references });
  assert.equal(relationCalls, 2);
  const third = findExecutionRecords(f.eeaf, { item: target, limit: 2, cursor: second.coverage.next_cursor }, { references });
  assert.equal(relationCalls, 2, 'an exhausted relation leg is not restarted while raw candidates continue');
  assert.equal(third.coverage.complete, false, 'a continued subset never becomes a full-history claim');
  assert.throws(() => findExecutionRecords(f.eeaf, { item: 'different-object', cursor: first.coverage.next_cursor }, { references }), /does not belong/);
  assert.throws(() => findExecutionRecords(f.eeaf, { item: target, account: 'different-account', cursor: first.coverage.next_cursor }, { references }), /does not belong/);
  assert.equal(relationCalls, 2, 'invalid continuations are refused before an owner read');
});

test('missing bounded candidate capability is explicit, never a false complete empty search', () => {
  const result = findExecutionRecords({ typeOf: () => null, read: () => null, find: () => { throw new Error('unbounded'); } }, { item: 'unqualified-provider-id' });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.candidate_reader, 'unavailable');
  assert.deepEqual(result.records, []);
});
