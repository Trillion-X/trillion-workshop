// Every shape of answer, generated, not chosen: the axes below multiply into every combination, and each one is drawn
// and checked by the renderer's own check (no problem, no fix), within the screen's limits, deterministically. A shape
// that breaks the rows shows up here as one named case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectValue, lensFor } from '../project.mjs';
import { checkSpec } from '../../../../build-a-screen-from-patches/read-data/screen-spec.mjs';
import rows from '../view-of-a-value.json' with { type: 'json' };

const leaves = { nothing: null, empty: '', words: 'A plain line', long: 'x'.repeat(5000), number: 42, negative: -3.5, yes: true, no: false,
  id: 'contact:7a21a378-b639-4655-91b5-99fe6f86b2ab', hash: '1f:' + 'ab'.repeat(32), odd: '<script>alert(1)</script>', unicode: 'Crème brûlée 🍮' };
const record = (leaf, titled) => ({ ...(titled ? { name: 'One thing' } : {}), value: leaf, 'a/b~c': leaf, nested: { inner: leaf } });
const shapes = {
  leaf: leaf => leaf,
  record: leaf => record(leaf, false),
  titled: leaf => record(leaf, true),
  few: leaf => Array.from({ length: 3 }, (_, i) => ({ ...record(leaf, true), name: `Item ${i}` })),
  many: leaf => Array.from({ length: 120 }, (_, i) => ({ ...record(leaf, true), name: `Item ${i}` })),
  words: leaf => Array.from({ length: 70 }, () => leaf),
  mixed: leaf => [leaf, { name: 'x' }, [leaf], null],
  deep: leaf => Array.from({ length: 30 }).reduce(inner => ({ inner }), leaf),
  wide: leaf => Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`field_${i}`, leaf])),
  run: leaf => ({ exit_code: 0, replayed: false, tool: 't', result: record(leaf, true) }),
  error: leaf => ({ code: 'refused', outcome: 'refused', message: typeof leaf === 'string' ? leaf : 'No' }),
  runnable: leaf => ({ label: 'Do it', run: { address: '@x', method: 'y', input: {}, fill: '/input' }, input_schema: { type: 'object', properties: {
    a: { type: 'string', default: typeof leaf === 'string' ? leaf : undefined }, b: { type: 'number', minimum: 0, maximum: 9 }, c: { type: 'boolean' },
    d: { enum: ['x', 'y'] }, e: { type: 'string', maxLength: 9000 }, f: { type: 'object' } } } }),
};
const lenses = { none: undefined, narrow: { items: 2, hidden_fields: ['value'], title_fields: ['inner'] }, first: { rules_first: ['words'] } };

test('every generated shape of answer is drawn and accepted by the renderer', () => {
  let cases = 0;
  const failures = [];
  for (const [shapeName, shape] of Object.entries(shapes)) for (const [leafName, leaf] of Object.entries(leaves)) for (const [lensName, lens] of Object.entries(lenses)) {
    const name = `${shapeName} of ${leafName}, lens ${lensName}`;
    cases += 1;
    try {
      const value = shape(leaf);
      const drawn = projectValue(value, { lens });
      const checked = checkSpec(drawn.spec, { requests: drawn.requests });
      if (checked.problems.length || checked.fixes.length) failures.push(`${name}: ${JSON.stringify([...checked.problems, ...checked.fixes]).slice(0, 200)}`);
      if (!drawn.spec.root || !drawn.spec.elements[drawn.spec.root]) failures.push(`${name}: no root`);
      if (Object.keys(drawn.spec.elements).length > rows.limits.items * 8 + 8) failures.push(`${name}: ${Object.keys(drawn.spec.elements).length} elements`);
      if (JSON.stringify(projectValue(value, { lens })) !== JSON.stringify(drawn)) failures.push(`${name}: not the same twice`);
      if (shapeName !== 'runnable' && Object.keys(drawn.requests).length) failures.push(`${name}: offers a request it was not given`);
    } catch (error) { failures.push(`${name}: threw ${error.message}`); }
  }
  assert.equal(cases, Object.keys(shapes).length * Object.keys(leaves).length * Object.keys(lenses).length);
  assert.deepEqual(failures, [], `${failures.length} of ${cases} cases failed`);
});

test('lens rows hold for every shape without widening it', () => {
  const lensRows = [{ set_by: 'person', when: { fields_all: ['name'] }, lens: { items: 1 } }, { set_by: 'ai', when: {}, lens: { hidden_fields: ['nested'] } }];
  for (const shape of Object.values(shapes)) for (const leaf of Object.values(leaves)) {
    const lens = lensFor(shape(leaf), lensRows);
    for (const field of Object.keys(lens)) assert.ok(rows.lens_fields.includes(field), field);
    const drawn = projectValue(shape(leaf), { lens });
    assert.deepEqual(checkSpec(drawn.spec, { requests: drawn.requests }).problems, []);
  }
});
