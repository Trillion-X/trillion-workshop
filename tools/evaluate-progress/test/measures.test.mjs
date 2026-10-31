// tools/evaluate-progress: every op of the catalog and the reducer around it, on a made-up bakery's records. Carried from the cases of
// bitfield-packages packages/progression-evaluator read-data derive-measure, latest-op, quantile, reduce-graph, span-pack, relevance-rank
// and mutual-overlap tests; their fixtures were from one product's domains, these are not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMeasure, deriveMeasures } from '../read-data/derive-measure.ts';
import { measureOps } from '../read-data/measure-ops.ts';

const facts = [
  { id: 'o1', kind: 'order', item: 'rye', qty: 2, price: 6, customer: 'ana', t: 1 },
  { id: 'o2', kind: 'order', item: 'rye', qty: 1, price: 6, customer: 'ben', t: 2 },
  { id: 'o3', kind: 'order', item: 'bagel', qty: 12, price: 1.5, customer: 'ana', t: 3 },
  { id: 'o4', kind: 'order', item: 'scone', qty: 4, price: 3, customer: 'cleo', t: 4 },
  { id: 'r1', kind: 'refund', item: 'rye', qty: 1, price: 6, customer: 'ben', t: 5 },
];
const orders = { match: { kind: 'order' }, field: ['qty'] };
const refunds = { match: { kind: 'refund' }, field: ['qty'] };
const derive = (op, inputs, params = {}, rows = facts) => deriveMeasure(rows, { id: `m-${op}`, op, inputs, params }, measureOps);

test('count, sum and distinct read the window a selector keeps, and name the facts they read', () => {
  assert.deepEqual([derive('count', [orders]).value, derive('sum', [orders]).value, derive('distinct', [{ ...orders, field: ['customer'] }]).value], [4, 19, 3]);
  assert.deepEqual(derive('count', [orders]).basis, ['o1', 'o2', 'o3', 'o4']);
  assert.deepEqual(derive('count', [{}]).value, 5);   // no match keeps every fact
});

test('a measure carries its op, how many facts it read, a window and the kind it emits, and is ok', () => {
  const measure = deriveMeasure(facts, { id: 'orders-today', op: 'count', inputs: [orders], window: { day: 'mon' }, emit: 'measure.orders' }, measureOps);
  assert.deepEqual([measure.ok, measure.confidence, measure.emit, measure.window, measure.provenance], [true, 1, 'measure.orders', { day: 'mon' }, [{ op: 'count', inputCount: 4 }]]);
});

test('ratio divides the first window by the second, by count or by sum, and says so when the second is empty', () => {
  assert.equal(derive('ratio', [refunds, orders]).value, 0.25);
  assert.equal(derive('ratio', [refunds, orders], { mode: 'sum' }).value, 1 / 19);
  const none = derive('ratio', [orders, { match: { kind: 'nothing' } }]);
  assert.deepEqual([none.value, none.confidence], [0, 0]);
});

test('bin counts values into half-open edges, band names the band of the latest value, rank orders ids', () => {
  assert.deepEqual(derive('bin', [orders], { edges: [0, 3, 10, 20] }).value, { counts: [2, 1, 1] });
  const bands = [{ max: 3, payload: 'small' }, { min: 3, payload: 'big' }];
  assert.equal(derive('band', [orders], { bands }).value, 'big');
  assert.equal(derive('band', [orders], { bands: [{ min: 100, payload: 'huge' }] }).value, null);
  assert.deepEqual(derive('rank', [orders]).value, ['o3', 'o4', 'o1', 'o2']);
  assert.deepEqual(derive('rank', [orders], { ascending: true }).value, ['o2', 'o1', 'o4', 'o3']);
});

test('latest takes the field of the fact with the highest sort key, and says nothing when there are no facts', () => {
  assert.equal(derive('latest', [{ match: { kind: 'order' }, field: ['item'] }], { sortBy: ['t'] }).value, 'scone');
  assert.equal(derive('latest', [{ match: { kind: 'order' }, field: ['item'] }], { sortBy: ['price'] }).value, 'rye');
  const none = derive('latest', [{ match: { kind: 'nothing' }, field: ['item'] }], { sortBy: ['t'] });
  assert.deepEqual([none.value, none.confidence], [null, 0]);
});

