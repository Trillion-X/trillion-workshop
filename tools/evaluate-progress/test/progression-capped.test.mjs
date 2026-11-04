// A measure may bound what counts so a reward cannot be gamed (read-data/progression.mjs `capped_count`), all of it DATA.
import assert from 'node:assert/strict';
import test from 'node:test';
import { measuresOf } from '../read-data/progression.mjs';

const at = (hour, minute = 0) => new Date(Date.UTC(2026, 9, 19, hour, minute)).toISOString();
const spam = [...Array.from({ length: 30 }, (_, i) => ({ kind: 'switch', at: at(9, i) })), ...Array.from({ length: 5 }, (_, i) => ({ kind: 'switch', at: at(10, i) }))];
const focus = Array.from({ length: 8 }, (_, i) => ({ kind: 'focus', at: at(9 + i) }));
const measure = params => measuresOf([...spam, ...focus], { measures: [{ id: 'm', op: 'capped_count', inputs: [{ match: { kind: 'switch' } }], params }] }).m;

test('per-period, total and minimum limits bound a measure; none given counts everything', () => {
  assert.equal(measure({}), 35);
  assert.equal(measure({ per: 'hour', per_cap: 10 }), 15, '10 in the busy hour + 5 in the next');
  assert.equal(measure({ per: 'hour', per_cap: 10, cap: 12 }), 12);
  assert.equal(measure({ min: 36 }), 0, 'below the minimum nothing counts');
  assert.equal(measure({ min: 35 }), 35);
  assert.equal(measure({ per: 'fortnight', per_cap: 1 }), 35, 'an unknown bucket unit is no rate cap');
});

test('weights apply per input and caps see each input apart', () => {
  const value = measuresOf([...spam, ...focus], { measures: [{ id: 'm', op: 'capped_count', inputs: [{ match: { kind: 'switch' } }, { match: { kind: 'focus' } }], params: { per: 'hour', per_cap: 1, weights: [-1, 2] } }] }).m;
  assert.equal(value, -2 + 16, 'two busy switch hours cost 1 each, eight focus hours earn 2 each');
});
