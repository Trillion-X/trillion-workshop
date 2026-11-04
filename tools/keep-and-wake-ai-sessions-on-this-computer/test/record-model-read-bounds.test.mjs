// Real packed-store regressions: selected declarations and holder pages must
// remain exact when unrelated lists, wrong roles or repeated members grow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const MODEL = {
  value_kinds: { text: { is: 'string' }, id: { is: 'id' }, ids: { list_of: 'id' } },
  kinds: [{ type: 'basket', parts: [{ role: 'fruit', path: ['fruit'] }, { role: 'owner', path: ['owner'] }] }],
  declared_by: [{ type: 'shelf', kind: { path: ['holds'], prefix: 'row:' },
    properties: { path: ['columns'], name: ['name'], kind: ['shape'] },
    kind_values: { word: 'text', pointer: 'ids', file: 'id' }, parts_when: ['ids', 'id'],
    part_references: { pointer: { path: ['target'], prefix: 'shelf:', absolute_prefix: 'row:' } } }],
};
const runs = { page_bytes: 1024, memtable_bytes: 4 * 1024 * 1024, cache_bytes: 16 * 1024, big_bytes: 16 * 1024 };
const open = (host, options = {}) => recordLogStore(host.sql, { transaction: host.transaction, model: MODEL, runs, ...options });
const shelf = (id, holds, columns = [{ name: 'title', shape: 'word' }]) => ({ id, type: 'shelf', value: { holds, columns } });

test('cold selected declaration lookup does not hydrate unrelated declaring records', () => {
  const costs = [];
  for (const count of [80, 320]) {
    const host = sqliteHost(':memory:');
    const store = open(host);
    store.write([...Array.from({ length: count }, (_, index) => shelf(`shelf:unrelated-${String(index).padStart(4, '0')}`, 'unrelated')),
      shelf('shelf:chosen-owner', 'selected-kind')]);
    store.checkpoint();
    const cold = open(host);
    const exec = host.sql.exec.bind(host.sql);
    let reads = 0, bytes = 0;
    host.sql.exec = (query, ...params) => {
      const cursor = exec(query, ...params);
      if (/\bSELECT\b/i.test(query)) {
        reads += 1;
        for (const row of cursor.toArray()) for (const value of Object.values(row))
          bytes += typeof value === 'string' ? value.length : value?.byteLength ?? 0;
      }
      return cursor;
    };
    const answer = cold.model({ type: 'row:selected-kind', declaration_only: true });
    assert.equal(answer.complete, true);
    assert.deepEqual(answer.kinds, [{ type: 'row:selected-kind', declared_by: 'shelf:chosen-owner' }]);
    costs.push({ reads, bytes });
    host.db.close();
  }
  assert.ok(costs[1].reads <= costs[0].reads + 6, JSON.stringify(costs));
  assert.ok(costs[1].bytes <= costs[0].bytes * 2 + 8192, JSON.stringify(costs));
});

test('narrow reads preserve the live winner and use exact one-hop target declarations after restart', () => {
  const host = sqliteHost(':memory:');
  const store = open(host);
  const columns = [{ name: 'title', shape: 'word' }, { name: 'related', shape: 'pointer', target: 'target-owner' }, { name: 'media', shape: 'file' }];
  store.write([shelf('shelf:a', 'chosen', columns), shelf('shelf:z', 'chosen', columns), shelf('shelf:target-owner', 'other-row-kind')]);
  store.write([shelf('shelf:a', 'chosen', [...columns, { name: 'note', shape: 'word' }])]);
  assert.equal(store.model({ type: 'row:chosen', declaration_only: true }).kinds[0].declared_by,
    store.model({ type: 'row:chosen' }).kinds[0].declared_by, 'a later write keeps the authoritative warm winner');
  const file = `1f:${'b'.repeat(64)}`;
  store.write([{ id: 'row:chosen:one', type: 'row:chosen', value: { title: 'One', related: ['local-row'], media: file } }]);
  store.checkpoint();
  const cold = open(host);
  const parts = cold.partsOf('row:chosen:one', { narrow_model: true });
  assert.equal(parts.complete, true);
  assert.deepEqual(parts.parts.map(part => [part.role, part.id]), [['related', 'row:other-row-kind:local-row'], ['media', file]]);
  assert.deepEqual(cold.holdersOf('row:other-row-kind:local-row', { narrow_model: true }).holders.map(holder => [holder.id, holder.role]), [['row:chosen:one', 'related']]);
  assert.deepEqual(cold.holdersOf(file, { narrow_model: true }).holders.map(holder => [holder.id, holder.role]), [['row:chosen:one', 'media']]);
  assert.equal(cold.model({ type: 'row:chosen', declaration_only: true }).kinds[0].declared_by,
    cold.model({ type: 'row:chosen' }).kinds[0].declared_by, 'cold lookup follows the existing sorted-id load owner');
  host.db.close();
});

test('cold declaration reads report old index uncertainty and do not advance the retained build', () => {
  const host = sqliteHost(':memory:');
  const prior = recordLogStore(host.sql, { transaction: host.transaction, runs });
  prior.write([shelf('shelf:old', 'older')]);
  prior.checkpoint();
  const store = open(host);
  const before = host.db.prepare('SELECT key, value FROM record_keys_meta ORDER BY key').all();
  const answer = store.model({ type: 'row:older', declaration_only: true });
  assert.equal(answer.complete, false);
  assert.equal(answer.kinds[0].declared_by, null);
  assert.deepEqual(host.db.prepare('SELECT key, value FROM record_keys_meta ORDER BY key').all(), before);
  // A normal declaration write uses the existing owner and is available at once.
  store.write([shelf('shelf:new', 'newer')]);
  assert.equal(store.model({ type: 'row:newer', declaration_only: true }).kinds[0].declared_by, 'shelf:new');
  host.db.close();
});

