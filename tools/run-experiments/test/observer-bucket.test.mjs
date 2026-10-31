// tools/run-experiments/test/observer-bucket.test.mjs
// observerBucket gives an observer the same group every time, spreads observers over every group, and refuses a key or
// count it cannot group by. Callers that only need a group (a rollout, a sampled check) use it instead of a decider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { observerBucket } from '../read-data/score-candidates.ts';

test('an observer keeps one group, observers spread over the groups, and a bad key or count is refused', () => {
  assert.equal(observerBucket('rollout-v1:member-a', 100), observerBucket('rollout-v1:member-a', 100));
  const groups = Array.from({ length: 200 }, (_, index) => observerBucket(`rollout-v1:member-${index}`, 4));
  assert.deepEqual([...new Set(groups)].sort(), [0, 1, 2, 3]);
  for (const group of groups) assert.ok(Number.isSafeInteger(group) && group >= 0 && group < 4);
  for (const [key, count] of [['', 100], ['member', 0], ['member', 2.5]]) assert.throws(() => observerBucket(key, count));
});
