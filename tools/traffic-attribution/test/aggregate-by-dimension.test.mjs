// tools/traffic-attribution/test/aggregate-by-dimension.test.mjs
// The counts and sums of an entity-grouped breakdown are the list engine's own measures (query-and-change-list-rows
// list-aggregates `measure`: `filled`, `sum`); grouping the entities and dividing two figures are all this tool still does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aggregateByDimension } from '../read-data/aggregate-by-dimension.ts';

const fact = (entity, path, value) => ({ address: ['observer', entity, ...path], value });
const signal = (entity, source) => fact(entity, ['observer', 'signal', 'source'], source);
const outcome = entity => fact(entity, ['candidate', 'outcome', 'purchase'], 1);
const value = (entity, amount) => fact(entity, ['candidate', 'value'], amount);

const config = {
  dimension: { entitySegmentIndex: 1, dimensionPath: ['observer', 'signal', 'source'] },
  metrics: [
    { id: 'visitors', op: 'countEntities' },
    { id: 'buyers', op: 'countEntitiesWhere', path: ['candidate', 'outcome', 'purchase'] },
    { id: 'revenue', op: 'sumOverEntities', path: ['candidate', 'value'] },
    { id: 'rate', op: 'ratio', numerator: 'buyers', denominator: 'visitors' },
  ],
};

test('each group counts its visitors and buyers and sums their value through the list engine', () => {
  const facts = [
    signal('a', 'instagram'), outcome('a'), value('a', 0.1),
    signal('b', 'instagram'), outcome('b'), value('b', 0.2),
    signal('c', 'instagram'),
    signal('d', 'newsletter'),
    fact('e', ['candidate', 'outcome', 'purchase'], 1),
  ];
  const { groups, totalEntities } = aggregateByDimension(facts, config);
  assert.equal(totalEntities, 5);
  const by = Object.fromEntries(groups.map(group => [group.dimensionKey, group.metrics]));
  assert.deepEqual(by.instagram, { visitors: 3, buyers: 2, revenue: 0.3, rate: 2 / 3 });
  assert.deepEqual(by.newsletter, { visitors: 1, buyers: 0, revenue: 0, rate: 0 });
  assert.deepEqual(by['(unattributed)'], { visitors: 1, buyers: 1, revenue: 0, rate: 1 });
  assert.deepEqual(groups.map(group => group.dimensionKey), ['instagram', '(unattributed)', 'newsletter']);
});

test('the file holds no sum or count of its own: it asks the list engine', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../read-data/aggregate-by-dimension.ts'), 'utf8');
  assert.match(source, /from 'trillion-workshop\/tools\/query-and-change-list-rows\/src\/list-aggregates\.mjs'/);
  assert.doesNotMatch(source, /\bsum \+= |\.size;|\.size \?\? 0/);
});
