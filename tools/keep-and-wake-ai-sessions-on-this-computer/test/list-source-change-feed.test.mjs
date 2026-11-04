import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { makeLists, withRowSources } from '../../keep-lists-of-rows/lists.mjs';

test('an external row source requires a fresh read even when the local store did not change', async t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  const lists = makeLists({ eeaf: store.eeaf });
  lists.save({ id: 'remote', label: 'Remote', fields: [{ id: 'name', label: 'Name' }] });
  let rows = [];
  const wrapped = withRowSources(lists, { declared: () => [{ source: 'outside' }], sources: {
    outside: async () => ({ rows, next_cursor: null }),
  } });
  const held = wrapped.changes('remote').token;
  assert.equal((await wrapped.read('remote')).rows.length, 0);
  rows = [{ id: 'new', values: { name: 'From the source' } }];
  assert.equal(wrapped.changes('remote', held).reset, true);
  assert.deepEqual((await wrapped.read('remote')).rows.map(row => row.id), ['outside~new']);
});

test('a wrapper with no external row source preserves the local change feed', () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf });
  lists.save({ id: 'local', label: 'Local', fields: [{ id: 'name', label: 'Name' }] });
  const wrapped = withRowSources(lists);
  const held = wrapped.changes('local').token;
  assert.equal(wrapped.changes('local', held).reset, false);
  store.close?.();
});
