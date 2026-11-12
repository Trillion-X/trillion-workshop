// The decision tools over the person's own records, with a made-up method and made-up decisions. Ported from the old
// app's run-decision, one-pass and outcome tests where they do not depend on the old store: one source opens one
// decision, a step is answered only in its turn and replays, every check is answered and the calling AI's grounded
// refusals hold, citations are the decision's own evidence or current pursuits, a decision needs every question and
// its fields, a new decision needs a failed result first, and the records keep the old store's layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addDecisionEvidence, answerADecisionQuestion, caseIdFor, inheritableFrom, endDecisions, makeTheDecision, nextDecisionQuestion, reportADecisionResult, sayWhatWasDone, startADecision } from '../read-data/decisions.mjs';
import { shareADecision } from '../read-data/share-a-decision.mjs';
import { joinDecision, readDecision, readStep, recordsOf, writeDecision } from '../read-data/decision-records.mjs';
import { similarDecisions } from '../read-data/similar-decisions.mjs';
import { methodCatalogue } from '../read-data/method.mjs';
import { caseView, memoryDoor, plainChecks, plainMethod, today } from './fixtures.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const CHECK_REVISION = settings.records.record_revision.check !== false;
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);

const opened = {
  source_id: 'chat:pottery-1', goal: 'Decide the pottery camp price for spring',
  evidence: [{ ref: 'e1', claim: 'Last spring twelve families signed up at the old price' }, { ref: 'e2', claim: 'The kiln costs went up this year' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};
const scope = { decision_context: { worth_weighing: true, compare_existing: false }, omission_reasons: { compare_existing: { searched: ['the camp price list'], evidence_refs: ['e1'] } }, evidence_refs: ['e1'] };
const outcomeAnswer = {
  desired_result: 'Twelve families sign up at a price covering the kiln',
  current_state: 'The old price no longer covers the kiln costs',
  checklist: { 'outcome-before-after': { handled: true, how: 'Before: price below kiln costs; after: twelve families at a covering price', evidence_refs: ['e2'] } },
  evidence_refs: ['e1', 'e2'],
};
// The second judge's verdict on the one check the outcome step asks: every check is graded before an answer is kept.
const judged = [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'second-judge-test' }];
const proofAnswer = { check_by: today(), measure: 'Count the spring sign ups', evidence_refs: ['e1'] };
const decision = { option_id: 'raise', reason: 'Kiln costs went up and families still came', next_action: 'Email the families the new price', success_measure: 'Twelve sign ups by May', evidence_refs: ['e1', 'e2'], who_it_changes: 'The twelve families pay a little more and keep their camp' };

function account() {
  const door = memoryDoor();
  door.put(`record:${settings.records.method_row}:plain`, `record:${settings.records.method_row}`, plainMethod());
  for (const check of plainChecks()) door.put(`record:${settings.records.check_row}:${check.id}`, `record:${settings.records.check_row}`, check);
  return door;
}
async function answered(door) {
  const { case_id: id } = await startADecision(opened, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: proofAnswer }, { door });
  return id;
}
// The outcome answer as a decision kept it before every check needed a verdict: its step and its summary say one check
// asked and none graded.
function keptBeforeVerdicts(door, id) {
  const step = `decision-step:${id}:001`;
  const summary = `decision-answered-step:${id}:001`;
  door.put(step, door.records.get(step).type, { ...door.value(step), verdicts: { given: [] } });
  door.put(summary, door.records.get(summary).type, { ...door.value(summary), graded: 0, graded_by: '' });
}

test('one source opens one decision: the same input is that decision, different input is refused', async () => {
  const door = account();
  const first = await startADecision(opened, { door });
  assert.equal(first.case_id, caseIdFor(opened.source_id));
  assert.equal(first.question.step_id, 'scope');
  const root = caseView(door, first.case_id);
  assert.deepEqual(root.answered_steps, []);
  assert.equal(root.method.id, 'plain', 'the decision keeps the method it was opened with');
  assert.equal(root.method_id, 'plain', 'and its id beside it, for lists that weigh decisions by method');
  const kept = door.value(first.case_id);
  assert.equal(kept.input.evidence, undefined, 'the root holds no evidence itself');
  assert.deepEqual(kept.input.options, opened.options, 'its options stay on the root');
  assert.equal(kept.method, undefined, 'nor its method snapshot');
  assert.deepEqual(kept.counts, { evidence: 2, candidates: 0, reports: 0, carried_out: 0, decision_history: 0, cited_pursuits: 0, answered_steps: 0 });
  assert.deepEqual(door.value(`decision-evidence:${first.case_id}:0001`), opened.evidence[1], 'each evidence row is a record of its own');
  assert.deepEqual(door.value(`decision-method:${kept.method_identity}`).method, root.method, 'the snapshot is kept once by its identity');
  assert.equal(root.status, 'needs_decision');
  assert.equal((await startADecision(opened, { door })).case_id, first.case_id);
  await assert.rejects(startADecision({ ...opened, goal: 'Something else entirely' }, { door }), /already has decision/);
  await assert.rejects(startADecision({ ...opened, options: [opened.options[0]] }, { door }), /at least two options/);
  await assert.rejects(startADecision({ ...opened, source_id: 'x', evidence: [{ ref: 'e1', claim: 'a' }, { ref: 'e1', claim: 'b' }] }, { door }), /unique ref/);
  await assert.rejects(startADecision(opened, { door: memoryDoor() }), /no methods/);
});

test('each step is answered in its turn, kept as its own record, and the same answer again replays', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door }), /waiting for its "scope" question/);
  const scoped = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.equal(scoped.question.step_id, 'outcome');
  assert.deepEqual(scoped.method_coverage.omitted, [{ step_id: 'existing', reason: scoped.method_coverage.omitted[0].reason }]);
  assert.ok(scoped.question.checklist.some(row => row.id === 'outcome-before-after'));
  assert.equal(scoped.question.grader, settings.grader.grader, 'the calling AI is told who judges the checks');
  const again = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.equal(again.replayed, true);
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: { ...scope, evidence_refs: ['e2'] } }, { door }), /different answer/);
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door });
  const step = door.value(`decision-step:${id}:001`);
  assert.equal(step.step_id, 'outcome');
  assert.deepEqual(step.checklist.checks.map(row => row.id), ['outcome-before-after'], 'the checks asked are kept with the answer');
  assert.deepEqual(caseView(door, id).answered_steps.map(stub => stub.step_id), ['scope', 'outcome']);
  assert.equal(door.value(`decision-answered-step:${id}:001`).step_id, 'outcome', 'each answered step\'s summary is a record of its own');
  assert.equal(door.value(id).guidance, undefined, 'the root holds no answers itself');
  assert.equal(door.value(id).answered_steps, undefined, 'nor their summaries');
});

test('a change too large for one door message is written in parts, the root last, and a step keeps each check as its id, question and row identity', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  const long = { ...outcomeAnswer, current_state: 'The old price no longer covers the kiln costs. '.repeat(1200) };
  door.writes.length = 0;
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: long, verdicts: judged }, { door });
  assert.deepEqual(door.writes.at(-1).ids, [id, `decision-revision:${id}`], 'the root and its revision, last');
  const keys = door.writes.map(write => write.key);
  assert.ok(keys.slice(1, -1).every((key, at) => key.startsWith(`answer-a-decision-question:${id}:1:`) && key.endsWith(`:part:${at}`)), 'each part is keyed by its content');
  assert.ok(keys[0].endsWith(':claim'), 'the revision is claimed first');
  assert.ok(keys.at(-1).startsWith(`answer-a-decision-question:${id}:1:`) && !keys.at(-1).includes(':part:'), 'the root is keyed by its content');
  const head = door.value(`decision-step:${id}:001`);
  assert.equal(head.step_id, 'outcome', 'a step too large for one record keeps its short fields');
  assert.ok(head.kept_in_parts >= 2, 'and its whole value in parts');
  for (const write of door.writes) assert.ok(write.largest <= settings.record_bytes, `no record over ${settings.record_bytes} bytes (${write.largest})`);
  const step = (await readStep(door, `decision-step:${id}:001`));
  assert.equal(step.answer.current_state, long.current_state, 'the step reads back whole');
  assert.equal((await nextDecisionQuestion({ decision_id: id }, { door })).question.step_id, 'proof');
  const [kept] = step.checklist;
  assert.deepEqual(Object.keys(kept), ['id', 'check', 'identity']);
  assert.match(kept.identity, /^1f:[0-9a-f]{64}$/);
});

test('a call reads only the checks of the step it asks, and a check\'s whole words come by id on request', async () => {
  const door = account();
  const checkType = `record:${settings.records.check_row}`;
  const { case_id: id } = await startADecision(opened, { door });
  // The methods are the branch nodes of the same one Checks list, read by kind; no check row is read for the scope question.
  const branches = { type: checkType, where: settings.records.method_where };
  const checkReads = () => door.lists.filter(list => list.type === checkType && JSON.stringify(list) !== JSON.stringify(branches));
  assert.deepEqual(checkReads(), [], 'the scope question asks no checks');
  assert.ok(door.lists.some(list => JSON.stringify(list) === JSON.stringify(branches)), 'the methods are read as branch rows of list:checks');
  const scoped = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.deepEqual(checkReads(), [{ type: checkType, where: { step: 'outcome' } }]);
  assert.deepEqual(scoped.question.checklist, [{ id: 'outcome-before-after', check: plainChecks()[0].check }], 'a check is its id and question');
  assert.equal(scoped.explain, settings.words.explain_note);
  const explained = await nextDecisionQuestion({ decision_id: id, explain: ['outcome-before-after'] }, { door });
  assert.deepEqual(explained.explained, [{ id: 'outcome-before-after', check: plainChecks()[0].check, good_answer: plainChecks()[0].good_answer, skippable: false }]);
  assert.deepEqual(Object.keys(explained), ['case_id', 'step_id', 'explained'], 'only the words asked for');
  assert.equal(explained.step_id, 'outcome');
  await assert.rejects(nextDecisionQuestion({ decision_id: id, explain: ['existing-where'] }, { door }), /does not ask existing-where/);
  await assert.rejects(nextDecisionQuestion({ decision_id: id, explain: [] }, { door }), /from 1 to 128/);
  assert.ok(door.lists.filter(list => list.type === checkType).every(list => list.where), 'no call lists every check');
});

test('every check is answered, and a grounded refusal from the calling AI holds while an ungrounded one is ignored', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  const { checklist: _gone, ...noChecks } = outcomeAnswer;
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: noChecks, verdicts: judged }, { door }), /Say how the answer handles each check: outcome-before-after/);
  const refused = [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'which state it should end up in', graded_by: 'second-judge-test' }];
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: refused }, { door }), /checklist\.outcome-before-after: .*which state it should end up in/);
  const ungrounded = [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'a spreadsheet of costs', graded_by: 'second-judge-test' }];
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: ungrounded }, { door }), /1 of its 1 have none taken \(outcome-before-after\)/, 'an ungrounded refusal is not taken, so the check is still ungraded');
  const passed = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: [...ungrounded, ...judged] }, { door });
  assert.equal(passed.question.step_id, 'proof');
});