test('quantile interpolates, clamps q, and falls back to the median when q is not a number', () => {
  assert.equal(derive('quantile', [orders]).value, 3);
  assert.ok(Math.abs(derive('quantile', [orders], { q: 0.9 }).value - 9.6) < 1e-9);
  assert.equal(derive('quantile', [orders], { reduce: 'max' }).value, 12);
  assert.equal(derive('quantile', [orders], { q: -1 }).value, 1);
  assert.equal(derive('quantile', [orders], { q: Number.NaN }).value, 3);
  assert.equal(derive('quantile', [{ match: { kind: 'nothing' } }]).value, null);
});

test('angle is the angle at the middle point', () => {
  const points = [[1, 0], [0, 0], [0, 1]].map((at, index) => ({ id: `p${index}`, at }));
  const inputs = points.map((_, index) => ({ match: { id: `p${index}` }, field: ['at'] }));
  assert.ok(Math.abs(derive('angle', inputs, {}, points).value - 90) < 1e-9);
  assert.equal(derive('angle', inputs.slice(0, 2), {}, points).value, null);
});

test('rollup groups and counts, sums or averages a field per group, keeping the groups in first-seen order', () => {
  const by = { groupBy: ['item'] };
  assert.deepEqual(derive('rollup', [orders], { ...by, reduce: 'sum' }).value, { groups: { rye: 3, bagel: 12, scone: 4 }, keys: ['rye', 'bagel', 'scone'] });
  assert.deepEqual(derive('rollup', [orders], by).value.groups, { rye: 2, bagel: 1, scone: 1 });
  assert.equal(derive('rollup', [orders], { ...by, reduce: 'avg' }).value.groups.rye, 1.5);
});

test('formula combines reduced windows; dividing by zero says nothing', () => {
  const expr = { op: 'div', args: [{ input: 1, reduce: 'sum' }, { input: 0, reduce: 'sum' }] };
  assert.equal(derive('formula', [orders, refunds], { expr }).value, 1 / 19);
  assert.equal(derive('formula', [orders, refunds], { expr: { op: 'add', args: [{ const: 1 }, { input: 0, reduce: 'max' }] } }).value, 13);
  assert.equal(derive('formula', [orders, refunds], { expr: { recode: 0, map: { 2: 10 }, default: -1 } }).value, 10);
  const zero = derive('formula', [orders, { match: { kind: 'nothing' } }], { expr: { op: 'div', args: [{ input: 0, reduce: 'sum' }, { input: 1, reduce: 'sum' }] } });
  assert.deepEqual([zero.value, zero.confidence], [null, 0]);
});

test('reduce-graph walks events through the caller\'s transitions and keeps the path', () => {
  const graph = { start: 'open', transitions: [{ from: 'open', on: 'order', to: 'sold' }, { from: 'sold', on: 'refund', to: 'sold-refunded' }] };
  assert.deepEqual(derive('reduce-graph', [{}], { graph, eventField: ['kind'] }).value, { state: 'sold-refunded', path: ['open', 'sold', 'sold-refunded'] });
});

test('weighted-rank scores each fact from the caller\'s weights, names the strongest field and honours limit and ascending', () => {
  const value = derive('weighted-rank', [orders], { weights: { qty: 1, price: 2 }, limit: 2 }).value;
  assert.deepEqual(value.ranked.map(row => row.id), ['o3', 'o1']);
  assert.deepEqual([value.top, value.ranked[0].factor, value.scores.o4], ['o3', 'qty', 10]);
  assert.equal(derive('weighted-rank', [orders], { weights: { qty: 1, price: 2 }, ascending: true }).value.top, 'o4');
});

test('derive-spans turns time fields into padded spans and drops what is under the least score or not a number', () => {
  const params = { timeField: ['t'], preS: 1, postS: 2, scoreField: ['qty'], minScore: 2, category: 'order' };
  const spans = derive('derive-spans', [{ match: { kind: 'order' } }], params).value;
  assert.deepEqual(spans.map(span => [span.id, span.start, span.end, span.score]), [['o1', 0, 3, 2], ['o3', 2, 5, 12], ['o4', 3, 6, 4]]);
  assert.equal(derive('derive-spans', [{ match: { kind: 'order' } }], { ...params, timeUnit: 'frame' }).confidence, 0);   // frames with no fps give no spans
});

