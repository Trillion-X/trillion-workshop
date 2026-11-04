import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTwoBuilds } from '../do-work/compare-two-builds.mjs';

const calls = (...tools) => tools.map(tool => ({ tool }));
test('the row compares two traces over the carried battery and refuses a missing arm or a bad battery in words', () => {
  const out = compareTwoBuilds({ left: { arm: 'a', runs: [{ task_id: 'read-before-write', state: 'done', calls: calls('read_space_record', 'write_space_record') }] }, right: { arm: 'b', runs: [] } });
  assert.deepEqual(out.arms.map(arm => [arm.score, arm.of]), [[1, 3], [0, 3]]);
  assert.deepEqual(out.differ, ['read-before-write']);
  assert.throws(() => compareTwoBuilds({ left: { runs: [] } }), /Give right/);
  assert.throws(() => compareTwoBuilds({ left: { runs: [] }, right: { runs: [] }, battery: { tasks: [{ id: 't', scorers: [{ kind: 'vibes' }] }] } }), /names the scorer vibes/);
});
