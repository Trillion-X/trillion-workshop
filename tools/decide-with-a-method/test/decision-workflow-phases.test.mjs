// Ported from old trillion test/decision-workflow-phases.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old engine's planning step (src/engine.mjs guide, decideGuided,
// recordCarriedOut over src/private-method.mjs) is this tool's door tools over a made-up method with two candidate
// workflows on its first step after the scope (read-data/method.mjs workflowsDue); the obligations a plan leaves are
// tools/track-decision-obligations/src/decision-workflows.mjs (moved byte for byte), which the run-checking tests use as
// they did. The old engine's in-memory store and its restart are a fresh read of the same records door.
// Changed as the owner behaves (README "Not here yet": "A workflow run named by run_id cannot be read by these tools, so
// it is refused, and a plan whose decision needs a finished decision-phase run waits", words.run_id_unchecked and
// words.decision_phase_runs): every run_id a plan, a decision or a receipt names is refused, so a finished run is never
// reused or bound here, and a person's `met` report never verifies an outcome (decisions.mjs applyOutcome: only a
// checked result does). The judge is the calling AI's (read-data/verdicts.mjs), its refusal named by check words.
// Left out, no running owner: recordOutcomeCheck and the independent observer (executeAction, observeOutcome; the
// ninth test, and the outcome-check halves of the fourth and last): searched the three repos for recordOutcomeCheck,
// observeOutcome and executeAction: none outside held copies; this tool takes the person's report only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerADecisionQuestion, makeTheDecision, nextDecisionQuestion, reportADecisionResult, sayWhatWasDone, startADecision } from '../read-data/decisions.mjs';
import { readDecision, recordsOf, writeDecision } from '../read-data/decision-records.mjs';
import { validateWorkflowBindings, workflowObligations, workflowRunProblems } from '../../track-decision-obligations/src/decision-workflows.mjs';
import { plainMethod } from './fixtures.mjs';
import { account, fill } from './old-engine-for-tests.mjs';

const FIND = 'workflow:find-proof';
const CHANGE = 'workflow:make-change';
const decision = extra => ({ option_id: 'repair', reason: 'Repair the demonstrated dependency', evidence_refs: ['source'], next_action: 'Make the chosen change and check it', success_measure: 'The independent observer sees the intended result', ...extra });
const applicable = (required_phase, extra = {}) => ({ applicable: true, required_phase, because: 'This work has a distinct unresolved result needed by the case', plan: 'Reuse a matching existing run or complete this distinct work at the declared phase', evidence_refs: ['source'], ...extra });
const unnecessary = () => ({ applicable: false, because: 'The cited primary evidence already resolves this question so another run adds no missing proof', evidence_refs: ['source'] });
const plan = (items = { [FIND]: unnecessary(), [CHANGE]: applicable('execution') }) => ({ evidence_refs: ['source'], desired_result: 'Make the dependency observable', current_state: 'The dependency is missing', workflow_runs: items });

function workflowMethod() {
  const method = plainMethod();
  method.workflows = [{ workflow_id: FIND, use: 'Resolve evidence needed to choose safely' }, { workflow_id: CHANGE, use: 'Make and verify the chosen change' }];
  method.decision_fields = [];
  return method;
}
const pass = question => (question.verdict_checks ?? []).map(check => ({ check, meets: true, rests_on: 'source', graded_by: 'second-judge-test' }));

async function fixture({ oldAnswer } = {}) {
  const door = account({ method: workflowMethod(), checks: [] });
  const started = await startADecision({ source_id: 'source', goal: 'Repair the actual result', evidence: [{ ref: 'source', claim: 'Primary observation identifies the missing dependency' }], options: [{ id: 'repair', label: 'Repair' }, { id: 'wait', label: 'Wait' }] }, { door });
  const id = started.case_id;
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: fill(started.question, { refs: ['source'], switches: { compare_existing: false } }) }, { door });
  if (oldAnswer) {
    // An answer accepted before phased planning, kept as the older engine kept it (graded, no workflow_plan).
    const record = await readDecision(door, id);
    record.guidance.push({ step_id: 'outcome', answer: oldAnswer, verdicts: [], judged_checks: 0, answered_at: '2026-10-01T00:01:00Z', version: 1, by: 'test' });
    await writeDecision(door, recordsOf(record, [1]), `seed:${id}`);
  }
  const question = async () => (await nextDecisionQuestion({ decision_id: id }, { door })).question;
  return {
    door, id, record: () => readDecision(door, id, ['scope', 'outcome', 'proof']),
    question,
    answerPlan: async (answer = plan(), verdicts = undefined) => answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer, verdicts: verdicts ?? pass(await question()) }, { door }),
    finishQuestions: async () => { const q = await question(); return answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: { ...fill(q, { refs: ['source'] }), measure: 'An independent observation must meet the success measure' }, verdicts: pass(q) }, { door }); },
    decide: extra => makeTheDecision({ decision_id: id, decision: decision(extra) }, { door }),
  };
}