test('constrained-span-pack takes spans best score first, refusing overlaps, quotas, a duration budget and a count', () => {
  const spans = [
    { id: 'a', start: 0, end: 10, score: 5, cat: 'x' }, { id: 'b', start: 5, end: 15, score: 9, cat: 'x' },
    { id: 'c', start: 20, end: 30, score: 1, cat: 'y' }, { id: 'd', start: 40, end: 50, score: 3, cat: 'x' },
  ];
  const pack = params => derive('constrained-span-pack', [{}], { categoryField: ['cat'], ...params }, spans).value;
  const plain = pack({});
  assert.deepEqual(plain.selected.map(span => span.id), ['b', 'c', 'd']);
  assert.deepEqual(plain.rejected, [{ id: 'a', reason: 'overlap' }]);
  assert.deepEqual(pack({ perCategoryQuota: { x: 1 } }).rejected.map(item => item.reason), ['overlap', 'quota']);
  assert.deepEqual(pack({ maxDurationS: 12 }).rejected.map(item => item.reason), ['overlap', 'duration-budget', 'duration-budget']);
  assert.deepEqual(pack({ maxCount: 1 }).selected.map(span => span.id), ['b']);
  assert.deepEqual(pack({ mergeGapS: 6 }).selected[0].members, ['a', 'b']);   // a and b touch within the gap, so they merge
});

test('relevance-rank scores the overlap of query words with the weighted fields and keeps the best', () => {
  const docs = [
    { id: 'd1', title: 'Rye sourdough loaf', tags: ['bread'] }, { id: 'd2', title: 'Plain scone', tags: ['sourdough', 'rye'] }, { id: 'd3', title: 'Water', tags: [] },
  ];
  const params = { queryTerms: ['rye', 'sourdough'], candidateFields: [['title'], ['tags']], weights: [2, 1], minScore: 1 };
  const value = derive('relevance-rank', [{}], params, docs).value;
  assert.deepEqual([value.top, value.ranked.map(row => row.score)], ['d1', [4, 2]]);
  assert.deepEqual(derive('relevance-rank', [{}], { ...params, topK: 1 }, docs).value.ranked.map(row => row.id), ['d1']);
});

test('mutual-overlap pairs records that each give what the other wants; one-way is no match and a record never pairs with itself', () => {
  const people = [
    { id: 'p1', offers: ['rye'], wants: ['jam'] }, { id: 'p2', offers: ['jam'], wants: ['rye'] }, { id: 'p3', offers: ['rye'], wants: ['salt'] },
  ];
  const params = { xField: ['offers'], yField: ['wants'], minScore: 1 };
  assert.deepEqual(derive('mutual-overlap', [{}], params, people).value.map(row => [row.id, row.score]), [['p1~p2', 1]]);
  assert.deepEqual(derive('mutual-overlap', [{}], { ...params, combine: 'sum', minScore: 0 }, people).value.map(row => row.id), ['p1~p2', 'p2~p3', 'p1~p3']);
  assert.deepEqual(derive('mutual-overlap', [{}], {}, people).value, []);   // no field params: nothing made up
});

test('an op that is not in the map, or that throws, gives ok false and confidence 0 instead of a number or an error', () => {
  const unknown = derive('magic', [orders]);
  assert.deepEqual([unknown.ok, unknown.confidence, unknown.value, unknown.error], [false, 0, null, 'op_not_in_opmap:magic']);
  const boom = { boom: () => { throw new Error('burnt'); } };
  assert.equal(deriveMeasure(facts, { id: 'm', op: 'boom' }, boom).error, 'op_threw:burnt');
  assert.throws(() => deriveMeasure(facts, { id: 'm', op: 'boom', failClosed: false }, boom), /burnt/);
});

test('a selector matches nested objects by deep equality, and a definition can use an op this file never named', () => {
  const rows = [{ id: 'x', where: { shop: 'north', till: 1 } }, { id: 'y', where: { shop: 'south', till: 1 } }];
  assert.equal(deriveMeasure(rows, { id: 'm', op: 'count', inputs: [{ match: { where: { shop: 'north', till: 1 } } }] }, measureOps).value, 1);
  const custom = { ...measureOps, twice: inputs => ({ value: (inputs[0]?.facts.length ?? 0) * 2 }) };
  assert.deepEqual(deriveMeasures(rows, [{ id: 'a', op: 'twice', inputs: [{}] }, { id: 'b', op: 'count', inputs: [{}] }], custom).map(measure => measure.value), [4, 2]);
});

test('latest names no sort field of its own: without params.sortBy it fails closed with a sentence', () => {
  for (const params of [{}, { sortBy: [] }, { sortBy: 'recorded_at' }]) {
    const measure = derive('latest', [{ match: { kind: 'order' }, field: ['item'] }], params);
    assert.deepEqual([measure.ok, measure.value, measure.confidence], [false, null, 0]);
    assert.match(measure.error, /latest needs params\.sortBy/);
  }
});
