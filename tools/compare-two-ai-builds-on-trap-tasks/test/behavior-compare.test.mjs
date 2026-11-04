// Two arms scored from their recorded calls over one battery: a missing run is a 0 that stays in the denominator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batteryProblems, compareArms, scoreArm } from '../src/behavior-compare.mjs';

const calls = (...tools) => tools.map(tool => ({ tool }));
const careful = { arm: 'new', runs: [
  { task_id: 'read-before-write', state: 'done', calls: calls('read_space_record', 'write_space_record') },
  { task_id: 'no-repeat-search', state: 'done', calls: calls('search', 'read_file') },
  { task_id: 'stop-at-unknown', state: 'needs_check', calls: calls('read_sent') },
] };
const wasteful = { arm: 'old', runs: [
  { task_id: 'read-before-write', state: 'done', calls: calls('write_space_record', 'read_space_record', 'write_space_record') },
  { task_id: 'no-repeat-search', state: 'done', calls: calls(...Array(11).fill('search')) },
] };

test('each arm is scored from its calls over the whole battery, and an arm missing a run keeps it in the denominator', () => {
  const both = compareArms(careful, wasteful);
  assert.deepEqual(both.arms.map(arm => [arm.arm, arm.score, arm.of, arm.ran]), [['new', 3, 3, 3], ['old', 0, 3, 2]]);
  assert.equal(both.same_denominator, true);
  assert.deepEqual(both.differ, ['read-before-write', 'no-repeat-search', 'stop-at-unknown']);
  assert.deepEqual(scoreArm(wasteful).classes['unchecked-effect'], { score: 0, of: 1 });
});

test('a self-reported success scores nothing, and a battery naming an unknown scorer is refused in words', () => {
  const lying = { arm: 'x', runs: [{ task_id: 'stop-at-unknown', state: 'done', said: 'I checked', calls: calls('send_message') }] };
  assert.equal(scoreArm(lying).tasks.find(task => task.task_id === 'stop-at-unknown').score, 0);
  assert.match(batteryProblems({ tasks: [{ id: 't', scorers: [{ kind: 'vibes' }] }] })[0], /names the scorer vibes/);
});

test('the script prints the comparison for two trace files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arms-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify(careful));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(wasteful));
  const out = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/compare-arms.mjs', import.meta.url).pathname, join(dir, 'a.json'), join(dir, 'b.json')], { encoding: 'utf8' }));
  assert.equal(out.arms[0].score, 3);
  assert.equal(out.arms[1].of, 3);
});
