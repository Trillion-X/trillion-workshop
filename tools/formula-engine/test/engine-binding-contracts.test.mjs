// Ported from old trillion test/engine-binding-contracts.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The two formula tests load the evaluator this folder ships
// (built-stored-bytes/evaluate-over-rows, old parts/formula-engine/built-stored-bytes) through rules/evaluate-over-rows.mjs,
// as before; their assertions are the old ones.
// Not here: the two stored-workflow tests (membership operands, duplicate step IDs refused before any host call). They
// ran the workflow engine's built module (old test/workflow-engine-for-tests.mjs), whose code is trillion-rust
// crates/workflow-core (executor/context.rs says "Duplicate step ID") and whose built bytes sit in trillion-apps
// web/crates/built-stored-bytes/workflow-engine; this repository holds neither, so they belong to that lane.
// Exercise the stored modules shipped to Marketplace, rather than only their Rust source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRowEvaluator } from '../rules/evaluate-over-rows.mjs';

const binding = (select, transform, fallback) => ({ $kind: 'binding', select,
  ...(transform ? { transform } : {}), ...(fallback !== undefined ? { default: fallback } : {}) });
const evaluator = loadRowEvaluator(readFileSync(new URL('../built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)));

test('stored formula mapper evaluates each item and index in its own scope', () => {
  const map = binding({ from: 'self' }, [{ op: 'op:core.map_to_nodes', args: { template: {
    id: binding({ from: 'vars', key: '$item', path: 'id' }),
    position: binding({ from: 'vars', key: '$index' }),
  } } }]);
  assert.deepEqual(evaluator.evaluate(map, [{ id: 'alpha' }, { id: 'beta' }]), [{ id: 'alpha', position: 0 }, { id: 'beta', position: 1 }]);
  assert.deepEqual(evaluator.evaluate(map, []), []);
});

test('stored formula nested failures remain errors even when defaults yield values', () => {
  const bad = binding({ from: 'self' }, [{ op: 'op:proof.unregistered' }], true);
  const nested = binding({ from: 'self' }, [{ op: 'op:core.and', args: { values: [bad] } }]);
  assert.throws(() => evaluator.evaluate(nested, {}), /operator not registered/);
  const filtered = evaluator.filterRows([{ id: 'alpha' }, { id: 'beta' }], nested);
  assert.deepEqual(filtered.matches, []);
  assert.equal(filtered.errorRows, 2);
  assert.match(filtered.firstError, /operator not registered/);
  const fallback = binding({ from: 'self', path: 'missing' }, undefined, bad);
  assert.throws(() => evaluator.evaluate(fallback, {}), /operator not registered/);
});
