// A list's title is derived on every read from its formula (keep-lists-of-rows list-title-projection.mjs), without
// changing the stored values; a stored title keeps its representation; bad formula DATA is refused, never a stale title.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readListView } from '../read-data/list-view.mjs';

const names = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}' };
const binding = { $kind: 'binding', select: { from: 'self', path: ['display'] }, transform: [] };
function fixture() {
  const definition = { row_type: 'entry', row_records: { type: 'entry', prefix: 'entry:group:' }, title_field: 'label',
    fields: [{ id: 'label', kind: 'formula', derive: { request: { binding } } }] };
  const values = { display: 'Aster', label: 'stale title' };
  const stored = () => ({ records: [
    { id: 'list:items', type: 'list', value: definition },
    { id: 'entry:group:one', type: 'entry', value: values },
  ] });
  return { definition, values, stored };
}

test('the list reader derives its title on every read without changing stored values', () => {
  const f = fixture(), before = structuredClone(f.values);
  const first = readListView({ list: 'items', names, stored: f.stored() });
  assert.equal(first.rows[0].title, 'Aster');
  assert.equal(first.rows[0].record_id, 'entry:group:one');
  assert.deepEqual(f.values, before);
  f.values.display = 'Birch';
  assert.equal(readListView({ list: 'items', names, stored: f.stored() }).rows[0].title, 'Birch');
  assert.equal(f.values.label, 'stale title');
});

test('ordinary stored titles keep the existing reader representation', () => {
  const f = fixture();
  f.definition.fields = [{ id: 'label', kind: 'text' }];
  for (const value of [0, ['One', 'Two'], ' ']) {
    f.values.label = value;
    assert.deepEqual(readListView({ list: 'items', names, stored: f.stored() }).rows[0].title, value);
  }
});

test('bad formula DATA and evaluator failures never return a stale or empty-list success', () => {
  const f = fixture();
  delete f.definition.fields[0].derive;
  assert.throws(() => readListView({ list: 'items', names, stored: f.stored() }), /no formula binding/);
  f.definition.fields[0].derive = { request: { binding: { ...binding, transform: [{ op: 'op:not-a-real-operator' }] } } };
  assert.throws(() => readListView({ list: 'items', names, stored: f.stored() }), /could not evaluate/);
  assert.equal(f.values.label, 'stale title');
});
