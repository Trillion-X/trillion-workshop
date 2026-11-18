// The pooled choice set: content-free, and built only while the account shares what it decides (src/pooled-choice-set.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pooledChoiceSet } from '../src/pooled-choice-set.mjs';

test('an account that shares gets one content-free choice set: the count offered and the position run, nothing else', () => {
  const set = pooledChoiceSet({ shares: true, candidate_count: 2, chosen_index: 1 });
  assert.deepEqual(Object.keys(set).sort(), ['candidate_count', 'choice_key', 'chosen_index', 'method', 'source']);
  assert.equal(set.candidate_count, 2);
  assert.equal(set.chosen_index, 1);
  assert.match(set.choice_key, /^[0-9a-f]{32}$/);
});

test('an account that does not share pools nothing', () => {
  assert.equal(pooledChoiceSet({ shares: false, candidate_count: 2, chosen_index: 1 }), null);
});

test('each choice set gets its own key', () => {
  const first = pooledChoiceSet({ shares: true, candidate_count: 2, chosen_index: 0 });
  const second = pooledChoiceSet({ shares: true, candidate_count: 2, chosen_index: 0 });
  assert.notEqual(first.choice_key, second.choice_key);
});
