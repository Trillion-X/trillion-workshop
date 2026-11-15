// tools/run-experiments/test/outcome-totals-are-measures.test.mjs
// What each version gained is the list engine's own `sum` and `filled` measure (query-and-change-list-rows list-aggregates
// `measure`): the scoreboard's totals per candidate and metric, and the join's total per visitor, metric and candidate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aggregateOutcomes } from '../read-data/scoreboard.ts';
import { attributeOutcomes } from '../read-data/attribute-outcomes.ts';

const fact = (metric, candidate, value) => ({ path: ['candidate', 'outcome', metric, candidate], trust_ref: 'trust:derived', value });

test('a metric sums its numbers per candidate; a non-number replaces it and the numbers after it start again', () => {
  const board = aggregateOutcomes('offer', [
    fact('views', 'a', 0.1), fact('views', 'a', 0.2), fact('views', 'b', 4),
    fact('note', 'a', 'first'), fact('note', 'a', 'last'),
    fact('mixed', 'a', 5), fact('mixed', 'a', 'reset'), fact('mixed', 'a', 2), fact('mixed', 'a', 3),
    { path: ['other', 'shape'], trust_ref: 'trust:derived', value: 9 },
  ]);
  assert.equal(board.total_events, 9);
  assert.equal(board.candidates.a.views, 0.3);
  assert.equal(board.candidates.b.views, 4);
  assert.equal(board.candidates.a.note, 'last');
  assert.equal(board.candidates.a.mixed, 5);
  assert.deepEqual(aggregateOutcomes('empty', []).candidates, {});
  assert.equal(aggregateOutcomes('empty', []).total_events, 0);
});

test('the join totals what each visitor did per version: a count of one per occurrence and the value summed', () => {
  const join = {
    entity_type: 'attribution-join', join_id: 'join:test',
    assignment: { observer_key_path: ['who'], candidate_key_path: ['version'] },
    outcome: { observer_key_path: ['who'], metric_path: ['what'], value_path: ['amount'] },
    emit: { observe_address: 'offer', metric_map: { buy: 'converted' }, value_metric: 'revenue' },
  };
  const { observations, findings } = attributeOutcomes(join,
    [{ who: 'v1', version: 'a' }],
    [{ who: 'v1', what: 'buy', amount: 0.1 }, { who: 'v1', what: 'buy', amount: 0.2 }, { who: 'v1', what: 'buy' }],
    '2026-11-15T00:00:00.000Z');
  assert.deepEqual(findings, []);
  const byMetric = Object.fromEntries(observations.map(item => [item.path[2], item.value]));
  assert.deepEqual(byMetric, { converted: 3, revenue: 0.3 });
});

test('neither file holds a sum of its own: both ask the list engine', () => {
  for (const file of ['scoreboard.ts', 'attribute-outcomes.ts']) {
    const source = readFileSync(resolve(import.meta.dirname, '../read-data', file), 'utf8');
    assert.match(source, /from 'trillion-workshop\/tools\/query-and-change-list-rows\/src\/list-aggregates\.mjs'/, file);
    assert.doesNotMatch(source, /current \+ value|total \+= amount|totalEvents\+\+/, file);
  }
});
