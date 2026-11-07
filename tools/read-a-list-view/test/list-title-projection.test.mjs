import test from 'node:test';
import assert from 'node:assert/strict';
import { readListView } from '../read-data/list-view.mjs';

const names = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}' };
const binding = { $kind: 'binding', select: { from: 'self', path: ['display'] }, transform: [] };
function fixture() {
  const definition = { row_type: 'entry', row_records: { type: 'entry', prefix: 'entry:group:' }, title_field: 'label',
    fields: [{ id: 'label', kind: 'formula', derive: { request: { binding } } }] };
  const values = { display: 'Aster', label: 'stale title' };
  const calls = [];
  const door = {
    async read(type, id) { assert.equal(type, 'list'); assert.equal(id, 'list:items'); return definition; },
    async list(request) { calls.push(request); return { records: [{ id: 'entry:group:one', value: values }], next: null }; },
    async run() { throw Error('A read must not run a tool'); },
    async write() { throw Error('A read must not write'); },
  };
  return { definition, values, calls, door };
}

test('the real list reader derives its title on every read without changing stored values', async () => {
  const f = fixture(), before = structuredClone(f.values);
  const first = await readListView({ list: 'items', names }, f.door);
  assert.equal(first.rows[0].title, 'Aster');
  assert.equal(first.rows[0].record_id, 'entry:group:one');
  assert.deepEqual(f.values, before);
  f.values.display = 'Birch';
  assert.equal((await readListView({ list: 'items', names }, f.door)).rows[0].title, 'Birch');
  assert.equal(f.values.label, 'stale title');
  assert.ok(f.calls.every(call => call.type === 'entry' && call.prefix === 'entry:group:'));
});

test('ordinary stored titles keep the existing reader representation', async () => {
  const f = fixture();
  f.definition.fields = [{ id: 'label', kind: 'text' }];
  for (const value of [0, ['One', 'Two'], ' ']) {
    f.values.label = value;
    assert.deepEqual((await readListView({ list: 'items', names }, f.door)).rows[0].title, value);
  }
});

test('bad formula DATA and evaluator failures never return a stale or empty-list success', async () => {
  const f = fixture();
  delete f.definition.fields[0].derive;
  await assert.rejects(readListView({ list: 'items', names }, f.door), /no formula binding/);
  f.definition.fields[0].derive = { request: { binding: { ...binding, transform: [{ op: 'op:not-a-real-operator' }] } } };
  await assert.rejects(readListView({ list: 'items', names }, f.door), /could not evaluate/);
  assert.equal(f.values.label, 'stale title');
});