test('an unanswered snapshot plans applicability without starting runs and keeps its method and earlier answer', async () => {
  const f = await fixture();
  const before = await f.record();
  const q = await f.question();
  assert.equal(q.workflow_phase, 'planning');
  for (const row of q.answer_schema.$defs.workflow_run.oneOf.slice(0, 1)) {
    assert.equal(row.required.includes('run_id'), false);
    assert.deepEqual(row.properties.required_phase.enum, ['decision', 'execution']);
  }
  assert.ok(q.workflows.every(row => row.if_distinct_run_needed && !row.next_call));
  const judgedChecks = pass(q).filter(row => row.check.startsWith('workflow_runs.'));
  await f.answerPlan();
  const after = await f.record();
  assert.equal(after.workflow_plan.version, 1);
  assert.deepEqual(after.method, before.method);
  assert.deepEqual(after.guidance[0], before.guidance[0]);
  assert.deepEqual(workflowObligations(after).map(row => [row.workflow_id, row.state]), [[CHANGE, 'planned']]);
  assert.equal(judgedChecks.length, 2);
  const { explained } = await (async () => {
    const g = await fixture();
    return nextDecisionQuestion({ decision_id: g.id, explain: [`workflow_runs.${CHANGE}`] }, { door: g.door });
  })();
  assert.match(explained[0].good_answer, /including authority/);
});

test('the applicability/phase judgment can reject unjustified deferral without accepting a plan', async () => {
  const f = await fixture();
  const q = await f.question();
  const refused = pass(q).map(row => (row.check.startsWith('workflow_runs.') ? { ...row, meets: false, missing: 'when is its proof required' } : row));
  await assert.rejects(f.answerPlan(plan(), refused), /workflow_runs.*proof required/);
  assert.equal((await f.record()).workflow_plan, undefined);
  assert.equal((await f.record()).guidance.length, 1);
});

test('planning requires cited applicability and rejects fabricated completion claims or undeclared candidates', async () => {
  for (const change of [
    value => { delete value.workflow_runs[CHANGE].required_phase; },
    value => { value.workflow_runs[CHANGE].evidence_refs = ['unknown']; },
    value => { value.workflow_runs[CHANGE].state = 'finished'; },
    value => { value.workflow_runs['workflow:unrequested'] = applicable('execution'); },
  ]) {
    const f = await fixture();
    const answer = plan();
    change(answer);
    await assert.rejects(f.answerPlan(answer));
    assert.equal((await f.record()).workflow_plan, undefined);
  }
});

test('execution can follow the choice, but planned or working runs cannot produce verified success', async () => {
  const f = await fixture();
  await f.answerPlan();
  await f.finishQuestions();
  await f.decide();
  assert.equal(workflowObligations(await f.record())[0].state, 'planned');
  assert.equal((await f.record()).status, 'needs_outcome');
  await sayWhatWasDone({ decision_id: f.id, state: 'done', what_happened: 'The immediate next action was taken' }, { door: f.door });
  await reportADecisionResult({ decision_id: f.id, result: 'met', summary: 'It looks done.', answered_by: 'person' }, { door: f.door });
  assert.equal((await f.record()).status, 'needs_outcome', 'a planned, unfinished run never yields a verified outcome');
  await assert.rejects(sayWhatWasDone({ decision_id: f.id, state: 'wall', what_happened: 'The run is waiting on its final independent observation', workflow_runs: { [CHANGE]: { run_id: 'run:change' } } }, { door: f.door }), /run_id/);
  assert.equal((await f.record()).status, 'needs_outcome');
});

test('decision-phase evidence must be finished; an existing matching finished run is reused', async () => {
  const f = await fixture();
  await f.answerPlan(plan({ [FIND]: applicable('decision'), [CHANGE]: unnecessary() }));
  const afterQuestions = await f.finishQuestions();
  assert.equal(afterQuestions.ready_for_decision, false);
  assert.match(String(afterQuestions.decision_blockers?.[0]), /planned and remains unfinished/);
  await assert.rejects(f.decide(), /planned a workflow run its decision needs \(workflow:find-proof\)/);
  // A run cannot be checked here, so naming one is refused rather than trusted.
  await assert.rejects(f.decide({ workflow_runs: { [FIND]: { run_id: 'run:existing' } } }), /run_id/);
  assert.equal((await f.record()).decision, null);
});