test('the verdicts taken are kept with their step and counted on the root, so an answered step shows whether it was judged', async () => {
  const graded = account();
  const { case_id: id } = await startADecision(opened, { door: graded });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door: graded });
  const meets = [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'second-judge-test' }];
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: meets }, { door: graded });
  assert.deepEqual(graded.value(`decision-step:${id}:001`).verdicts.given.map(verdict => [verdict.id, verdict.meets, verdict.graded_by]), [['outcome-before-after', true, 'second-judge-test']]);
  assert.deepEqual(caseView(graded, id).answered_steps.map(({ step_id, checks, graded: count, graded_by }) => ({ step_id, checks, graded: count, graded_by })), [
    { step_id: 'scope', checks: 0, graded: 0, graded_by: '' },
    { step_id: 'outcome', checks: 1, graded: 1, graded_by: 'second-judge-test' },
  ]);
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: proofAnswer }, { door: graded });
  assert.deepEqual(caseView(graded, id).answered_steps[1], { step_id: 'outcome', answered_at: caseView(graded, id).answered_steps[1].answered_at, checks: 1, graded: 1, graded_by: 'second-judge-test', version: 1, needs_recheck: false }, 'a later write keeps the counts of a step it read as its stub');

  const unjudged = account();
  const { case_id: other } = await startADecision(opened, { door: unjudged });
  await answerADecisionQuestion({ decision_id: other, step_id: 'scope', answer: scope }, { door: unjudged });
  await assert.rejects(answerADecisionQuestion({ decision_id: other, step_id: 'outcome', answer: outcomeAnswer }, { door: unjudged }), /needs a second judge's verdict.*The step stays unanswered/);
  assert.deepEqual(caseView(unjudged, other).answered_steps.map(stub => stub.step_id), ['scope'], 'an answer with a check left ungraded is not kept');
  assert.equal((await nextDecisionQuestion({ decision_id: other }, { door: unjudged })).question.step_id, 'outcome');
});

test('an answer cites only the decision\'s evidence or a current pursuit, which is copied in as it stood', async () => {
  const door = account();
  door.put('pursuit:camp', 'pursuit', { title: 'Keep the camp running', now: 'Losing money', after: 'Covering costs', status: 'active' });
  door.put('pursuit:old', 'pursuit', { title: 'An old aim', now: 'a', after: 'b', status: 'ended' });
  const { case_id: id } = await startADecision(opened, { door });
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.deepEqual(reply.pursuits.map(item => item.id), ['pursuit:camp'], 'the outcome question carries the current pursuits');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: { ...outcomeAnswer, evidence_refs: ['pursuit:old'] }, verdicts: judged }, { door }), /is not a ref of this case/);
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: { ...outcomeAnswer, evidence_refs: ['e1', 'pursuit:camp'] }, verdicts: judged }, { door });
  assert.deepEqual(caseView(door, id).cited_pursuits, { 'pursuit:camp': 'Keep the camp running: now Losing money; should be Covering costs' });
});

test('once every question is answered the decision is asked for, with similar earlier decisions beside it', async () => {
  const door = account();
  door.put('decision:earlier', 'decision', { created_at: '2026-01-01T00:00:00.000Z', method: { id: 'plain' }, status: 'needs_outcome', input: { goal: 'Decide the pottery camp price for winter', options: [{ id: 'a', label: 'Keep it' }], evidence: [] }, decision: { option_id: 'a', next_action: 'Keep the winter price' }, answered_steps: [] });
  const id = await answered(door);
  const ready = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.equal(ready.question, null);
  assert.deepEqual(ready.options, [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }]);
  assert.deepEqual(ready.decision_fields.map(field => field.name), ['who_it_changes'], 'worth weighing is on, so its field is asked');
  assert.match(ready.ai_instructions[0], /tool:make-the-decision/);
  assert.deepEqual(ready.similar_decisions.map(item => item.case_id), ['decision:earlier']);
  assert.deepEqual(ready.how_to_say_it.map(row => row.id), ['plain-words']);
});

test('a decision needs every question, its fields, a known option and the decision\'s own evidence', async () => {
  const door = account();
  const { case_id: early } = await startADecision({ ...opened, source_id: 'chat:early' }, { door });
  await assert.rejects(makeTheDecision({ decision_id: early, decision }, { door }), /Complete the guided questions/);
  const id = await answered(door);
  const { who_it_changes: _who, ...withoutField } = decision;
  await assert.rejects(makeTheDecision({ decision_id: id, decision: withoutField }, { door }), /Decision needs who_it_changes/);
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'maybe' } }, { door }), /unknown option \("maybe"\)/);
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { ...decision, evidence_refs: ['nowhere'] } }, { door }), /must cite existing evidence/);
  const refused = [{ check: 'who_it_changes', meets: false, rests_on: 'e1', missing: 'what is different for them', graded_by: 'second-judge-test' }];
  await assert.rejects(makeTheDecision({ decision_id: id, decision, verdicts: refused }, { door }), /who_it_changes: .*what is different for them/);
  const made = await makeTheDecision({ decision_id: id, decision, usage: { model_calls: 3 } }, { door });
  assert.equal(made.decision.option_id, 'raise');
  assert.match(made.resume.instruction, /Email the families the new price/);
  assert.match(made.resume.instruction, /Who it changes beyond you: The twelve families/);
  assert.match(made.ai_instructions[0], /tool:say-what-was-done with decision_id/);
  const root = caseView(door, id);
  assert.equal(root.status, 'needs_outcome');
  assert.equal(root.decision_generation, 1);
  assert.deepEqual(root.decision_usage, { model_calls: 3 });
  assert.equal((await makeTheDecision({ decision_id: id, decision }, { door })).already_decided, true);
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'keep' } }, { door }), /needs a failed result/);
});

