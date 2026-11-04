// test/confidence-filter.test.mjs: a second-stage filter and act/ask/abstain are DATA (the screen driver's abstain test moved with it to the Workshop's tools/drive-the-screen).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, filterEvents, probability } from '../src/confidence-filter.mjs';

test('a per-context logit keeps plausible events, passes unmodelled contexts, and a retune is a data change', () => {
  const models = [{ context: 'a', bias: -1, weights: { gap: 2 }, keep_above: 0.5 }];
  const events = [{ id: 1, c: 'a', gap: 0.1 }, { id: 2, c: 'a', gap: 1 }, { id: 3, c: 'other', gap: 0 }];
  const run = rows => filterEvents(events, rows, { contextOf: e => e.c, featuresOf: e => ({ gap: e.gap }) }).map(row => row.event.id);
  assert.deepEqual(run(models), [2, 3]);
  assert.deepEqual(run([{ ...models[0], bias: 1 }]), [1, 2, 3]);
  assert.ok(Math.abs(probability({ bias: 0, weights: {} }) - 0.5) < 1e-12);
});

test('confidence acts, asks or abstains by DATA thresholds; a missing confidence abstains', () => {
  assert.deepEqual([0.9, 0.8, 0.6, 0.5, 0.49, NaN, undefined].map(c => decide(c)), ['act', 'act', 'ask', 'ask', 'abstain', 'abstain', 'abstain']);
  assert.equal(decide(0.6, { act_at: 0.5, ask_at: 0.1 }), 'act');
});
