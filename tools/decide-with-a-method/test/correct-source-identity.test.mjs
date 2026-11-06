// Ported from old trillion test/correct-source-identity.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old PersonStore's POST /cases/:id/correct-source withdrew a decision opened
// from words the person never said; here that is tool:end-a-decision (decisions.mjs endDecisions) over the records
// door: the reason is required, an unknown decision is not ended, and the decision keeps every field it had. Changed as
// the owner behaves: the withdrawn status is `ended` with the status it had and why beside it (decide-with-a-method.json
// `ending`; test/decisions.test.mjs ends a decision of status invalid_source "Its source was never valid."), not the
// old `invalid_source`; the 400 and 404 answers are the tool's refusal and its `ended: false` answer.
// Left out, no running owner: the first test (POST /cases/:id/correct-source-identity, checking a kept person message
// and the original Codex handoff before re-deciding the decision as generation 2): searched the three repos for
// correct-source-identity, already_corrected and putHandoff: only the unwired client script
// tools/keep-and-wake-ai-sessions-on-this-computer/from-old-trillion/harness/correct-source-identity.mjs; no tool reads
// a handoff or a message to correct a decision's source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { endDecisions, startADecision } from '../read-data/decisions.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account } from './old-engine-for-tests.mjs';

test('a decision opened from words the person never said is withdrawn with its evidence, and its history stays', async () => {
  const door = account();
  const opened = await startADecision({ source_id: 'owed:rollout.jsonl:2026-10-05T17:15:30.932Z', goal: '# AGENTS.md instructions for /repo',
    evidence: [{ ref: 'asked', claim: 'The person asked: # AGENTS.md instructions for /repo' }],
    options: [{ id: 'keep', label: 'Generic: keep' }, { id: 'revisit', label: 'Revisit' }] }, { door });
  const case_id = opened.case_id;
  const call = (id, because) => endDecisions({ decisions: [{ decision_id: id, ...(because === undefined ? {} : { because }) }], by: 'test-agent' }, { door });
  await assert.rejects(call(case_id), /because/, 'evidence is required');
  const missing = await call('source:none', 'x');
  assert.equal(missing.decisions[0].ended, false);
  assert.match(missing.decisions[0].reason, /No decision/);
  const withdrawn = await call(case_id, 'The transcript row is Codex injected context: # AGENTS.md instructions');
  assert.equal(withdrawn.decisions[0].ended, true);
  assert.equal(withdrawn.decisions[0].previous_status, 'needs_decision');
  const saved = await readDecision(door, case_id);
  assert.equal(saved.status, 'ended');
  assert.equal(saved.ended_because, 'The transcript row is Codex injected context: # AGENTS.md instructions');
  assert.equal(saved.input.goal, '# AGENTS.md instructions for /repo', 'the history stays');
  assert.deepEqual(saved.input.evidence.map(item => item.ref), ['asked'], 'with its evidence');
});
