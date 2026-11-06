// Ported from old trillion test/check-uses.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The three tests over src/check-uses.mjs's own functions run here as they were, against this
// tool's src/check-uses.mjs; the method's check ids (old src/private-method.mjs checkQuestions) are the old method's ids,
// listed below. Left out: the seven tests that made decisions through the retired DecisionEngine and its routes
// (src/engine.mjs, src/routes.mjs, src/local-store.mjs localStore, src/screen.mjs progressFacts). Decisions are made by
// tools/decide-with-a-method's door tools now (read-data/decisions.mjs), and their what-helped view is
// read-data/work-screen.mjs, whose test/work-screen.test.mjs already checks a refusal naming a check (revised / refused),
// below-the-minimum counts and the whole view over every decided decision (seeMyDecisions reads it through the records
// door, not an engine's mapDecided); nothing running is the DecisionEngine or its /choices route (searched the three
// repos for DecisionEngine, handleCaseRequest and "/choices": only held copies under from-old-trillion).
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorkItem, currentDecisionOutcome, decisionResult, decisionStatus, whatHelped, whatHelpedSections } from '../src/check-uses.mjs';

// The old method's check ids and questions (old src/private-method.mjs checkQuestions).
const checkQuestions = () => ({
  worth_weighing: 'Is this worth weighing beyond a quick choice?',
  compare_existing: 'Could something that already exists do this?',
});

// A lookup for a decision that does not exist comes back null. A default parameter does not cover null, so this once
// threw "Cannot read properties of null (reading 'outcome_checks')" on every decision call.
test('a missing (null) decision has no outcome and no result instead of throwing', () => {
  for (const missing of [null, undefined]) {
    assert.equal(currentDecisionOutcome(missing), null);
    assert.equal(decisionResult(missing), null);
    assert.equal(decisionStatus(missing), undefined);
  }
});

test('a decision result follows current evidence chronology, and uncertainty is not hidden by an older success', () => {
  assert.equal(decisionResult({}), null);
  assert.deepEqual(decisionResult({ reports: [{ result: 'failed', reported_at: '2026-01-01' }] }), { result: 'failed', at: '2026-01-01', by: 'reported' });
  assert.equal(decisionResult({ reports: [{ result: 'failed' }], outcome_checks: [{ result: 'met', checked_at: '2026-01-02' }, { result: 'unknown', checked_at: '2026-01-03' }] }), null);
  assert.equal(decisionResult({ reports: [{ result: 'failed', reported_at: '2026-01-03' }], outcome_checks: [{ result: 'met', checked_at: '2026-01-02' }] }).result, 'failed');
});

test('an agent plan keeps only known check ids and the verdicts a hook can see', () => {
  const [known] = Object.keys(checkQuestions());
  const item = agentWorkItem({ harness: 'claude-code', session_id: 's1', turn_id: 't1', checks: [{ check_id: known, verdict: 'cited' }, { check_id: 'made-up', verdict: 'cited' }, { check_id: known, verdict: 'passed' }], landed_commit: 'abc1234', usage: { output_tokens: 5, model: 'x' } }, Object.keys(checkQuestions()));
  assert.deepEqual(item.checks, [{ check_id: known, verdict: 'cited' }]);
  assert.deepEqual(item.landed, { commit: 'abc1234' });
  assert.deepEqual(item.cost, { output_tokens: 5 });
  assert.throws(() => agentWorkItem({ harness: 'x' }, []), /session_id/);
  const view = whatHelped([], { checkText: checkQuestions(), agentWork: [item] });
  assert.deepEqual(view.agents.most_cited.map(row => row.cited), [1]);
  assert.doesNotMatch(JSON.stringify(whatHelpedSections(view)), /agent plans|landed as saved work/, 'internal AI work does not become the person’s progress');
});
