// tools/evaluate-progress: stages that read each other's rows, the half-open band, the path walker and the rules a number fires.
// Carried from the pipeline, band-membership, get-path and evaluate-progression tests of bitfield-packages packages/progression-evaluator, on a made-up bakery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bandContains, bandIndexOf, bandPayloadOf } from '../read-data/band-membership.ts';
import { evaluateProgression } from '../read-data/evaluate-progression.ts';
import { getPath } from '../read-data/get-path.ts';
import { measureOps } from '../read-data/measure-ops.ts';
import { RAW_FACTS, runMeasurePipeline } from '../read-data/measure-pipeline.ts';

const orders = [1, 2, 3, 4].map(t => ({ id: `o${t}`, kind: 'order', t, qty: t * 3 % 5 }));   // qty 3, 1, 4, 2

test('a later stage reads the rows an earlier stage emitted, and the last stage is the answer', () => {
  const pipeline = {
    stages: [
      { id: 'spans', def: { id: 'spans', op: 'derive-spans', inputs: [{ match: { kind: 'order' } }], params: { timeField: ['t'], postS: 0.5, scoreField: ['qty'] }, emit: 'span' } },
      { id: 'pack', from: ['spans'], def: { id: 'pack', op: 'constrained-span-pack', inputs: [{ match: { kind: 'span' } }], params: { maxCount: 2 } } },
    ],
  };
  const run = runMeasurePipeline(orders, pipeline, measureOps);
  assert.deepEqual(run.order, ['spans', 'pack']);
  assert.deepEqual(run.result.value.selected.map(span => span.id), ['o1', 'o3']);
  assert.deepEqual(run.result.value.rejected, [{ id: 'o4', reason: 'max-count' }, { id: 'o2', reason: 'max-count' }]);
  assert.equal(run.stages.spans.value[0].kind, undefined);   // the stage's value is its rows; emit names the kind a reader sees
});

test('a stage with no from reads the raw facts, "$facts" can be named, and result picks any stage', () => {
  const pipeline = { stages: [{ id: 'all', def: { id: 'all', op: 'count', inputs: [{}] } }, { id: 'again', from: [RAW_FACTS], def: { id: 'again', op: 'sum', inputs: [{ field: ['qty'] }] } }], result: 'all' };
  const run = runMeasurePipeline(orders, pipeline, measureOps);
  assert.deepEqual([run.result.value, run.stages.again.value], [4, 10]);
  assert.equal(runMeasurePipeline(orders, { stages: [] }, measureOps).result, null);
});

test('a stage that reads a stage that is not a list of rows gets no rows', () => {
  const pipeline = { stages: [{ id: 'n', def: { id: 'n', op: 'count', inputs: [{}] } }, { id: 'after', from: ['n'], def: { id: 'after', op: 'count', inputs: [{}] } }] };
  assert.equal(runMeasurePipeline(orders, pipeline, measureOps).result.value, 0);
});

test('a band holds [min, max): the min is in, the max is out, an omitted side is open, the first band wins, a non-number matches none', () => {
  assert.deepEqual([bandContains(0.6, { min: 0.6, max: 0.85 }), bandContains(0.85, { min: 0.6, max: 0.85 }), bandContains(-1e9, { max: 0 }), bandContains(1e9, { min: 0 })], [true, false, true, true]);
  assert.equal(bandIndexOf(5, [{ max: 3 }, { min: 3, max: 8 }, { min: 4 }]), 1);
  assert.deepEqual([bandIndexOf(Number.NaN, [{}]), bandIndexOf(1, undefined), bandIndexOf(1, [])], [-1, -1, -1]);
  assert.equal(bandPayloadOf(1, [{ max: 3, payload: 'low' }]), 'low');
  assert.equal(bandPayloadOf(5, [{ max: 3 }, { min: 3 }]), 1);   // no payload: the band's index
  assert.equal(bandPayloadOf(5, [{ max: 3 }]), undefined);
});

test('getPath walks a path array, gives the object for an empty path and undefined for a missing segment or a non-object', () => {
  const value = { a: { b: [10, 20] }, n: null };
  assert.deepEqual([getPath(value, ['a', 'b', '1']), getPath(value, []), getPath(value, undefined) === value, getPath(value, ['a', 'x', 'y']), getPath(value, ['n', 'z']), getPath('text', ['length'])], [20, value, true, undefined, undefined, undefined]);
});

const ladder = [
  { id: 'rule:low', metricRef: 'sell-through', band: { max: 0.6 }, adjustment: { bake: -1 }, label: 'bake less' },
  { id: 'rule:steady', metricRef: 'sell-through', band: { min: 0.6, max: 0.85 }, adjustment: { bake: 0 } },
  { id: 'rule:high', metricRef: 'sell-through', band: { min: 0.85 }, adjustment: { bake: 1 } },
];

test('a number fires exactly the rules whose band holds it, each carrying the caller\'s adjustment', () => {
  const at = value => evaluateProgression({ signals: [{ metricRef: 'sell-through', value }], rules: ladder });
  assert.deepEqual([0.5, 0.6, 0.84, 0.85].map(value => at(value).fired.map(item => item.rule.id)), [['rule:low'], ['rule:steady'], ['rule:steady'], ['rule:high']]);
  assert.deepEqual(at(0.9).adjustments, [{ bake: 1 }]);
  assert.equal(at(0.9).fired[0].metricValue, 0.9);
});

test('a metric with no number, a number that is not finite and rules that overlap', () => {
  const none = evaluateProgression({ signals: [{ metricRef: 'other', value: 0.1 }, { metricRef: 'sell-through', value: Number.NaN }], rules: ladder });
  assert.deepEqual([none.matched, none.fired, none.adjustments], [false, [], []]);
  const both = evaluateProgression({ signals: [{ metricRef: 'sell-through', value: 0.9 }], rules: [...ladder, { id: 'rule:any', metricRef: 'sell-through', band: {}, adjustment: { note: 1 } }] });
  assert.deepEqual(both.fired.map(item => item.rule.id), ['rule:high', 'rule:any']);   // rule order is kept, more than one can fire
  assert.deepEqual(evaluateProgression({ signals: undefined, rules: undefined }), { fired: [], adjustments: [], matched: false });
});
