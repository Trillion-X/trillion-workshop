// Ported from old trillion test/decision-read-correction.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. outcomeCorrection is this tool's src/outcome-checks.mjs; its test runs as it was.
// Left out: the three tests that read and posted decisions through the retired PersonStore's /cases routes
// (test/fault/simulated-person.mjs bootPerson, person.engine): no running code serves those routes (searched the three
// repos for DecisionEngine, handleCaseRequest and "/cases/": only held copies; decisions are tools/decide-with-a-method's
// door tools now, which keep no failed-outcome correction step).
import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeCorrection } from '../src/outcome-checks.mjs';

test('null, missing and undecided partial roots have no failed-outcome correction', () => {
  for (const root of [null, undefined, {}, { id: 'case:partial', input: { goal: 'Still deciding' } },
    { id: 'case:partial', reports: [{ result: 'failed', reported_at: new Date().toISOString() }] }]) {
    assert.equal(outcomeCorrection(root), null);
  }
});
