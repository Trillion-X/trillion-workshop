// test/decision-progress.test.mjs
//
// How far a decision has got is counted from its own facts (src/decision-progress.json): decided, its next action
// carried out, its result checked. A step counts only when its fact is true, and the words name the furthest step.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { progressFromSteps } from '../../keep-and-wake-ai-sessions-on-this-computer/src/work-progress.mjs';

const steps = JSON.parse(readFileSync(new URL('../read-data/decision-progress.json', import.meta.url), 'utf8'));

test('a decision\'s progress counts only the steps its own facts show, and names the furthest one', () => {
  assert.equal(progressFromSteps({ decided: false }, steps), '0 of 3 steps finished (0%)');
  assert.equal(progressFromSteps({ decided: true, carried_out: false, result_checked: false }, steps), '1 of 3 steps finished (33%) · Decided');
  assert.equal(progressFromSteps({ decided: true, carried_out: true, result_checked: false }, steps), '2 of 3 steps finished (67%) · Next action carried out');
  assert.equal(progressFromSteps({ decided: true, carried_out: true, result_checked: true }, steps), '3 of 3 steps finished (100%) · Result checked');
  assert.equal(progressFromSteps({ decided: 'yes' }, steps), '0 of 3 steps finished (0%)', 'a word is never a fact');
  assert.equal(progressFromSteps(null, steps), 'Not measured');
});

test('every step names a fact the decision summary carries', () => {
  const source = readFileSync(new URL('../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs', import.meta.url), 'utf8');
  for (const step of steps.steps) assert.ok(new RegExp(`\\b${step.field}\\b`).test(source), `${step.field} is kept on the summary`);
});