test('a result is the person\'s; a failed one opens the decision for a new one, and the first is kept', async () => {
  const door = account();
  const id = await answered(door);
  await assert.rejects(reportADecisionResult({ decision_id: id, result: 'met', summary: 'It worked', answered_by: 'agent' }, { door }), /Ask your person/);
  await assert.rejects(reportADecisionResult({ decision_id: id, result: 'met', summary: 'It worked', answered_by: 'person' }, { door }), /no decision yet/);
  await makeTheDecision({ decision_id: id, decision }, { door });
  const failed = await reportADecisionResult({ decision_id: id, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' }, { door });
  assert.equal(failed.status, 'correction_needed');
  assert.equal(failed.report.attribution_basis, 'caller_claim', 'nothing here marks a report verified by a trusted source');
  assert.equal((await reportADecisionResult({ decision_id: id, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' }, { door })).repeated, true);
  const second = await makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'keep', reason: 'Families left at the higher price' } }, { door });
  assert.equal(second.decision.option_id, 'keep');
  const root = caseView(door, id);
  assert.equal(root.decision_generation, 2);
  assert.equal(root.decision_history.length, 1);
  assert.equal(root.decision_history[0].decision.option_id, 'raise');
  const met = await reportADecisionResult({ decision_id: id, result: 'met', summary: 'Twelve families signed up', answered_by: 'person' }, { door });
  assert.equal(met.status, 'needs_outcome', 'a person\'s claim alone never verifies the outcome');
  await assert.rejects(reportADecisionResult({ decision_id: id, result: 'met', summary: 'x', answered_by: 'person', observed_at: '2999-01-01T00:00:00Z' }, { door }), /at or before now/);
});

test('saying what was done keeps it with the decision generation it carried out', async () => {
  const door = account();
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  await assert.rejects(sayWhatWasDone({ decision_id: id, state: 'maybe', what_happened: 'x' }, { door }), /Say state/);
  const said = await sayWhatWasDone({ decision_id: id, state: 'done', what_happened: 'Sent the email to all twelve families', by: 'test-agent' }, { door });
  assert.equal(said.carried_out.decision_generation, 1);
  assert.equal((await makeTheDecision({ decision_id: id, decision }, { door })).carried_out, true);
});

test('a decision kept whole is laid apart at its next change, its calls kept as records of their own, its root written last', async () => {
  const door = account();
  const id = caseIdFor('chat:whole');
  const snapshot = methodCatalogue([plainMethod()], plainChecks()).snapshotMethod('plain');
  const calls = Array.from({ length: 300 }, (_, n) => ({ route: 'guide', accepted: true, at: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`, submission: { secret: 'never kept' } }));
  door.put(id, 'decision', { id, source_id: 'chat:whole', input: { ...opened, source_id: 'chat:whole' }, method: snapshot, status: 'needs_decision', decision: null, created_at: '2026-01-01T00:00:00.000Z', guidance: [{ step_id: 'scope', answer: scope, answered_at: '2026-01-01T00:00:01.000Z' }], calls });
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door });
  assert.equal(reply.question.step_id, 'proof');
  const root = caseView(door, id);
  assert.equal(root.guidance, undefined);
  assert.equal(root.calls, undefined);
  assert.equal(root.call_count, 300);
  assert.deepEqual(root.answered_steps.map(stub => stub.step_id), ['scope', 'outcome']);
  assert.deepEqual(root.input.evidence, opened.evidence, 'its evidence is laid apart too');
  assert.equal(door.value(id).input.evidence, undefined);
  assert.equal(door.value(id).method, undefined);
  for (const write of door.writes) assert.ok(write.bytes <= 64 * 1024);
  assert.equal(door.value(`decision-step:${id}:000`).step_id, 'scope');
  assert.equal(door.value(`decision-call:${id}:000299`).route, 'guide');
  assert.equal(door.value(`decision-call:${id}:000000`).submission, undefined, 'a call keeps no payload');
  assert.deepEqual(door.writes.at(-1).ids, [id, `decision-revision:${id}`], 'the root and its revision are written after their parts');
});

// Every record kind a decision is laid out in (read-data/decision-records.mjs).
const decisionKinds = ['decision', 'decision-step', 'decision-call', ...Object.values(settings.records.laid_apart).map(list => list.type), settings.records.method, settings.records.part.type, settings.records.record_revision.type];

test('the tool rows reach only the decision records, the person\'s pursuits and their method lists', () => {
  const tools = ['tool:start-a-decision', 'tool:next-decision-question', 'tool:answer-a-decision-question', 'tool:add-decision-evidence', 'tool:make-the-decision', 'tool:report-a-decision-result', 'tool:say-what-was-done', 'tool:end-a-decision'];
  for (const id of tools) {
    const row = rows.find(each => each.id === id);
    assert.ok(row, `${id} has a row`);
    const rights = row.invoke.records.rights;
    for (const right of rights) assert.ok([...decisionKinds, 'pursuit', 'record:check'].includes(right.kind), `${id} reaches ${right.kind}`);
    // Ending a large old-layout decision goes through its record layout, so every decision tool reaches each laid-apart kind.
    for (const kind of decisionKinds.filter(each => each !== 'decision-call')) assert.ok(rights.some(right => right.kind === kind), `${id} reaches ${kind}, where a decision keeps its parts`);
    if (['tool:add-decision-evidence', 'tool:end-a-decision'].includes(id)) assert.ok(!rights.some(right => right.kind.startsWith('record:')), 'adding evidence reads no method rows');
    // A tool that walks a method reads its rows by id (and lists by `where` only for rows written before they named their parts).
    else if (['tool:report-a-decision-result', 'tool:say-what-was-done'].includes(id)) assert.deepEqual(rights.find(right => right.kind === 'record:check')?.operations, ['records:list'], `${id} only lists record:check rows`);
    else assert.deepEqual(rights.find(right => right.kind === 'record:check')?.operations, ['records:list', 'records:read'], `${id} reads record:check rows by id and lists them only by where`);
    assert.ok(!rights.some(right => right.kind === 'pursuit' && right.operations.includes('records:write')), `${id} never writes a pursuit`);
  }
});

test('a decided decision is shared only after the plain pass and a re-identification verdict bound to its exact words', async () => {
  const door = account();
  door.put(`record:${settings.share.never_publish_row}:1`, `record:${settings.share.never_publish_row}`, { [settings.share.never_publish_field]: 'pottery camp' });
  const id = await answered(door);
  await assert.rejects(shareADecision({ decision_id: id }, { door }), /no decision yet/);
  await makeTheDecision({ decision_id: id, decision }, { door });
  const asked = await shareADecision({ decision_id: id }, { door });
  assert.equal(asked.next, 'rewrite');
  assert.equal(asked.facts.goal, 'Decide the [removed] price for spring', 'the person\'s never-publish phrase is redacted before the AI rewrites');
  assert.deepEqual(asked.shape.map(field => field.name), ['situation', 'options', 'chosen', 'why', 'measured_by']);
  const rewrite = { situation: 'Someone running a small seasonal class weighed raising its price after their costs went up.', options: ['Keep the price', 'Raise the price'], chosen: 'Raise the price', why: 'Costs went up and most people still came.', measured_by: 'About as many sign ups as last season.' };
  await assert.rejects(shareADecision({ decision_id: id, rewrite: { ...rewrite, why: 'The pottery camp costs went up.' } }, { door }), /could still point to someone: \[removed\]/);
  await assert.rejects(shareADecision({ decision_id: id, rewrite: { ...rewrite, measured_by: 'Twelve families by 2027.' } }, { door }), /could still point to someone: \[removed\]/, 'a refusal never repeats the detail it found');
  await assert.rejects(shareADecision({ decision_id: id, rewrite: { situation: 'A class price.' } }, { door }), /A rewrite is/);
  const check = await shareADecision({ decision_id: id, rewrite }, { door });
  assert.equal(check.next, 'check');
  assert.equal(check.check.tool, settings.share.check_tool);
  assert.deepEqual(check.check.rubric, settings.share.reidentification);
  assert.match(check.check.input_identity, /^blake3:[0-9a-f]{64}$/);
  // A verdict about other words, or one that was not accepted, is not this rewrite's.
  const other = await shareADecision({ decision_id: id, rewrite, reidentification: { accepted: true, review_binding: { input_identity: `blake3:${'0'.repeat(64)}` } } }, { door });
  assert.equal(other.next, 'check');
  const rejected = await shareADecision({ decision_id: id, rewrite, reidentification: { accepted: false, review_binding: { input_identity: check.check.input_identity } } }, { door });
  assert.equal(rejected.next, 'check');
  assert.equal(caseView(door, id).shared, undefined, 'nothing is kept as shared before an accepted verdict for these words');
  const shared = await shareADecision({ decision_id: id, rewrite, reidentification: { accepted: true, review_binding: { input_identity: check.check.input_identity } } }, { door });
  assert.deepEqual(shared.send, { tool: settings.share.pool_tool, entry: rewrite });
  assert.equal(caseView(door, id).shared.review_identity, check.check.input_identity);
  const changed = await shareADecision({ decision_id: id, rewrite: { ...rewrite, why: 'Costs rose and most people still came.' } }, { door });
  assert.notEqual(changed.check.input_identity, check.check.input_identity, 'the verdict binds exactly the words it reviewed');
});

test('sharing reads only the decision and the person\'s never-publish rows, and packs the tools it imports', () => {
  const row = rows.find(each => each.id === 'tool:share-a-decision');
  const rights = row.invoke.records.rights;
  for (const right of rights) assert.ok([...decisionKinds, `record:${settings.share.never_publish_row}`].includes(right.kind), right.kind);
  assert.deepEqual(rights.find(right => right.kind === `record:${settings.share.never_publish_row}`).operations, ['records:list']);
  const packed = row.invoke.files.package_files.map(item => item.package ?? item.module);
  for (const name of ['decide-with-a-method', 'learn-from-everyones-results', 'ask-a-small-model-for-a-verdict', 'content-identity', '@noble/hashes']) assert.ok(packed.includes(name), name);
});

test('a decision opened from its goal and constraints alone chooses among what its rule-out step leaves standing', async () => {
  const door = account();
  const method = plainMethod();
  method.steps.splice(2, 0, { id: 'rule_out', question: 'Which options can be ruled out now, and what fact rules each one out?', fields: [{ name: 'ruled_out', label: 'Ruled out', list: true }, { name: 'still_standing', label: 'Still standing', list: true }] });
  method.backbone[0].steps.push('rule_out');
  door.put(`record:${settings.records.method_row}:plain`, `record:${settings.records.method_row}`, method);
  const { options: _given, ...unbiased } = { ...opened, source_id: 'chat:no-options' };
  await assert.rejects(startADecision({ ...unbiased, options: [opened.options[0]] }, { door }), /at least two options/, 'options given are still at least two');
  const { case_id: id } = await startADecision(unbiased, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  const asked = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door });
  assert.equal(asked.question.step_id, 'rule_out');
  assert.match(asked.candidates_note, /opened with no options/, 'the step that lists what stands is told to generate and eliminate candidates');
  await answerADecisionQuestion({ decision_id: id, step_id: 'rule_out', answer: { ruled_out: ['Close the camp: e1 shows twelve families still want it'], still_standing: ['Raise the price', 'Keep the price and add a kiln fee'], evidence_refs: ['e1', 'e2'] } }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: proofAnswer }, { door });
  const ready = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.deepEqual(ready.options, [{ id: 'candidate:1', label: 'Raise the price' }, { id: 'candidate:2', label: 'Keep the price and add a kiln fee' }]);
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'raise' } }, { door }), /unknown option/, 'only what still stands can be chosen');
  const made = await makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'candidate:2' } }, { door });
  assert.equal(caseView(door, id).decision.option_id, 'candidate:2');
  assert.ok(made);
});

// The revised outcome: the same answer with another state, given as a revision of the earlier one.
const revisedOutcome = { ...outcomeAnswer, current_state: 'The old price no longer covers the kiln costs at all' };
const becauseKiln = { because: 'The kiln price rose again in the summer' };

test('a revised answer is a new version: the old one is kept and readable, and every later step is asked again', async () => {
  const door = account();
  const id = await answered(door);
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, verdicts: judged }, { door }), /revise\.because/, 'a different answer is not taken as it stands');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: { because: 'too short' }, verdicts: judged }, { door }), /needs revise\.because/, 'a reason of two words is too short');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: {}, verdicts: judged }, { door }), /needs revise\.because/, 'a revision with no reason is refused');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: { because: 'Costs moved again', extra: 1 }, verdicts: judged }, { door }), /revise is/, 'nothing but because and by');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'existing', answer: revisedOutcome, revise: becauseKiln }, { door }), /not asked by this decision|no answer yet/);

  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln, verdicts: judged }, { door });
  assert.deepEqual(reply.revised, { step_id: 'outcome', version: 2, previous_version: 1, needs_recheck: ['proof'] });
  assert.equal(reply.question.step_id, 'proof', 'the earliest step that stands to be asked again is asked next');
  assert.equal(reply.question.recheck.version, 1);
  assert.match(reply.recheck_note, /"outcome" was revised/);

  const root = caseView(door, id);
  assert.deepEqual(root.answered_steps.map(stub => [stub.step_id, stub.version, stub.needs_recheck]), [['scope', 1, false], ['outcome', 2, false], ['proof', 1, true]]);
  const old = door.value(`decision-step:${id}:001:v001`);
  assert.equal(old.answer.current_state, outcomeAnswer.current_state, 'the version it replaces is kept as it was');
  assert.ok(old.superseded_at, 'and says when it was superseded');
  const current = door.value(`decision-step:${id}:001`);
  assert.equal(current.answer.current_state, revisedOutcome.current_state);
  assert.deepEqual([current.version, current.revised_from, current.because, current.by], [2, 1, becauseKiln.because, settings.revision.by]);
  assert.equal(door.value(`decision-step:${id}:002`).answer.measure, proofAnswer.measure, 'a later step is kept, not deleted');

  const history = await nextDecisionQuestion({ decision_id: id, versions_of: 'outcome' }, { door });
  assert.deepEqual(history.versions.map(item => [item.version, item.current]), [[1, false], [2, true]]);
  assert.equal(history.versions[0].answer.current_state, outcomeAnswer.current_state);
  assert.equal(history.versions[1].because, becauseKiln.because);
  await assert.rejects(nextDecisionQuestion({ decision_id: id, versions_of: 'existing' }, { door }), /no answer yet/);

  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: { ...scope, evidence_refs: ['e2'] } }, { door }), /different answer/, 'an earlier answer that was not revised is still refused');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: { ...proofAnswer, measure: 'Count them in June' } }, { door }), /revise\.because/, 'a re-asked answer that changes needs its reason too');
  const sameAgain = await answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: proofAnswer }, { door });
  assert.deepEqual(sameAgain.confirmed, { step_id: 'proof', version: 1 }, 'the same answer sent again confirms it unchanged');
  assert.equal(door.value(`decision-step:${id}:002`).version, 1);
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true, answer: proofAnswer }, { door }), /sent alone/);
  assert.equal(sameAgain.question, null, 'confirmed unchanged: nothing is asked again');
  assert.equal(sameAgain.ready_for_decision, true);
  assert.equal(caseView(door, id).answered_steps[2].needs_recheck, false);
  assert.equal(door.value(`decision-step:${id}:002:v001`), null, 'a confirmation keeps no version of its own');
  assert.equal((await answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true }, { door })).replayed, true, 'and a confirmation sent after it replays');
});

test('a retried identical call replays: the same answer, the same revision, a confirmation again, nothing written twice', async () => {
  const door = account();
  const id = await answered(door);
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln, verdicts: judged }, { door });
  door.writes.length = 0;
  const again = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln, verdicts: judged }, { door });
  assert.equal(again.replayed, true);
  assert.deepEqual(door.writes, [], 'a revision sent again to the same answer writes nothing');
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true }, { door });
  door.writes.length = 0;
  assert.equal((await answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true }, { door })).replayed, true);
  assert.deepEqual(door.writes, []);
  assert.equal((await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door })).replayed, true, 'an answer from earlier replays too');
  assert.equal(door.value(`decision-step:${id}:001:v002`), null, 'and no third version appears');
});

test('a revision of a decided decision reopens it: the decision moves to history marked reopened, the answer gets its new version, later answers are asked again, and the decision is made again', async () => {
  const door = account();
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln, verdicts: judged }, { door });
  assert.deepEqual(reply.revised, { step_id: 'outcome', version: 2, previous_version: 1, needs_recheck: ['proof'] });
  assert.equal(reply.question.step_id, 'proof', 'the later answer is asked again before anything is decided');
  assert.equal(reply.reopened.from_generation, 1);
  assert.equal(reply.reopened.because, becauseKiln.because);
  assert.equal(reply.decision, null, 'the decision is open');
  assert.equal(reply.ready_for_decision, false);

  const root = caseView(door, id);
  assert.equal(root.decision, null);
  assert.equal(root.status, 'needs_decision');
  assert.equal(root.decision_generation, 1, 'the generation is kept until the new decision is made');
  assert.equal(root.decision_history.length, 1);
  assert.equal(root.decision_history[0].decision.option_id, 'raise', 'the decision it had is kept whole');
  assert.deepEqual(root.decision_history[0].reopened, { by: 'revision', step_id: 'outcome', because: becauseKiln.because, at: root.decision_history[0].reopened.at });
  assert.equal(door.value(`decision-step:${id}:001:v001`).answer.current_state, outcomeAnswer.current_state, 'the old answer is still kept');
  assert.equal(door.value(`decision-step:${id}:001`).answer.current_state, revisedOutcome.current_state);

  await assert.rejects(makeTheDecision({ decision_id: id, decision }, { door }), /Complete the guided questions/, 'the open decision is not made while a later answer waits');
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true }, { door });
  const made = await makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'keep', reason: 'Families left at the higher price' } }, { door });
  assert.equal(made.decision.option_id, 'keep');
  assert.equal(made.already_decided, undefined);
  const after = caseView(door, id);
  assert.equal(after.decision_generation, 2);
  assert.equal(after.status, 'needs_outcome');
  assert.equal(after.decision_history.length, 1, 'the decision made again does not repeat the reopened one');
  assert.equal(after.decision_history[0].decision.option_id, 'raise');
});

test('a reopened decision keeps its earlier report apart: a result given for the new decision is its own, not a repeat of the old one', async () => {
  const door = account();
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  await reportADecisionResult({ decision_id: id, result: 'met', summary: 'Twelve families signed up', answered_by: 'person' }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln, verdicts: judged }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true }, { door });
  await makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'keep', reason: 'Families left at the higher price' } }, { door });
  const met = await reportADecisionResult({ decision_id: id, result: 'met', summary: 'Twelve families signed up', answered_by: 'person' }, { door });
  assert.equal(met.repeated, undefined);
  assert.equal(met.reports, 2);
  assert.equal(met.report.decision_generation, 2);
});

test('a retried revision of a decided decision replays: it reopens once, and nothing is written twice', async () => {
  const door = account();
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln, verdicts: judged }, { door });
  door.writes.length = 0;
  const again = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln, verdicts: judged }, { door });
  assert.equal(again.replayed, true);
  assert.deepEqual(door.writes, [], 'the same revision sent again writes nothing');
  assert.equal(caseView(door, id).decision_history.length, 1, 'and reopens nothing twice');
  assert.equal(door.value(`decision-step:${id}:001:v002`), null);
});

test('a revision of a decided decision that gives the answer it already has replays, and does not reopen it', async () => {
  const door = account();
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  const same = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, revise: becauseKiln, verdicts: judged }, { door });
  assert.equal(same.replayed, true);
  assert.equal(same.decision.option_id, 'raise', 'the decision stands');
  assert.equal(caseView(door, id).decision_history, undefined);
});

test('after a failed result a revision changes the answer and the decision stands until a new one is made, as before', async () => {
  const door = account();
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  await reportADecisionResult({ decision_id: id, result: 'met', summary: 'Twelve families signed up', answered_by: 'person' }, { door });
  await reportADecisionResult({ decision_id: id, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' }, { door });
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln, verdicts: judged }, { door });
  assert.equal(reply.question.step_id, 'proof');
  assert.equal(reply.reopened, undefined, 'a failed result is not a reopen');
  assert.equal(reply.decision.option_id, 'raise', 'the decision stands until a new one is made');
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true }, { door });
  const made = await makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'keep', reason: 'Families left at the higher price' } }, { door });
  assert.equal(made.decision.option_id, 'keep');
  const root = caseView(door, id);
  assert.equal(root.decision_generation, 2);
  assert.equal(root.decision_history.length, 1);
  assert.equal(root.decision_history[0].decision.option_id, 'raise');
  assert.equal(root.decision_history[0].reopened, undefined, 'the decision kept on a failed result carries no reopen mark');
});

test('verdicts added to an answered step keep its answer: a new version with the same answer and the verdicts, who graded them and when', async () => {
  const door = account();
  const id = await answered(door);
  keptBeforeVerdicts(door, id);
  const meets = [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'second-judge-test' }];
  const added = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: meets }, { door });
  assert.deepEqual(added.confirmed, { step_id: 'outcome', version: 2, verdicts_added: ['outcome-before-after'] });
  assert.equal(added.question, null, 'the answer stands and every question is still answered');
  assert.equal(added.ready_for_decision, true);
  const step = door.value(`decision-step:${id}:001`);
  assert.equal(step.version, 2);
  assert.deepEqual(step.answer, outcomeAnswer, 'the answer did not change');
  assert.deepEqual(step.verdicts.given.map(item => [item.id, item.meets, item.graded_by]), [['outcome-before-after', true, 'second-judge-test']]);
  assert.ok(step.verdicts.given[0].added_at, 'each verdict added keeps when it came in');
  assert.ok(step.confirmed_at, 'the version says when it was confirmed');
  assert.deepEqual(door.value(`decision-step:${id}:001:v001`).verdicts, { given: [] }, 'the version it replaces is kept as it was: no verdicts');
  assert.equal(caseView(door, id).answered_steps[1].graded, 1);
  assert.equal(caseView(door, id).answered_steps[1].version, 2);

  const versions = await nextDecisionQuestion({ decision_id: id, versions_of: 'outcome' }, { door });
  assert.deepEqual(versions.versions.map(item => [item.version, item.current]), [[1, false], [2, true]]);
  assert.ok(versions.versions[1].confirmed_at, 'the history shows the confirmation');
});

test('verdicts added to a decided decision keep it decided: nothing reopens, and the decision and its history stand', async () => {
  const door = account();
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  keptBeforeVerdicts(door, id);
  const notAsked = await answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true, verdicts: [{ check: 'not-asked', meets: true, rests_on: 'e1', graded_by: 'second-judge-test' }] }, { door });
  assert.equal(notAsked.replayed, true, 'a verdict for a check the step did not ask is not taken');
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'second-judge-test' }] }, { door });
  assert.equal(reply.decision.option_id, 'raise', 'still decided');
  assert.equal(reply.reopened, undefined);
  assert.equal(reply.question, null);
  const root = caseView(door, id);
  assert.equal(root.decision.option_id, 'raise');
  assert.equal(root.status, 'needs_outcome');
  assert.equal(root.decision_generation, 1);
  assert.equal(root.decision_history, undefined, 'nothing moved to the history');
  assert.equal(door.value(`decision-step:${id}:001`).version, 2);
  assert.deepEqual(door.value(`decision-step:${id}:001`).answer, outcomeAnswer);
});

test('a verdict confirmation is replayed when sent again, refuses a grounded refusal, takes no verdict that rests on nothing, and never changes a verdict kept', async () => {
  const door = account();
  const id = await answered(door);
  keptBeforeVerdicts(door, id);
  const refused = [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'which state it should end up in', graded_by: 'second-judge-test' }];
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: refused }, { door }), /checklist\.outcome-before-after: .*which state it should end up in/);
  assert.equal(door.value(`decision-step:${id}:001`).version, 1, 'a refused confirmation writes nothing');
  const restsOnNothing = [{ check: 'outcome-before-after', meets: true, rests_on: 'nothing of this answer', graded_by: 'second-judge-test' }];
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: restsOnNothing }, { door }), /needs a second judge's verdict/, 'a verdict that rests on nothing is not taken, so the step stays ungraded and is refused, not replayed');
  const ungroundedRefusal = [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'a spreadsheet of costs', graded_by: 'second-judge-test' }];
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: ungroundedRefusal }, { door }), /needs a second judge's verdict/, 'an ungrounded refusal is ignored, and the step stays ungraded');
  const meets = [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'second-judge-test' }];
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: meets }, { door });
  door.writes.length = 0;
  assert.equal((await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: meets }, { door })).replayed, true, 'the same confirmation again replays');
  assert.deepEqual(door.writes, [], 'and writes nothing');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'another-judge' }] }, { door }), /already has a different verdict/, 'a verdict kept is never changed');
  assert.equal(door.value(`decision-step:${id}:001`).version, 2, 'and no third version appears');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: meets, answer: outcomeAnswer }, { door }), /sent alone/);
});

test('a verdict confirmation on a step flagged to be asked again takes its verdicts in its turn, clears its flag, and is refused out of turn', async () => {
  const door = account();
  const id = await answered(door);
  keptBeforeVerdicts(door, id);
  const widened = { decision_context: { worth_weighing: true, compare_existing: true }, omission_reasons: {}, evidence_refs: ['e1'] };
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: widened, revise: { because: 'A nearby class also runs this spring' } }, { door });
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true, verdicts: [] }, { door }), /waiting for its "outcome"/);
  const meets = [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'second-judge-test' }];
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: meets }, { door });
  assert.deepEqual(reply.confirmed, { step_id: 'outcome', version: 2, verdicts_added: ['outcome-before-after'] });
  assert.equal(reply.question.step_id, 'proof', 'the next question is the one still flagged');
  const root = caseView(door, id);
  assert.equal(root.answered_steps[1].needs_recheck, false);
  assert.equal(root.answered_steps[2].needs_recheck, true, 'the step after it is still to be asked again');
});

test('two evidence adds to one case at the same time both land: the case changed under the first is read again and written under a fresh key', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const [first, second] = await Promise.all([
    addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door }),
    addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e4', claim: 'The seller agreed to a trial week' }] }, { door }),
  ]);
  assert.equal(first.added.length + second.added.length, 2);
  const refs = caseView(door, id).input.evidence.map(row => row.ref);
  assert.ok(refs.includes('e3') && refs.includes('e4'), `both rows are kept: ${refs}`);
});

test('evidence added at any time is kept with when it came in, the same start still opens that decision, and an answer may cite the new evidence', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  const citing = { ...outcomeAnswer, evidence_refs: ['e1', 'e3'] };
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: citing, verdicts: judged }, { door }), /is not a ref of this case/, 'evidence not yet added cannot be cited');
  const added = await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door });
  assert.equal(added.evidence, 3);
  assert.equal(added.added.length, 1);
  assert.ok(added.added[0].added_at, 'the row keeps when it came in');
  assert.equal(caseView(door, id).input.evidence[0].added_at, undefined, 'evidence the decision started with keeps no time of its own');
  assert.equal((await startADecision(opened, { door })).case_id, id, 'the same start is still that decision after evidence is added');
  await assert.rejects(startADecision({ ...opened, goal: 'Something else entirely' }, { door }), /already has decision/);
  const again = await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door });
  assert.equal(again.replayed, true);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Something else' }] }, { door }), /its own ref/);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [] }, { door }), /from 1 to 64/);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e4' }] }, { door }), /needs a ref and either a claim/);
  const next = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: citing, verdicts: judged }, { door });
  assert.equal(next.question.step_id, 'proof');
});

test('an answer and an evidence row can be brought in from another of the person\'s decisions: copied as it stood, its evidence comes along, and checked like a typed answer', async () => {
  const door = account();
  const source = await answered(door);
  const { case_id: id } = await startADecision({ ...opened, source_id: 'chat:pottery-2', evidence: [{ ref: 'e1', claim: opened.evidence[0].claim }] }, { door });
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', from: { decision_id: id, step_id: 'scope' } }, { door }), /revise it instead/, 'a decision is not brought in from itself');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', from: { decision_id: source, step_id: 'proof' } }, { door }), /decision_context is required/, 'a copied answer is checked for the step it is put into');
  const scoped = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', from: { decision_id: source, step_id: 'scope' } }, { door });
  assert.equal(scoped.question.step_id, 'outcome');
  assert.deepEqual(door.value(`decision-step:${id}:000`).from, { decision_id: source, step_id: 'scope', version: 1 });
  assert.deepEqual(door.value(`decision-step:${id}:000`).answer, scope);
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', from: { decision_id: source, step_id: 'outcome' }, verdicts: [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'which state it should end up in', graded_by: 'second-judge-test' }] }, { door }), /which state it should end up in/, 'a copied answer meets the same verdicts as a typed one');

  const copied = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', from: { decision_id: source, step_id: 'outcome' }, verdicts: judged }, { door });
  assert.equal(copied.question.step_id, 'proof');
  const e2 = caseView(door, id).input.evidence.find(item => item.ref === 'e2');
  assert.deepEqual(e2.from, { decision_id: source, ref: 'e2' }, 'evidence the copied answer cites comes along, with where it came from');
  assert.equal(e2.claim, opened.evidence[1].claim);
  assert.deepEqual(door.value(`decision-step:${id}:001`).answer, outcomeAnswer);
  const replays = door.writes.length;
  assert.equal((await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', from: { decision_id: source, step_id: 'outcome' }, verdicts: judged }, { door })).replayed, true);
  assert.equal(door.writes.length, replays, 'the same from again replays');

  // The source changes later: the copy stays as it stood, and a copy that names no version takes the current one.
  await answerADecisionQuestion({ decision_id: source, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln, verdicts: judged }, { door });
  assert.equal(door.value(`decision-step:${id}:001`).answer.current_state, outcomeAnswer.current_state, 'the copy did not change with its source');
  const third = await startADecision({ ...opened, source_id: 'chat:pottery-3' }, { door });
  await answerADecisionQuestion({ decision_id: third.case_id, step_id: 'scope', from: { decision_id: source, step_id: 'scope' } }, { door });
  const current = await answerADecisionQuestion({ decision_id: third.case_id, step_id: 'outcome', from: { decision_id: source, step_id: 'outcome' }, verdicts: judged }, { door });
  assert.equal(current.question.step_id, 'proof');
  assert.equal(door.value(`decision-step:${third.case_id}:001`).answer.current_state, revisedOutcome.current_state);
  assert.deepEqual(door.value(`decision-step:${third.case_id}:001`).from, { decision_id: source, step_id: 'outcome', version: 2 });
  await assert.rejects(answerADecisionQuestion({ decision_id: third.case_id, step_id: 'proof', from: { decision_id: source, step_id: 'outcome', version: 9 }, verdicts: judged }, { door }), /no answer to "outcome" at version 9/);

  const bringing = await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e9', from: { decision_id: source, ref: 'e1' } }] }, { door });
  assert.deepEqual(bringing.added[0].from, { decision_id: source, ref: 'e1' });
  assert.equal(bringing.added[0].claim, opened.evidence[0].claim);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e9', from: { decision_id: source, ref: 'missing' } }] }, { door }), /no evidence missing/);
});

test('revising the scope asks again every step after it, in method order, and a step the scope now adds is asked where it falls', async () => {
  const door = account();
  const id = await answered(door);
  const widened = { decision_context: { worth_weighing: true, compare_existing: true }, omission_reasons: {}, evidence_refs: ['e1'] };
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: widened, revise: { because: 'A nearby class also runs this spring' } }, { door });
  assert.deepEqual(reply.revised.needs_recheck, ['outcome', 'proof'], 'every answer after the scope is marked');
  assert.equal(reply.question.step_id, 'outcome', 'asked again in method order');
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true }, { door });
  const second = await answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true }, { door });
  assert.equal(second.question.step_id, 'existing', 'the step the scope adds is asked after the steps before it');
  assert.deepEqual(second.question.checklist, [{ id: 'existing-where', check: plainChecks()[1].check }]);
  assert.equal((await answerADecisionQuestion({ decision_id: id, step_id: 'proof', confirm: true }, { door })).replayed, true, 'a confirmation given before replays and asks nothing again');
  const done = await answerADecisionQuestion({ decision_id: id, step_id: 'existing', answer: { found: ['a nearby class price list'], checklist: { 'existing-where': { handled: true, how: 'Looked at the price list of the nearby class', evidence_refs: ['e1'] } }, evidence_refs: ['e1'] }, verdicts: [{ check: 'existing-where', meets: true, rests_on: 'e1', graded_by: 'second-judge-test' }] }, { door });
  assert.equal(done.question, null);
  assert.equal(done.ready_for_decision, true);
});

// A root as the layout before this one wrote it: its evidence, options, results, history and cited pursuits inside it,
// its method snapshot inline, its answered steps' summaries on it and its original input kept whole.
function asOldRoot(door, id) {
  const view = caseView(door, id);
  const { counts: _counts, input_identity: _identity, method_identity: _method, ...old } = { ...view, counts: null };
  for (const key of [...door.records.keys()]) if (/^decision-(evidence|answered-step|option|candidate|report|carried-out|history|cited-pursuit):/.test(key)) door.records.delete(key);
  door.put(id, 'decision', old);
  return old;
}

test('a root written the old way still reads, and is laid apart at its next change, its root written last', async () => {
  const door = account();
  door.put('pursuit:camp', 'pursuit', { title: 'Keep the camp running', now: 'Losing money', after: 'Covering costs', status: 'active' });
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  await reportADecisionResult({ decision_id: id, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' }, { door });
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door });
  const old = asOldRoot(door, id);
  door.put(id, 'decision', { ...old, original_input: opened, cited_pursuits: { 'pursuit:camp': 'Keep the camp running: now Losing money; should be Covering costs' } });
  assert.equal(door.value(id).input.evidence.length, 3, 'the old root holds its evidence');
  assert.equal(door.value(id).answered_steps.length, 3);

  const ready = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.equal(ready.question, null, 'it reads as it is');
  assert.equal((await startADecision(opened, { door })).case_id, id, 'its original input still opens it');
  door.writes.length = 0;
  await makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'keep', evidence_refs: ['e3'] } }, { door });
  const root = door.value(id);
  assert.equal(root.input.evidence, undefined, 'its next change lays it apart');
  for (const field of ['answered_steps', 'original_input', 'reports', 'decision_history', 'cited_pursuits', 'method']) assert.equal(root[field], undefined, `${field} leaves the root`);
  assert.equal(root.counts.evidence, 3);
  assert.equal(door.value(`decision-evidence:${id}:0002`).ref, 'e3');
  assert.equal(door.value(`decision-report:${id}:0000`).result, 'failed');
  assert.equal(door.value(`decision-history:${id}:000`).decision.option_id, 'raise');
  assert.equal(door.value(`decision-cited-pursuit:${id}:0000`).ref, 'pursuit:camp');
  assert.equal(door.value(`decision-answered-step:${id}:002`).step_id, 'proof');
  assert.equal(door.value(`decision-method:${root.method_identity}`).method.id, 'plain');
  assert.deepEqual(door.writes.at(-1).ids.at(0), id, 'the root is in the last write');
  const view = caseView(door, id);
  assert.equal(view.decision.option_id, 'keep');
  assert.equal(view.decision_history.length, 1);
  assert.equal((await startADecision(opened, { door })).case_id, id, 'the identity of its original input is kept');
  await assert.rejects(startADecision({ ...opened, goal: 'Something else entirely' }, { door }), /already has decision/);
});

test('a decision of any size fits: every record and every door write stays under the 64 KiB cap, and the root does not grow', async t => {
  const door = memoryDoor();
  const base = plainMethod();
  const extra = Array.from({ length: 40 }, (_, n) => ({ id: `more-${n}`, question: `What does part ${n} of the made-up placement need?`, fields: [{ name: 'note', label: 'Note' }] }));
  const method = { ...base, id: 'big', default_for: [], about: 'A made-up method with a very long description of how it works. '.repeat(500), steps: [...base.steps, ...extra], backbone: [...base.backbone, { id: 'more', name: 'More parts', steps: extra.map(step => step.id) }] };
  door.put(`record:${settings.records.method_row}:big`, `record:${settings.records.method_row}`, method);
  const checks = Array.from({ length: 300 }, (_, n) => ({ id: `big-check-${String(n).padStart(3, '0')}`, part_of: 'big', step: 'outcome', check: `Does the answer handle point ${n} of the long made-up list of placement concerns?`, good_answer: 'Names the point and how the placement handles it, with the fact that shows it.' }));
  for (const check of checks) door.put(`record:${settings.records.check_row}:${check.id}`, `record:${settings.records.check_row}`, check);
  for (let n = 0; n < 30; n += 1) door.put(`pursuit:p${n}`, 'pursuit', { title: `Made-up pursuit ${n} with a long title for the test`, now: 'Where it stands now in plain words', after: 'Where it should end up in plain words', status: 'active' });
  const claim = n => `Made-up fact ${n}: a measured detail about the synthetic placement, its owner, its cost and its timing, written out at length so the case grows.`;
  const start = { source_id: 'chat:big', goal: 'Decide where the made-up service is placed', method: 'big', evidence: Array.from({ length: 300 }, (_, n) => ({ ref: `e${n + 1}`, claim: claim(n) })), options: opened.options };
  const { case_id: id } = await startADecision(start, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  const big = { ...outcomeAnswer, checklist: Object.fromEntries(checks.map((check, n) => [check.id, { handled: true, how: `Point ${n} is handled by the placement as fact ${n + 1} shows`, evidence_refs: [`e${(n % 200) + 1}`] }])) };
  const verdicts = checks.map(check => ({ check: check.id, meets: true, rests_on: 'e1', graded_by: 'second-judge-test' }));
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: big, verdicts }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: proofAnswer }, { door });
  const note = n => ({ note: `Part ${n} is settled by the facts`, evidence_refs: n === 0 ? ['e1', ...Array.from({ length: 30 }, (_, p) => `pursuit:p${p}`)] : ['e1'] });
  for (const step of extra) await answerADecisionQuestion({ decision_id: id, step_id: step.id, answer: note(Number(step.id.slice(5))) }, { door });
  for (let call = 0; call < 4; call += 1) {
    const evidence = Array.from({ length: 50 }, (_, n) => ({ ref: `added-${call}-${n}`, claim: claim(1000 + call * 50 + n) }));
    await addDecisionEvidence({ decision_id: id, evidence }, { door });
  }
  for (let round = 0; round < 3; round += 1) {
    await makeTheDecision({ decision_id: id, decision: { ...decision, option_id: round % 2 ? 'keep' : 'raise' } }, { door });
    for (let n = 0; n < 4; n += 1) await sayWhatWasDone({ decision_id: id, state: 'done', what_happened: `Round ${round} step ${n}: ${'what was done, in long made-up words. '.repeat(100)}` }, { door });
    await reportADecisionResult({ decision_id: id, result: 'failed', summary: `Round ${round} did not work: ${'the made-up measure was missed. '.repeat(20)}`, answered_by: 'person' }, { door });
  }
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: { ...proofAnswer, measure: 'Count the sign ups again' }, revise: { because: 'The measure changed after three failed rounds' } }, { door });
  for (const step of extra) await answerADecisionQuestion({ decision_id: id, step_id: step.id, confirm: true }, { door });
  const made = await makeTheDecision({ decision_id: id, decision: { ...decision, evidence_refs: ['e1', 'added-3-49'] } }, { door });
  assert.equal(made.decision.evidence_refs[1], 'added-3-49', 'the decision cites evidence added late');

  const view = caseView(door, id);
  assert.equal(view.input.evidence.length, 500);
  assert.equal(view.answered_steps.length, 43);
  assert.equal(view.decision_history.length, 3);
  assert.equal(view.reports.length, 3);
  assert.equal(view.carried_out.length, 12);
  assert.equal(Object.keys(view.cited_pursuits).length, 30);
  const step = await readStep(door, `decision-step:${id}:001`);
  assert.equal(step.verdicts.length, 300, 'a step with hundreds of checks keeps every verdict');
  assert.equal(step.checklist.length, 300);

  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  const mine = [...door.records.entries()].filter(([key]) => key === id || key.includes(`:${id}:`) || key.startsWith(`decision-method:${door.value(id).method_identity}`));
  const total = mine.reduce((sum, [key, kept]) => sum + bytes({ id: key, type: kept.type, value: kept.value }), 0);
  assert.ok(total > 3 * 64 * 1024, `the case is far larger than one write (${total} bytes)`);
  const largestWrite = Math.max(...door.writes.map(write => write.bytes));
  assert.ok(largestWrite <= 64 * 1024, `every door write is under the cap (largest ${largestWrite})`);
  const largestCarried = Math.max(...door.writes.map(write => write.carried));
  assert.ok(largestCarried <= 64 * 1024, `every door write is under the cap however it is carried (largest ${largestCarried})`);
  const largest = {};
  for (const [key, kept] of mine) {
    const type = key === id ? 'decision' : kept.type;
    largest[type] = Math.max(largest[type] ?? 0, bytes({ id: key, type: kept.type, value: kept.value }));
  }
  for (const [type, size] of Object.entries(largest)) assert.ok(size <= (type === 'decision' ? 4096 : settings.record_bytes), `${type} records stay small (${size})`);
  const roots = door.writes.filter(write => write.ids.includes(id)).length;
  assert.ok(roots > 50, 'the root was written at every change');

  // A reader that reads synchronously joins the same records with the same pure function: `joinDecision` over what the door
  // holds, never the door, is the decision `readDecision` returns.
  const get = (type, key) => (door.records.get(key)?.type === type ? structuredClone(door.records.get(key).value) : null);
  const stepIds = door.value(id).counts.answered_steps;
  const every = (await readDecision(door, id, extra.map(item => item.id))).guidance.map(entry => entry.step_id);
  assert.equal(every.length, stepIds);
  const synchronous = joinDecision(id, door.value(id), get, every);
  assert.deepEqual(synchronous, await readDecision(door, id, every));
  assert.equal(synchronous.input.evidence.length, 500);
  assert.equal(synchronous.guidance.every(entry => !entry.lost && entry.answer !== undefined), true);
  assert.equal(synchronous.method.id, 'big');
  t.diagnostic(`case ${total} bytes; largest write ${largestWrite}; largest record by type ${JSON.stringify(largest)}`);
});

test('an earlier decision laid apart comes back as similar with its chosen option and its result', async () => {
  const door = account();
  const first = await answered(door);
  await makeTheDecision({ decision_id: first, decision }, { door });
  await reportADecisionResult({ decision_id: first, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' }, { door });
  const { case_id: second } = await startADecision({ ...opened, source_id: 'chat:pottery-again' }, { door });
  const { similar_decisions: found } = await similarDecisions({ decision_id: second }, { door });
  assert.deepEqual(found.map(item => [item.case_id, item.decision, item.status, item.reported.length]), [[first, 'Raise the price', 'correction_needed', 1]]);
});

test('options stay on the root, bounded at start: too many or too long is refused with the limit', async () => {
  const door = account();
  const many = Array.from({ length: settings.options.most + 1 }, (_, n) => ({ id: `o${n}`, label: `Option ${n}` }));
  await assert.rejects(startADecision({ ...opened, source_id: 'chat:many', options: many }, { door }), new RegExp(`at most ${settings.options.most} options, ${settings.options.most_bytes} bytes.*group similar options`));
  const long = [{ id: 'a', label: 'A long made-up option label. '.repeat(400) }, { id: 'b', label: 'B' }];
  await assert.rejects(startADecision({ ...opened, source_id: 'chat:long', options: long }, { door }), /shorten their labels/);
  const most = Array.from({ length: settings.options.most }, (_, n) => ({ id: `o${n}`, label: `Option ${n}` }));
  const { case_id: id } = await startADecision({ ...opened, source_id: 'chat:most', options: most }, { door });
  assert.deepEqual(door.value(id).input.options, most);
});

test('a root written while options were laid apart reads them back and folds them into the root at its next change', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const root = door.value(id);
  const { options, ...input } = root.input;
  options.forEach((option, n) => door.put(`decision-option:${id}:${String(n).padStart(3, '0')}`, 'decision-option', option));
  door.put(id, 'decision', { ...root, input, counts: { ...root.counts, options: options.length } });
  const asked = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.equal(asked.question.step_id, 'outcome', 'it reads');
  const folded = door.value(id);
  assert.deepEqual(folded.input.options, opened.options, 'its options are back on the root');
  assert.equal(folded.counts.options, undefined);
  assert.equal(door.value(`decision-option:${id}:000`), null, 'and their records are removed');
  assert.equal((await startADecision(opened, { door })).case_id, id, 'the same start is still that decision');
});

test('ending decisions keeps every field they had, adds what they were, when, who and why, and deletes nothing', async () => {
  const door = memoryDoor();
  const a = 'source:camp-a', b = 'source:camp-b';
  const first = { id: a, status: 'needs_outcome', goal: 'Pick a made-up venue', decision: { option_id: 'venue-1', reason: 'It was closer.' }, carried_out: [{ state: 'done', what_happened: 'Booked it.' }], answered_steps: [{ step_id: 'scope' }] };
  const second = { id: b, status: 'invalid_source', goal: 'A made-up goal' };
  door.put(a, 'decision', first);
  door.put(b, 'decision', second);
  const count = door.records.size;
  const answer = await endDecisions({ decisions: [{ decision_id: a, because: 'No one will carry it on.' }, { decision_id: b, because: 'Its source was never valid.' }], by: 'test-agent' }, { door });
  assert.equal(answer.ended, 2);
  assert.equal(answer.not_ended, 0);
  for (const [old, because] of [[first, 'No one will carry it on.'], [second, 'Its source was never valid.']]) {
    const now = door.value(old.id);
    assert.equal(now.status, 'ended');
    assert.equal(now.previous_status, old.status);
    assert.equal(now.ended_by, 'test-agent');
    assert.equal(now.ended_because, because);
    assert.ok(!Number.isNaN(Date.parse(now.ended_at)), 'ended_at is a time');
    for (const [name, value] of Object.entries(old)) if (name !== 'status') assert.deepEqual(now[name], value, `${name} is kept`);
    assert.deepEqual(Object.keys(now).sort(), [...Object.keys(old), 'previous_status', 'ended_at', 'ended_by', 'ended_because'].sort());
  }
  assert.equal(door.writes.length, 1, 'one write');
  assert.equal(door.records.size, count, 'nothing deleted');
  const again = await endDecisions({ decisions: [{ decision_id: a, because: 'Again.' }, { decision_id: b, because: 'Again.' }], by: 'test-agent' }, { door });
  assert.deepEqual(again.decisions.map(item => item.already), [true, true]);
  assert.equal(again.ended, 2);
  assert.equal(door.writes.length, 1, 'ending again writes nothing');
});

test('a decision with a checked result or a correction to keep is never ended', async () => {
  const door = memoryDoor();
  const statuses = settings.ending.keeps_open;
  assert.deepEqual(statuses, ['outcome_verified', 'correction_needed', 'verification']);
  const kept = statuses.map((status, n) => ({ id: `source:camp-${n}`, status, goal: 'A made-up goal' }));
  for (const value of kept) door.put(value.id, 'decision', value);
  const answer = await endDecisions({ decisions: kept.map(value => ({ decision_id: value.id, because: 'Tidying.' })), by: 'test-agent' }, { door });
  assert.equal(answer.ended, 0);
  assert.equal(answer.not_ended, 3);
  for (const [n, item] of answer.decisions.entries()) {
    assert.equal(item.ended, false);
    assert.equal(item.status, statuses[n]);
    assert.deepEqual(door.value(kept[n].id), kept[n], 'unchanged');
  }
  assert.equal(door.writes.length, 0);
});

test('a decision that changed after it was read is not ended, the others are, and a missing one is not there', async () => {
  const door = memoryDoor();
  door.put('source:camp-a', 'decision', { status: 'needs_outcome', goal: 'A made-up goal' });
  door.put('source:camp-b', 'decision', { status: 'needs_outcome', goal: 'Another made-up goal' });
  const read = door.read.bind(door);
  door.read = async (type, id) => {
    const value = await read(type, id);
    if (id === 'source:camp-b') door.put(id, 'decision', { status: 'decided', goal: 'Changed by another writer' });
    return value;
  };
  const answer = await endDecisions({ decisions: [{ decision_id: 'source:camp-a', because: 'Done with it.' }, { decision_id: 'source:camp-b', because: 'Done with it.' }, { decision_id: 'source:camp-missing', because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.equal(answer.decisions[0].ended, true);
  assert.deepEqual({ ended: answer.decisions[1].ended, conflict: answer.decisions[1].conflict }, { ended: false, conflict: true });
  assert.equal(answer.decisions[2].ended, false);
  assert.equal(answer.decisions[2].reason, 'No decision has that id.');
  assert.equal(answer.ended, 1);
  assert.equal(answer.not_ended, 2);
  assert.equal(door.value('source:camp-a').status, 'ended');
  assert.deepEqual(door.value('source:camp-b'), { status: 'decided', goal: 'Changed by another writer' }, 'the other writer\'s value is kept');
});

test('ending refuses a call that is not 1 to 256 decisions, each named once with a because, by someone', async () => {
  const door = memoryDoor();
  door.put('source:camp-a', 'decision', { status: 'needs_outcome' });
  const one = { decision_id: 'source:camp-a', because: 'Done with it.' };
  const bad = [
    { decisions: Array.from({ length: 257 }, (_, n) => ({ decision_id: `source:camp-${n}`, because: 'Done.' })), by: 'test-agent' },
    { decisions: [], by: 'test-agent' },
    { decisions: [{ decision_id: 'source:camp-a' }], by: 'test-agent' },
    { decisions: [one, one], by: 'test-agent' },
    { decisions: [one] },
  ];
  for (const input of bad) await assert.rejects(endDecisions(input, { door }), /Name 1 to 256 decisions/);
  assert.equal(door.writes.length, 0);
});

// A made-up decision in the old layout: its evidence rows, its method snapshot and its answered steps inline on a root of
// about 70 KB, so the root and its `expected` cannot fit one 64 KiB door message together.
function oldLargeRoot(id) {
  const evidence = Array.from({ length: 300 }, (_, n) => ({ ref: `e${n + 1}`, claim: `Made-up fact ${n}: a synthetic detail about the camp venue, its cost and its timing, written out so the root grows.` }));
  const method = { ...plainMethod(), about: 'A made-up method with a long description, kept inline as roots once were. '.repeat(340) };
  const answered_steps = [
    { step_id: 'scope', answered_at: '2026-01-02T03:04:05.000Z', version: 1, needs_recheck: false },
    { step_id: 'outcome', answered_at: '2026-01-02T03:05:05.000Z', checks: 1, graded: 1, graded_by: 'second-judge-test', version: 1, needs_recheck: false },
  ];
  return { id, source_id: 'chat:old-large', status: 'needs_outcome', created_at: '2026-01-02T03:00:00.000Z', input: { source_id: 'chat:old-large', goal: 'Pick the made-up camp venue', options: opened.options, evidence }, method, answered_steps, decision: { option_id: 'raise', reason: 'A made-up reason' } };
}

test('a decision whose root is too large for one conditioned write is ended through its layout, beside a small one', async () => {
  const door = memoryDoor();
  const big = 'source:old-large', small = 'source:camp-small';
  const root = oldLargeRoot(big);
  const size = Buffer.byteLength(JSON.stringify(root));
  assert.ok(size > 65000 && size < 80000, `the root is about 70 KB (${size})`);
  door.put(big, 'decision', root);
  door.put(small, 'decision', { status: 'needs_outcome', goal: 'A made-up goal' });
  const answer = await endDecisions({ decisions: [{ decision_id: big, because: 'No one will carry it on.' }, { decision_id: small, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.equal(answer.ended, 2);
  assert.deepEqual(answer.decisions.map(item => [item.ended, item.laid_apart ?? false]), [[true, true], [true, false]]);
  assert.equal(answer.decisions[0].previous_status, 'needs_outcome');
  assert.ok(door.writes.every(write => write.bytes <= 64 * 1024), 'no write is over the cap');
  assert.equal(door.writes.filter(write => write.ids.includes(big)).at(-1), door.writes.findLast(write => write.ids.some(key => key === big || key.includes(`:${big}:`))), 'the root is written last');
  const view = caseView(door, big);
  assert.equal(view.status, 'ended');
  assert.equal(view.previous_status, 'needs_outcome');
  assert.equal(view.ended_by, 'test-agent');
  assert.equal(view.ended_because, 'No one will carry it on.');
  assert.equal(view.input.goal, root.input.goal);
  assert.deepEqual(view.input.evidence.map(row => row.claim), root.input.evidence.map(row => row.claim));
  assert.deepEqual(view.answered_steps.map(step => step.step_id), root.answered_steps.map(step => step.step_id));
  assert.ok(Buffer.byteLength(JSON.stringify(door.value(big))) < 4096, 'the root is laid apart');
  assert.equal(door.value(small).status, 'ended');
});

test('a large decision that changed between its two reads is not ended and nothing of it is written', async () => {
  const door = memoryDoor();
  const big = 'source:old-large';
  door.put(big, 'decision', oldLargeRoot(big));
  const read = door.read.bind(door);
  let raw = 0;
  door.read = async (type, id) => {
    if (type === 'decision' && id === big && ++raw === 3) door.put(big, 'decision', { ...oldLargeRoot(big), status: 'decided' });
    return read(type, id);
  };
  const before = door.records.size;
  const answer = await endDecisions({ decisions: [{ decision_id: big, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.deepEqual({ ended: answer.decisions[0].ended, conflict: answer.decisions[0].conflict }, { ended: false, conflict: true });
  assert.equal(answer.decisions[0].reason, settings.words.end_changed);
  assert.equal(door.writes.length, 0, 'nothing was written');
  assert.equal(door.records.size, before);
  assert.equal(door.value(big).status, 'decided', 'the other writer\'s value is kept');
});

test('a door that answers 413 for a batch of several records still ends every decision', async () => {
  const door = memoryDoor();
  const ids = ['source:camp-a', 'source:camp-b', 'source:camp-c'];
  for (const id of ids) door.put(id, 'decision', { status: 'needs_outcome', goal: `A made-up goal for ${id}` });
  const write = door.write.bind(door);
  let refused = 0;
  door.write = async (list, options) => {
    if (list.length > 1) { refused += 1; throw Object.assign(new Error('413'), { code: 'http_413' }); }
    return write(list, options);
  };
  const answer = await endDecisions({ decisions: ids.map(decision_id => ({ decision_id, because: 'Done with it.' })), by: 'test-agent' }, { door });
  assert.equal(refused, 1);
  assert.equal(answer.ended, 3);
  for (const id of ids) assert.equal(door.value(id).status, 'ended');
});

test('a single conditioned record the door still refuses as 413 is ended through its layout', async () => {
  const door = memoryDoor();
  const id = 'source:camp-a';
  door.put(id, 'decision', { status: 'needs_outcome', goal: 'A made-up goal', input: { goal: 'A made-up goal', evidence: [{ ref: 'e1', claim: 'A made-up fact' }] } });
  const write = door.write.bind(door);
  let refusedOnce = false;
  door.write = async (list, options) => {
    if (!refusedOnce && list.some(record => record.type === 'decision')) {
      refusedOnce = true;
      throw Object.assign(new Error('413'), { code: 'http_413' });
    }
    return write(list, options);
  };
  const answer = await endDecisions({ decisions: [{ decision_id: id, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.deepEqual([answer.decisions[0].ended, answer.decisions[0].laid_apart], [true, true]);
  assert.equal(caseView(door, id).status, 'ended');
  assert.deepEqual(caseView(door, id).input.evidence, [{ ref: 'e1', claim: 'A made-up fact' }]);
});

// A made-up old-layout root of the shape measured on a real account: two evidence rows inline, one of them a whole
// incoming chat message of about 67 KB (quotes, backslashes, newlines and emoji), the method snapshot inline, nothing else.
function oldRootWithHugeClaim(id) {
  const line = n => `Line ${n}: "Sure," she said \\ he typed C:\\camp\\notes — "let's book the 🏕️ venue" 🙂🎉\n\tthen: {"ok": true} ✓ café naïve 日本\n`;
  let claim = '';
  for (let n = 0; Buffer.byteLength(JSON.stringify(claim)) < 67700; n += 1) claim += line(n);
  const source_id = 'message:2026-01-02T03:04:05.000Z:0a1b2c3d4e5f60718293a4b5c6d7e8f9';
  const method = { ...plainMethod(), id: 'universal' };
  return {
    id, source_id, status: 'needs_decision', created_at: '2026-01-02T03:04:05.000Z',
    input: {
      source_id, method: 'universal',
      goal: 'Choose which made-up venue the camp books for the spring weekend, given the cost, the travel time and the rooms it has for everyone who signed up so far, and say why.',
      options: [{ id: 'lake', label: 'The made-up lake venue' }, { id: 'hill', label: 'The made-up hill venue' }],
      evidence: [{ ref: 'e1', claim }, { ref: 'e2', claim: 'A made-up fact: the lake venue answered first, and its quote came in under the budget we set.' }],
    },
    method, scratchpad: {}, checks: [], answered_steps: [], actions: [],
  };
}

test('an old-layout root whose one evidence claim is about 67 KB ends in writes that each fit the cap, losing nothing', async () => {
  const door = memoryDoor();
  const id = 'source:old-huge-claim';
  const root = oldRootWithHugeClaim(id);
  const claimBytes = Buffer.byteLength(JSON.stringify(root.input.evidence[0].claim));
  assert.ok(claimBytes > 67000 && claimBytes < 68500, `the claim is about 67 KB (${claimBytes})`);
  door.put(id, 'decision', root);
  const answer = await endDecisions({ decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' }, { door });
  assert.deepEqual([answer.ended, answer.decisions[0].laid_apart], [1, true]);
  for (const write of door.writes) assert.ok(write.bytes <= 64 * 1024 && write.carried <= 64 * 1024, `${write.key}: ${write.bytes} bytes, ${write.carried} as carried, is over the cap`);
  const view = caseView(door, id);
  assert.equal(view.status, 'ended');
  assert.equal(view.previous_status, 'needs_decision');
  assert.deepEqual(view.input.evidence, root.input.evidence, 'both claims, word for word');
  for (const field of ['goal', 'options', 'source_id', 'method']) assert.deepEqual(view.input[field], root.input[field], `input.${field}`);
  for (const field of ['source_id', 'created_at', 'scratchpad', 'checks', 'actions']) assert.deepEqual(view[field], root[field], field);
  assert.deepEqual(view.method, root.method);
  assert.ok(Buffer.byteLength(JSON.stringify(door.value(id))) < 4096, 'the root is laid apart');
});

test('a single evidence row of any size, added to a decision, is kept in writes that each fit the cap, and ends whole', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const line = n => `Row ${n}: "quoted \\ slashed" — naïve café 🏕️🙂 日本語\n\t{"nested": "\\"json\\""}\n`;
  let claim = '';
  for (let n = 0; claim.length < 250000; n += 1) claim += line(n);
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim }] }, { door });
  const answer = await endDecisions({ decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' }, { door });
  assert.equal(answer.ended, 1);
  for (const write of door.writes) assert.ok(write.bytes <= 64 * 1024 && write.carried <= 64 * 1024, `${write.key}: ${write.bytes} bytes, ${write.carried} as carried, is over the cap`);
  const view = caseView(door, id);
  assert.equal(view.status, 'ended');
  assert.deepEqual(view.input.evidence, [...opened.evidence, { ...view.input.evidence[2], ref: 'e3', claim }], 'every claim word for word');
});

test('a decision whose laid-apart write the door still refuses as 413 is answered not ended, and the others still end', async () => {
  const door = memoryDoor();
  const big = 'source:old-huge-claim', small = 'source:camp-small';
  door.put(big, 'decision', oldRootWithHugeClaim(big));
  door.put(small, 'decision', { status: 'needs_outcome', goal: 'A made-up goal' });
  const write = door.write.bind(door);
  door.write = async (list, options) => {
    if (list.some(record => record.id.includes(big))) throw Object.assign(new Error('The records door answered 413.'), { code: 'http_413' });
    return write(list, options);
  };
  const answer = await endDecisions({ decisions: [{ decision_id: big, because: 'Done with it.' }, { decision_id: small, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.deepEqual(answer.decisions.map(item => item.ended), [false, true]);
  assert.equal(answer.decisions[0].too_large, true);
  assert.equal(answer.decisions[0].reason, settings.words.end_too_large);
  assert.equal(door.value(big).status, 'needs_decision', 'the decision is as it was');
  assert.equal(door.value(small).status, 'ended');
});

// The engine keeps each request key with the input it first carried and refuses the key used again with other input.
function keyedDoor(door) {
  const seen = new Map();
  const write = door.write.bind(door);
  door.keys = seen;
  door.write = async (list, options = {}) => {
    const input = JSON.stringify(list);
    if (options.key && seen.has(options.key) && seen.get(options.key) !== input) throw Object.assign(new Error('The records changed while this tool was running.'), { code: 'original_command_conflict' });
    const answer = await write(list, options);
    if (options.key) seen.set(options.key, input);
    return answer;
  };
  return door;
}

test('a large old-layout decision whose first end failed partway is ended by the next call, under fresh keys', async () => {
  const door = keyedDoor(memoryDoor());
  const id = 'source:old-history-retry';
  door.put(id, 'decision', oldRootWithLargeField(id));
  const keyed = door.write;
  let refuseRoot = true;
  door.write = async (list, options) => {
    if (refuseRoot && list.some(record => record.id === id)) throw Object.assign(new Error('The records door answered 413.'), { code: 'http_413' });
    return keyed(list, options);
  };
  const first = await endDecisions({ decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' }, { door });
  assert.equal(first.decisions[0].ended, false);
  assert.equal(first.decisions[0].too_large, true);
  assert.equal(door.value(id).status, 'needs_outcome', 'the root is as it was');
  const firstKeys = [...door.keys.keys()];
  assert.ok(firstKeys.length > 0, 'the first call wrote some parts before the refusal');
  refuseRoot = false;
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await endDecisions({ decisions: [{ decision_id: id, because: 'Ended on the second try.' }], by: 'test-agent' }, { door });
  assert.equal(second.decisions[0].ended, true);
  assert.equal(second.decisions[0].laid_apart, true);
  assert.equal(door.value(id).status, 'ended');
  assert.equal(door.value(id).ended_because, 'Ended on the second try.');
  const secondKeys = [...door.keys.keys()].filter(key => !firstKeys.includes(key));
  assert.ok(secondKeys.length > 0 && secondKeys.every(key => key.startsWith(`end-a-decision:${id}:`)), 'the second call used fresh keys');
  assert.deepEqual((await readDecision(door, id)).method_history, oldRootWithLargeField(id).method_history);
});

test('a laid-apart end the engine refuses as a reused key answers that decision as a conflict, and the others still end', async () => {
  const door = memoryDoor();
  const big = 'source:old-history-conflict', small = 'source:camp-small-conflict';
  door.put(big, 'decision', oldRootWithLargeField(big));
  door.put(small, 'decision', { status: 'needs_outcome', goal: 'A made-up goal' });
  const write = door.write.bind(door);
  door.write = async (list, options) => {
    if (options?.key?.startsWith(`end-a-decision:${big}`)) throw Object.assign(new Error('The records changed while this tool was running.'), { code: 'original_command_conflict' });
    return write(list, options);
  };
  const answer = await endDecisions({ decisions: [{ decision_id: big, because: 'Done with it.' }, { decision_id: small, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.deepEqual(answer.decisions.map(item => item.ended), [false, true]);
  assert.equal(answer.decisions[0].conflict, true);
  assert.equal(answer.decisions[0].reason, settings.words.end_changed);
  assert.equal(door.value(big).status, 'needs_outcome');
  assert.equal(door.value(small).status, 'ended');
});

// A made-up old-layout root of the shape measured on a real account: one field, `method_history`, far larger than the
// door's cap (here about 300 KB, with quotes and characters past ASCII), beside small fields of a few hundred bytes each.
function oldRootWithLargeField(id) {
  const method_history = Array.from({ length: 1400 }, (_, n) => ({
    at: `2026-01-${String(1 + (n % 28)).padStart(2, '0')}T03:04:05.000Z`, from: n % 2 ? 'plain' : 'universal', to: n % 2 ? 'universal' : 'plain',
    because: `Made-up switch ${n}: "the camp venue" changed — café naïve 🏕️, so the method was weighed again and written out at length.`,
  }));
  const input = { source_id: 'chat:old-history', goal: 'Pick the made-up camp venue', options: opened.options, evidence: [{ ref: 'e1', claim: 'A made-up fact about the venue' }] };
  return {
    id, source_id: 'chat:old-history', status: 'needs_outcome', created_at: '2026-01-02T03:00:00.000Z',
    input, original_input: { ...input, note: 'As first given' }, method: plainMethod(), method_history,
    carried_out: [{ decision_generation: 1, state: 'done', what_happened: 'A made-up receipt', by: 'test-agent', at: '2026-01-03T03:00:00.000Z' }],
    decision: { option_id: 'raise', reason: 'A made-up reason' },
  };
}

test('an old-layout root with a 300 KB field is ended in writes that each fit the cap, and reads back the same', async () => {
  const door = memoryDoor();
  const id = 'source:old-history';
  const root = oldRootWithLargeField(id);
  const size = Buffer.byteLength(JSON.stringify(root.method_history));
  assert.ok(size > 280000 && size < 340000, `the field is about 300 KB (${size})`);
  door.put(id, 'decision', root);
  const answer = await endDecisions({ decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' }, { door });
  assert.equal(answer.decisions[0].ended, true);
  assert.equal(answer.decisions[0].previous_status, 'needs_outcome');
  assert.ok(door.writes.length > 0);
  assert.ok(door.writes.every(write => write.bytes <= 64 * 1024 && write.carried <= 64 * 1024), 'every write fits the cap, plain and as carried');
  const kept = door.value(id);
  assert.deepEqual(kept.fields_in_parts, ['method_history'], 'only the largest field is moved');
  assert.ok(Buffer.byteLength(JSON.stringify(kept)) <= settings.record_bytes, 'the root fits one record');
  for (const field of ['id', 'status', 'previous_status', 'ended_at', 'ended_by', 'ended_because', 'created_at', 'source_id', 'method_id', 'method_identity', 'input_identity', 'counts', 'decision']) assert.ok(field in kept, `${field} stays on the root`);
  const view = caseView(door, id);
  assert.deepEqual(view.method_history, root.method_history);
  assert.equal(view.fields_in_parts, undefined);
  const { original_input: _laidElsewhere, ...rest } = root;
  for (const [field, value] of Object.entries(rest)) {
    if (field === 'status') assert.equal(view.status, 'ended');
    else assert.deepEqual(view[field], value, `${field} reads back the same`);
  }
  assert.equal(view.previous_status, 'needs_outcome');
  const read = await readDecision(door, id);
  assert.deepEqual(read.method_history, root.method_history, 'readDecision puts the field back');
  assert.equal(read.fields_in_parts, undefined);
  // A list that names only some fields still sees the small ones on the root.
  const listed = [];
  for await (const row of door.list({ type: 'decision', fields: ['status', 'source_id', 'decision'] })) listed.push(row.value);
  assert.deepEqual(listed, [{ status: 'ended', source_id: root.source_id, decision: root.decision }]);
  // Its next change keeps it whole: written again, it still reads back the same.
  door.writes.length = 0;
  await writeDecision(door, recordsOf(read), `again:${id}`);
  assert.ok(door.writes.every(write => write.bytes <= 64 * 1024 && write.carried <= 64 * 1024));
  assert.deepEqual((await readDecision(door, id)).method_history, root.method_history);
});

test('a root under the bound is written as before, with no fields in parts', async () => {
  const door = memoryDoor();
  const id = 'source:old-small';
  const root = { ...oldRootWithLargeField(id), method_history: [{ at: '2026-01-02T03:04:05.000Z', from: 'plain', to: 'universal', because: 'A made-up switch' }] };
  door.put(id, 'decision', root);
  const answer = await endDecisions({ decisions: [{ decision_id: id, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.equal(answer.decisions[0].ended, true);
  const kept = door.value(id);
  assert.equal(kept.fields_in_parts, undefined);
  assert.equal(kept.root_fields_in_parts, undefined);
  assert.ok(![...door.records.keys()].some(key => key.includes(':root-fields')), 'no root-field parts are written');
  const [records] = [recordsOf(await readDecision(door, id))];
  assert.equal(records[0].value.fields_in_parts, undefined);
  assert.ok(!records.some(record => record.id.includes(':root-fields')));
});

test('an answer kept before every check had a verdict is asked again until it is graded, and no decision is made while any step is ungraded', async () => {
  const door = account();
  const id = await answered(door);
  keptBeforeVerdicts(door, id);
  const asked = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.equal(asked.question.step_id, 'outcome', 'the ungraded step is the question again');
  assert.deepEqual(asked.question.ungraded, { checks: 1, graded: 0, version: 1 });
  assert.match(asked.ungraded_note, /graded for only 0 of its 1 checks/);
  await assert.rejects(makeTheDecision({ decision_id: id, decision }, { door }), /"outcome" has verdicts for 0 of its 1 checks/);
  assert.equal(caseView(door, id).decision ?? null, null, 'nothing is decided');
  const graded = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: judged }, { door });
  assert.equal(graded.question, null, 'graded, every question is answered');
  assert.equal(graded.ready_for_decision, true);
  const made = await makeTheDecision({ decision_id: id, decision }, { door });
  assert.equal(made.decision.option_id, 'raise');
});

test('a copied answer leaves out the source decision\'s workflow runs, and the workflows due here are asked of this decision again', async () => {
  const door = account();
  const source = await answered(door);
  const key = `decision-step:${source}:001`;
  const kept = door.value(key);
  kept.answer.workflow_runs = { 'workflow:ran-in-the-source': { required_phase: 'decision', plan: 'run in the source decision' } };
  door.put(key, 'decision-step', kept);
  const { case_id: id } = await startADecision({ ...opened, source_id: 'chat:pottery-3', evidence: [{ ref: 'e1', claim: opened.evidence[0].claim }] }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  const copied = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', from: { decision_id: source, step_id: 'outcome' }, verdicts: judged }, { door });
  assert.equal(copied.question.step_id, 'proof');
  assert.equal(door.value(`decision-step:${id}:001`).answer.workflow_runs, undefined, 'the copy holds no run of the source decision');
});

test('a write made from an older read of the case is refused as changed, and nothing of it is written', async () => {
  const door = account();
  const id = await answered(door);
  const read = door.read.bind(door);
  let bumps = 0;
  door.read = async (type, key) => {
    const value = await read(type, key);
    if (type === 'decision-revision') {
      bumps += 1;
      door.put(`decision-revision:${id}`, 'decision-revision', { revision: 99 + bumps });
    }
    return value;
  };
  const added = addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e9', claim: 'A made-up fact added late' }] }, { door });
  if (CHECK_REVISION) {
    await assert.rejects(added, /case changed/);
    assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'e9'), false, 'the late evidence is not kept');
  } else {
    await added;
    assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'e9'), true, 'with the check off, the late evidence lands');
  }
});

test('a write is keyed by what it writes, so a different write under the same name is never a conflict', async () => {
  const door = memoryDoor();
  const keys = [];
  const write = door.write.bind(door);
  door.write = async (list, options) => { keys.push(options?.key); return write(list, options); };
  await writeDecision(door, [{ id: 'decision:k', type: 'decision', value: { a: 1 } }, { id: 'decision-revision:k', type: 'decision-revision', value: { revision: 1 } }], 'same-name');
  await writeDecision(door, [{ id: 'decision:k', type: 'decision', value: { a: 2 } }, { id: 'decision-revision:k', type: 'decision-revision', value: { revision: 2 } }], 'same-name');
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], 'different content under one name gets different keys');
  assert.ok(keys.every(key => key.startsWith('same-name:')));
});

test('a write too large for one message, made from an older read of the case, lands no part: the revision is claimed before the first part', async () => {
  const door = account();
  const id = await answered(door);
  const read = door.read.bind(door);
  let bumps = 0;
  door.read = async (type, key) => {
    const value = await read(type, key);
    if (type === 'decision-revision') {
      bumps += 1;
      door.put(`decision-revision:${id}`, 'decision-revision', { revision: 99 + bumps });
    }
    return value;
  };
  const before = door.writes.length;
  const added = addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e9', claim: 'A made-up fact. '.repeat(9000) }] }, { door });
  if (CHECK_REVISION) {
    await assert.rejects(added, /case changed/);
    assert.equal(door.writes.length, before, 'no write of the stale change reached the door');
    assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'e9'), false, 'the late evidence is not kept, not even in part');
  } else {
    await added;
    assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'e9'), true, 'with the check off, the late evidence lands');
  }
});

test('every decision tool declares the revision record beside its root, with the root\'s operations minus listing', () => {
  const revision = settings.records.record_revision.type;
  const declaring = rows.filter(row => (row.invoke?.records?.rights ?? []).some(item => item.kind === 'decision'));
  assert.ok(declaring.length >= 12, `the decision tools are declared: ${declaring.length}`);
  for (const row of declaring) {
    const rights = row.invoke.records.rights;
    const root = rights.find(item => item.kind === 'decision');
    const record = rights.find(item => item.kind === revision);
    assert.ok(record, `${row.id} declares ${revision}, or its read of a case is refused as not granted`);
    assert.deepEqual(record.operations, root.operations.filter(operation => operation !== 'records:list'), `${row.id} grants the revision as its root does`);
  }
});

test('a child decision names its parent, refuses a missing or its own parent, and is offered a parent\'s standing answer only for a step the method lists as standing', async () => {
  const door = account();
  const parent = await answered(door);
  const { case_id: child } = await startADecision({ ...opened, source_id: 'chat:pottery-child', parent_decision_id: parent }, { door });
  assert.equal(caseView(door, child).parent.decision_id, parent, 'the child names its parent');
  await assert.rejects(startADecision({ ...opened, source_id: 'chat:pottery-missing', parent_decision_id: 'source:not-kept' }, { door }), /No decision has that id/, 'a missing parent is refused');
  await assert.rejects(startADecision({ ...opened, source_id: 'chat:pottery-empty', parent_decision_id: '' }, { door }), /parent/i, 'an empty parent is refused');
  const record = await readDecision(door, child);
  assert.deepEqual(await inheritableFrom(door, record, { step_id: 'scope' }), { decision_id: parent, step_id: 'scope', version: 1 }, 'the scope step is standing in the DATA, so the parent\'s answer is offered');
  assert.equal(await inheritableFrom(door, record, { step_id: 'scope' }, []), null, 'no step is offered when the list names none');
  assert.equal(await inheritableFrom(door, record, { step_id: 'outcome' }, ['scope']), null, 'a step the list does not name is never offered');
});

test('a child offered its parent\'s scope takes it with from, and the next question is not scope again', async () => {
  const door = account();
  const parent = await answered(door);
  const { case_id: child } = await startADecision({ ...opened, source_id: 'chat:pottery-taken', parent_decision_id: parent }, { door });
  const offered = await nextDecisionQuestion({ decision_id: child }, { door });
  assert.equal(offered.question.step_id, 'scope', 'the child is first asked scope');
  assert.deepEqual(offered.inherit, { decision_id: parent, step_id: 'scope', version: 1 }, 'the parent\'s scope is offered beside that question');
  await answerADecisionQuestion({ decision_id: child, step_id: 'scope', from: { decision_id: parent, step_id: 'scope' } }, { door });
  const after = await nextDecisionQuestion({ decision_id: child }, { door });
  assert.notEqual(after.question?.step_id, 'scope', 'an inherited scope is not asked again');
});