test('wrong-role holder candidates consume the raw budget and continue even when the page has no matches', () => {
  const host = sqliteHost(':memory:');
  const store = open(host);
  store.write([...Array.from({ length: 1200 }, (_, index) => ({ id: `b${String(index).padStart(4, '0')}`, type: 'basket', value: { owner: 'target' } })),
    { id: 'zz-matching', type: 'basket', value: { fruit: ['target'] } }]);
  store.checkpoint();
  const cold = open(host);
  let after, pages = 0;
  const found = [];
  do {
    const page = cold.holdersOf('target', { role: 'fruit', limit: 2, narrow_model: true, ...(after ? { after } : {}) });
    assert.ok(page.examined <= 256);
    if (pages === 0) { assert.deepEqual(page.holders, []); assert.equal(typeof page.next, 'string'); }
    if (page.next) assert.ok(after === undefined || page.next > after, 'every empty candidate page advances');
    found.push(...page.holders);
    after = page.next;
    pages += 1;
    assert.ok(pages < 10);
  } while (after);
  assert.deepEqual(found.map(holder => holder.id), ['zz-matching']);
  host.db.close();
});

test('one large repeated-member holder is finished without scanning every participation key', () => {
  const host = sqliteHost(':memory:');
  const store = open(host);
  store.write([{ id: 'a', type: 'basket', value: { fruit: Array(1600).fill('target') } },
    { id: 'b', type: 'basket', value: { fruit: ['target'] } }]);
  const first = store.holdersOf('target', { limit: 1, narrow_model: true });
  assert.equal(first.examined, 256);
  assert.equal(first.holders.length, 1600);
  assert.equal(new Set(first.holders.map(holder => holder.ordinal)).size, 1600);
  assert.equal(first.next, 'a');
  const last = store.holdersOf('target', { limit: 1, after: first.next, narrow_model: true });
  assert.deepEqual(last.holders.map(holder => holder.id), ['b']);
  assert.equal(last.next, null);
  host.db.close();
});

test('an unresolved neighbor preserves already absolute references while local references remain unknown', () => {
  const host = sqliteHost(':memory:');
  const store = open(host);
  store.write([shelf('shelf:source', 'source', [{ name: 'related', shape: 'pointer', target: 'absent' }])]);
  store.write([{ id: 'row:source:one', type: 'row:source', value: { related: ['row:elsewhere:one', 'local', 'row:elsewhere:one'] } }]);
  store.checkpoint();
  const cold = open(host);
  const current = cold.partsOf('row:source:one', { narrow_model: true });
  assert.equal(current.complete, false);
  assert.deepEqual(current.parts, [
    { role: 'related', id: 'row:elsewhere:one', ordinal: 0 },
    { role: 'related', id: 'row:elsewhere:one', ordinal: 2 },
  ]);
  const holders = cold.holdersOf('row:elsewhere:one', { narrow_model: true });
  assert.equal(holders.complete, false);
  assert.deepEqual(holders.holders.map(({ id, ordinal }) => [id, ordinal]), [['row:source:one', 0], ['row:source:one', 2]]);
  assert.ok(holders.holders.every(holder => !Object.hasOwn(holder, 'set')), 'partial membership must not claim a new subset set identity');
  assert.deepEqual(cold.setsOf('row:source:one', { narrow_model: true }).sets, []);
  assert.deepEqual(cold.holdersOf('local', { narrow_model: true }).holders, []);
  assert.deepEqual(open(host).holdersOf('row:elsewhere:one').holders.map(holder => holder.id), ['row:source:one', 'row:source:one'],
    'ordinary operational callers retain their existing participation contract');
  const [whole] = open(host).setsOf('row:source:one').sets;
  assert.deepEqual(whole.members, ['row:elsewhere:one', 'local', 'row:elsewhere:one']);
  assert.deepEqual(open(host).set(whole.set).members, whole.members, 'the ordinary whole-set identity remains retained and resolvable');
  host.db.close();
});

test('missing or budget-excluded target declarations never emit a local id as an absolute record', () => {
  const host = sqliteHost(':memory:');
  const store = open(host);
  const columns = Array.from({ length: 65 }, (_, index) => ({ name: `link${index}`, shape: 'pointer', target: `target-${index}` }));
  store.write([shelf('shelf:many', 'many', columns), ...Array.from({ length: 64 }, (_, index) => shelf(`shelf:target-${index}`, `targets-${index}`))]);
  store.write([{ id: 'row:many:one', type: 'row:many', value: Object.fromEntries(columns.map(column => [column.name, ['local']])) }]);
  store.checkpoint();
  const cold = open(host);
  const page = cold.partsOf('row:many:one', { narrow_model: true });
  assert.equal(page.complete, false);
  assert.ok(page.parts.every(part => part.id.startsWith('row:targets-')));
  assert.ok(page.parts.every(part => part.role !== 'link64'));
  const limited = open(host).partsOf('row:many:one', { narrow_model: true, model_budget: { reads: 1, bytes: 8192 } });
  assert.equal(limited.complete, false);
  assert.deepEqual(limited.parts, []);
  assert.ok(limited.declaration_issues.some(issue => issue.code === 'declaration_read_budget'));
  host.db.close();
});
