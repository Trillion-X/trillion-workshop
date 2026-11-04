// read-data/loop-guards.mjs (DATA in read-data/loop-guards.json): the same call again and again earns one nudge and then
// the job goes back; a run of failing tools spends an error budget; a malformed call is never counted; one success
// clears the failures. Moved from old trillion test/own-ais-loop-guards.test.mjs: the assertions that test the guard
// itself, unchanged; the ones that drive the old model loop stay with that loop until it moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import rules from '../read-data/loop-guards.json' with { type: 'json' };
import { makeLoopGuard } from '../read-data/loop-guards.mjs';
import { checkRunOfCalls } from '../do-work/check-a-run-of-calls.mjs';

test('failures in a row spend the error budget; one success clears them', () => {
  const guard = makeLoopGuard(rules);
  for (let n = 0; n < rules.error_budget - 1; n += 1) assert.equal(guard.after({ name: 'x', args: { n }, failed: true }), null);
  assert.equal(guard.after({ name: 'x', args: { n: 99 }, failed: false }), null);
  for (let n = 0; n < rules.error_budget - 1; n += 1) assert.equal(guard.after({ name: 'x', args: { n: 100 + n }, failed: true }), null);
  assert.deepEqual(Object.keys(guard.after({ name: 'x', args: { n: 500 }, failed: true })), ['give_back']);
});

test('key order does not make a repeated call look different', () => {
  const guard = makeLoopGuard(rules);
  const seen = [];
  for (let n = 0; n < rules.repeat_nudge_after; n += 1) seen.push(guard.after({ name: 'x', args: n % 2 ? { a: 1, b: 2 } : { b: 2, a: 1 } }));
  assert.deepEqual(Object.keys(seen.at(-1)), ['nudge']);
});

test('the same call again and again earns one nudge, then the job goes back saying why', () => {
  const calls = Array.from({ length: 20 }, () => ({ name: 'probe', args: { a: 1, b: 2 } }));
  const run = checkRunOfCalls({ calls });
  assert.equal(run.steps.filter(step => step.nudge).length, 1, 'said once, not every turn');
  assert.match(run.steps[0].nudge, /has not moved the job/);
  assert.equal(run.at, rules.repeat_give_back_after - 1);
  assert.match(run.give_back, new RegExp(`same probe call ${rules.repeat_give_back_after} times`));
});

test('malformed calls never count and never break a run of repeats', () => {
  const slips = Array.from({ length: 40 }, (_, n) => ({ name: 'no_such_tool', args: { n }, failed: true, malformed: true }));
  assert.deepEqual(checkRunOfCalls({ calls: slips }), { steps: [] });
  const same = { name: 'probe', args: { q: 1 } };
  const run = checkRunOfCalls({ calls: [same, { ...same, malformed: true }, same, same] });
  assert.equal(run.steps[0].at, 3, 'the slip between repeats did not reset the count');
});

test('failing calls past the budget give the job back with the count said', () => {
  const run = checkRunOfCalls({ calls: Array.from({ length: 20 }, (_, n) => ({ name: 'probe', args: { n }, failed: true })) });
  assert.match(run.give_back, new RegExp(`${rules.error_budget} tool calls in a row failed`));
  assert.equal(run.at, rules.error_budget - 1);
});