test('readiness checks a referenced decision-phase run again when its real state changes', async () => {
  const f = await fixture();
  await assert.rejects(f.answerPlan(plan({ [FIND]: applicable('decision', { run_id: 'run:find' }), [CHANGE]: unnecessary() })), /run_id/);
  assert.equal((await f.record()).workflow_plan, undefined);
  assert.equal((await f.record()).decision, null);
});

test('run identity and actual completion fail closed for missing readers, wrong recipes, and stale timestamps', async () => {
  const binding = { [CHANGE]: { run_id: 'run:claimed' } };
  assert.match((await workflowRunProblems(binding, undefined, { finished: true }))[0], /no account-owned.*reader/);
  assert.match((await workflowRunProblems(binding, async () => undefined, { finished: true }))[0], /not a run.*on this account/);
  assert.match((await workflowRunProblems(binding, async () => ({ recipe: { id: FIND }, state: 'finished' }), { finished: true }))[0], /not a run/);
  for (const state of ['working', 'failed', 'stuck']) {
    assert.match((await workflowRunProblems(binding, async () => ({ recipe: { id: CHANGE }, state, finished_at: '2026-10-01T00:00:00Z' }), { finished: true }))[0], /not finished/);
  }
  assert.deepEqual(await workflowRunProblems(binding, async () => ({ recipe: { id: CHANGE }, finished_at: '2026-10-01T00:00:00Z' }), { finished: true }), []);
  const f = await fixture();
  await f.answerPlan(); await f.finishQuestions(); await f.decide();
  await assert.rejects(sayWhatWasDone({ decision_id: f.id, state: 'done', what_happened: 'Claimed run', workflow_runs: binding }, { door: f.door }), /run_id/);
  assert.equal((await f.record()).carried_out, undefined);
});

test('binding a run cannot change its phase or applicability, and old-generation receipts do not close new work', async () => {
  const f = await fixture();
  await f.answerPlan(); await f.finishQuestions(); await f.decide();
  const record = await f.record();
  for (const workflow_runs of [{ [FIND]: { run_id: 'run:change' } }, { [CHANGE]: { run_id: 'run:change', required_phase: 'decision' } }]) {
    assert.throws(() => validateWorkflowBindings(record, workflow_runs), /not a declared|cannot change/);
  }
  // A receipt of the first decision names the run; a second decision after a failed result starts its work again.
  const later = { ...record, decision_generation: 2, carried_out: [{ decision_generation: 1, state: 'done', what_happened: 'First change finished', workflow_runs: { [CHANGE]: { run_id: 'run:change' } } }] };
  assert.equal(workflowObligations({ ...later, decision_generation: 1 })[0].state, 'run_referenced');
  assert.equal(workflowObligations(later)[0].state, 'planned');
  await reportADecisionResult({ decision_id: f.id, result: 'failed', summary: 'The change did not hold.', answered_by: 'person' }, { door: f.door });
  await f.decide({ reason: 'A revised choice based on the failed observation' });
  assert.equal((await f.record()).decision_generation, 2);
  assert.equal(workflowObligations(await f.record())[0].state, 'planned');
});

test('accepted historical answers replay exactly without migration, new judgment, or run availability', async () => {
  const oldAnswer = { evidence_refs: ['source'], desired_result: 'Earlier result kept', current_state: 'Earlier state kept', workflow_runs: { [FIND]: { because: 'Earlier omission', evidence_refs: ['source'] }, [CHANGE]: { run_id: 'run:legacy' } } };
  const f = await fixture({ oldAnswer });
  const before = await f.record();
  const writes = f.door.writes.length;
  const replay = await answerADecisionQuestion({ decision_id: f.id, step_id: 'outcome', answer: oldAnswer, verdicts: [{ check: 'nothing', meets: false }] }, { door: f.door });
  assert.equal(replay.replayed, true);
  assert.equal(f.door.writes.length, writes, 'a replay writes nothing');
  assert.deepEqual(await f.record(), before);
  assert.equal((await f.record()).workflow_plan, undefined);
  await f.finishQuestions(); await f.decide();
  assert.deepEqual((await f.record()).guidance[1].answer, oldAnswer);
});

test('the versioned plan survives real store step views and engine restart on both supported record layouts', async () => {
  const f = await fixture();
  const original = await f.record();
  await f.answerPlan();
  const view = await readDecision(f.door, f.id);
  assert.equal(view.guidance[1].answer, undefined, 'a step view keeps later answers as summaries');
  assert.equal(view.workflow_plan.version, 1);
  // A fresh read of the same records, as a restarted engine would make.
  await f.finishQuestions();
  await f.decide();
  const kept = await f.record();
  assert.deepEqual(kept.method, original.method);
  assert.deepEqual(kept.guidance[0], original.guidance[0]);
  assert.deepEqual(kept.workflow_plan.items, plan().workflow_runs);
  assert.equal(workflowObligations(kept)[0].state, 'planned');
});
