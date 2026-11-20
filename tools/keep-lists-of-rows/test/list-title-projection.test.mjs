import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareListTitles, titleText } from '../read-data/list-title-projection.mjs';
import { readFileSync } from 'node:fs';
import { initSync, evaluateFormula } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';

initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });

// Synthetic DATA, not an account fixture. The production evaluator, not a second formula implementation, decides it.
const binding = { $kind: 'binding', select: { from: 'self', path: ['display'] }, transform: [] };
const fieldKinds = [{ id: 'calculated', carries: { key: 'derive', defaults: { target: 'slot::formula-engine', result_path: ['value'] } } }];
const list = { title_field: 'label', fields: [{ id: 'label', kind: 'calculated', derive: { request: { binding } } }] };
const titles = (list, values) => { const prepared = prepareListTitles(list, values, { fieldKinds }); return prepared.finish(prepared.request ? evaluateFormula(prepared.request) : undefined); };

test('stored title behavior is preserved without invoking any formula', () => {
  const ordinary = { title_field: 'name', fields: [{ id: 'name', kind: 'text' }] };
  const prepared = prepareListTitles(ordinary, [{ name: 'Notes' }, { name: ['One', 'Two'] }, {}, { name: '' }, { name: 3 }]);
  assert.equal(prepared.request, null);
  assert.deepEqual(prepared.finish(), ['Notes', 'One, Two', null, null, null]);
  assert.equal(titleText(' '), ' ', 'preserve existing conversion rather than silently trim stored names');
  assert.deepEqual(titles({ fields: [] }, [{}]), [null]);
});

test('one batch projects current computed titles from raw values without writing or trusting stale stored names', () => {
  const rows = [{ display: 'Aster', label: 'stale' }, { display: 'Birch' }];
  const before = structuredClone(rows);
  const prepared = prepareListTitles(list, rows, { fieldKinds });
  assert.deepEqual(prepared.request, { binding, rows });
  assert.deepEqual(prepared.finish(evaluateFormula(prepared.request)), ['Aster', 'Birch']);
  assert.deepEqual(rows, before);
  rows[0].display = 'Cedar';
  assert.deepEqual(titles(list, rows), ['Cedar', 'Birch'], 'a fresh read after editing recomputes the name');
});

test('the same projected title supplies row headings, linked labels and search without a stored-name backfill', () => {
  const rows = [{ id: 'one', values: { display: 'Fjord' } }, { id: 'two', values: { display: 'Grove' } }];
  const projected = titles(list, rows.map(row => row.values));
  const visible = rows.map((row, index) => ({ ...row, title: projected[index] }));
  const links = new Map(visible.map(row => [row.id, row.title]));
  assert.equal(visible[0].title, 'Fjord');
  assert.equal(links.get('two'), 'Grove');
  assert.deepEqual(visible.filter(row => row.title.toLowerCase().includes('fjord')).map(row => row.id), ['one']);
  assert.ok(rows.every(row => !Object.hasOwn(row.values, 'label')));
});

test('an async existing-host adapter can answer the same pure projection contract', async () => {
  const prepared = prepareListTitles(list, [{ display: 'Harbor' }], { fieldKinds });
  let calls = 0;
  const existingHost = async request => { calls++; return evaluateFormula(request); };
  assert.deepEqual(prepared.finish(await existingHost(prepared.request)), ['Harbor']);
  assert.equal(calls, 1);
});

test('formula unavailability, error rows and malformed answers never become a stale title success', () => {
  const prepared = prepareListTitles(list, [{ display: 'Iris', label: 'stale' }], { fieldKinds });
  for (const answer of [undefined, {}, { values: [] }, { values: ['wrong'] }, { values: ['wrong'], errors: [{ row: 0, error: 'unavailable' }] }]) assert.throws(() => prepared.finish(answer), /title formula/);
  const broken = { ...list, fields: [{ id: 'label', kind: 'calculated' }] };
  assert.throws(() => prepareListTitles(broken, [{}], { fieldKinds }), /no formula binding/);
  assert.throws(() => prepareListTitles({ title_field: 'label', fields: [{ id: 'label', kind: 'formula' }] }, [{ label: 'stale' }]), /no formula binding/);
  assert.deepEqual(prepared.finish({ values: [' '], errors: [] }), [null], 'derived whitespace is not a usable name');
  for (const derive of [{ request: { binding }, target: 'other-engine' }, { request: { binding }, result_path: ['other'] }]) assert.throws(() => prepareListTitles({ ...list, fields: [{ ...list.fields[0], derive }] }, [{}]), /unsupported/);
  const unknownOperator = { ...binding, transform: [{ op: 'op:does-not-exist' }] };
  const bad = prepareListTitles({ ...list, fields: [{ ...list.fields[0], derive: { request: { binding: unknownOperator } } }] }, [{}]);
  assert.throws(() => bad.finish(evaluateFormula(bad.request)), /could not evaluate/);
});

test('empty batches load no evaluator and legitimate unknown results remain null', () => {
  const empty = prepareListTitles(list, [], { fieldKinds });
  assert.equal(empty.request, null); assert.deepEqual(empty.finish(), []);
  assert.deepEqual(titles(list, [{}]), [null]);
  assert.throws(() => prepareListTitles(null, []), /list definition/);
  assert.throws(() => prepareListTitles(list, {}), /array/);
});
