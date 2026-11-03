// The decision tools over the person's own records, with a made-up method and made-up decisions. Ported from the old
// app's run-decision, one-pass and outcome tests where they do not depend on the old store: one source opens one
// decision, a step is answered only in its turn and replays, every check is answered and the calling AI's grounded
// refusals hold, citations are the decision's own evidence or current pursuits, a decision needs every question and
// its fields, a new decision needs a failed result first, and the records keep the old store's layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addDecisionEvidence, answerADecisionQuestion, caseIdFor, makeTheDecision, nextDecisionQuestion, reportADecisionResult, sayWhatWasDone, startADecision } from '../read-data/decisions.mjs';
import { shareADecision } from '../read-data/share-a-decision.mjs';
import { readStep } from '../read-data/decision-records.mjs';
import { similarDecisions } from '../read-data/similar-decisions.mjs';
import { methodCatalogue } from '../read-data/method.mjs';
import { caseView, memoryDoor, plainChecks, plainMethod, today } from './fixtures.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
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
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: proofAnswer }, { door });
  return id;
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
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer }, { door }), /waiting for its "scope" question/);
  const scoped = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.equal(scoped.question.step_id, 'outcome');
  assert.deepEqual(scoped.method_coverage.omitted, [{ step_id: 'existing', reason: scoped.method_coverage.omitted[0].reason }]);
  assert.ok(scoped.question.checklist.some(row => row.id === 'outcome-before-after'));
  assert.equal(scoped.question.grader, settings.grader.grader, 'the calling AI is told who judges the checks');
  const again = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.equal(again.replayed, true);
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: { ...scope, evidence_refs: ['e2'] } }, { door }), /different answer/);
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer }, { door });
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
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: long }, { door });
  assert.deepEqual(door.writes.at(-1).ids, [id], 'the root alone, last');
  assert.deepEqual(door.writes.map(write => write.key), [...door.writes.slice(0, -1).map((_, at) => `answer-a-decision-question:${id}:1:part:${at}`), `answer-a-decision-question:${id}:1`]);
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
  assert.deepEqual(door.lists.filter(list => list.type === checkType), [], 'the scope question asks no checks');
  const scoped = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.deepEqual(door.lists.filter(list => list.type === checkType), [{ type: checkType, where: { step: 'outcome' } }]);
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
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: noChecks }, { door }), /Say how the answer handles each check: outcome-before-after/);
  const refused = [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'which state it should end up in', graded_by: 'second-judge-test' }];
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: refused }, { door }), /checklist\.outcome-before-after: .*which state it should end up in/);
  const ungrounded = [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'a spreadsheet of costs', graded_by: 'second-judge-test' }];
  const passed = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: ungrounded }, { door });
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
  await answerADecisionQuestion({ decision_id: other, step_id: 'outcome', answer: outcomeAnswer }, { door: unjudged });
  const [, outcome] = caseView(unjudged, other).answered_steps;
  assert.deepEqual([outcome.checks, outcome.graded], [1, 0], 'answered with no verdict: one check asked, none judged');
});

test('an answer cites only the decision\'s evidence or a current pursuit, which is copied in as it stood', async () => {
  const door = account();
  door.put('pursuit:camp', 'pursuit', { title: 'Keep the camp running', now: 'Losing money', after: 'Covering costs', status: 'active' });
  door.put('pursuit:old', 'pursuit', { title: 'An old aim', now: 'a', after: 'b', status: 'ended' });
  const { case_id: id } = await startADecision(opened, { door });
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.deepEqual(reply.pursuits.map(item => item.id), ['pursuit:camp'], 'the outcome question carries the current pursuits');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: { ...outcomeAnswer, evidence_refs: ['pursuit:old'] } }, { door }), /is not a ref of this case/);
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: { ...outcomeAnswer, evidence_refs: ['e1', 'pursuit:camp'] } }, { door });
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
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer }, { door });
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
  assert.deepEqual(door.writes.at(-1).ids, [id], 'the root is written after its parts');
});

// Every record kind a decision is laid out in (read-data/decision-records.mjs).
const decisionKinds = ['decision', 'decision-step', 'decision-call', ...Object.values(settings.records.laid_apart).map(list => list.type), settings.records.method, settings.records.part.type];

test('the tool rows reach only the decision records, the person\'s pursuits and their method lists', () => {
  const tools = ['tool:start-a-decision', 'tool:next-decision-question', 'tool:answer-a-decision-question', 'tool:add-decision-evidence', 'tool:make-the-decision', 'tool:report-a-decision-result', 'tool:say-what-was-done'];
  for (const id of tools) {
    const row = rows.find(each => each.id === id);
    assert.ok(row, `${id} has a row`);
    const rights = row.invoke.records.rights;
    for (const right of rights) assert.ok([...decisionKinds, 'pursuit', 'record:method', 'record:method-check'].includes(right.kind), `${id} reaches ${right.kind}`);
    for (const kind of decisionKinds.filter(each => each !== 'decision-call')) assert.ok(rights.some(right => right.kind === kind), `${id} reaches ${kind}, where a decision keeps its parts`);
    if (id === 'tool:add-decision-evidence') assert.ok(!rights.some(right => right.kind.startsWith('record:')), 'adding evidence reads no method rows');
    else for (const kind of ['record:method', 'record:method-check']) assert.deepEqual(rights.find(right => right.kind === kind)?.operations, ['records:list'], `${id} only lists ${kind} rows`);
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
  const asked = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer }, { door });
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
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome }, { door }), /revise\.because/, 'a different answer is not taken as it stands');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: { because: 'too short' } }, { door }), /needs revise\.because/, 'a reason of two words is too short');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: {} }, { door }), /needs revise\.because/, 'a revision with no reason is refused');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: { because: 'Costs moved again', extra: 1 } }, { door }), /revise is/, 'nothing but because and by');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'existing', answer: revisedOutcome, revise: becauseKiln }, { door }), /not asked by this decision|no answer yet/);

  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln }, { door });
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
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln }, { door });
  door.writes.length = 0;
  const again = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln }, { door });
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
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln }, { door });
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
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln }, { door });
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
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln }, { door });
  door.writes.length = 0;
  const again = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln }, { door });
  assert.equal(again.replayed, true);
  assert.deepEqual(door.writes, [], 'the same revision sent again writes nothing');
  assert.equal(caseView(door, id).decision_history.length, 1, 'and reopens nothing twice');
  assert.equal(door.value(`decision-step:${id}:001:v002`), null);
});

test('a revision of a decided decision that gives the answer it already has replays, and does not reopen it', async () => {
  const door = account();
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  const same = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, revise: becauseKiln }, { door });
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
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln }, { door });
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
  const refused = [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'which state it should end up in', graded_by: 'second-judge-test' }];
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: refused }, { door }), /checklist\.outcome-before-after: .*which state it should end up in/);
  assert.equal(door.value(`decision-step:${id}:001`).version, 1, 'a refused confirmation writes nothing');
  const restsOnNothing = [{ check: 'outcome-before-after', meets: true, rests_on: 'nothing of this answer', graded_by: 'second-judge-test' }];
  assert.equal((await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: restsOnNothing }, { door })).replayed, true, 'a verdict that rests on nothing is not taken, as a typed one is not');
  const ungroundedRefusal = [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'a spreadsheet of costs', graded_by: 'second-judge-test' }];
  assert.equal((await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: ungroundedRefusal }, { door })).replayed, true, 'an ungrounded refusal is ignored');
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

test('evidence added at any time is kept with when it came in, the same start still opens that decision, and an answer may cite the new evidence', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  const citing = { ...outcomeAnswer, evidence_refs: ['e1', 'e3'] };
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: citing }, { door }), /is not a ref of this case/, 'evidence not yet added cannot be cited');
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
  const next = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: citing }, { door });
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

  const copied = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', from: { decision_id: source, step_id: 'outcome' } }, { door });
  assert.equal(copied.question.step_id, 'proof');
  const e2 = caseView(door, id).input.evidence.find(item => item.ref === 'e2');
  assert.deepEqual(e2.from, { decision_id: source, ref: 'e2' }, 'evidence the copied answer cites comes along, with where it came from');
  assert.equal(e2.claim, opened.evidence[1].claim);
  assert.deepEqual(door.value(`decision-step:${id}:001`).answer, outcomeAnswer);
  const replays = door.writes.length;
  assert.equal((await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', from: { decision_id: source, step_id: 'outcome' } }, { door })).replayed, true);
  assert.equal(door.writes.length, replays, 'the same from again replays');

  // The source changes later: the copy stays as it stood, and a copy that names no version takes the current one.
  await answerADecisionQuestion({ decision_id: source, step_id: 'outcome', answer: revisedOutcome, revise: becauseKiln }, { door });
  assert.equal(door.value(`decision-step:${id}:001`).answer.current_state, outcomeAnswer.current_state, 'the copy did not change with its source');
  const third = await startADecision({ ...opened, source_id: 'chat:pottery-3' }, { door });
  await answerADecisionQuestion({ decision_id: third.case_id, step_id: 'scope', from: { decision_id: source, step_id: 'scope' } }, { door });
  const current = await answerADecisionQuestion({ decision_id: third.case_id, step_id: 'outcome', from: { decision_id: source, step_id: 'outcome' } }, { door });
  assert.equal(current.question.step_id, 'proof');
  assert.equal(door.value(`decision-step:${third.case_id}:001`).answer.current_state, revisedOutcome.current_state);
  assert.deepEqual(door.value(`decision-step:${third.case_id}:001`).from, { decision_id: source, step_id: 'outcome', version: 2 });
  await assert.rejects(answerADecisionQuestion({ decision_id: third.case_id, step_id: 'proof', from: { decision_id: source, step_id: 'outcome', version: 9 } }, { door }), /no answer to "outcome" at version 9/);

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
  const done = await answerADecisionQuestion({ decision_id: id, step_id: 'existing', answer: { found: ['a nearby class price list'], checklist: { 'existing-where': { handled: true, how: 'Looked at the price list of the nearby class', evidence_refs: ['e1'] } }, evidence_refs: ['e1'] } }, { door });
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
  const checks = Array.from({ length: 300 }, (_, n) => ({ id: `big-check-${String(n).padStart(3, '0')}`, method: 'big', step: 'outcome', check: `Does the answer handle point ${n} of the long made-up list of placement concerns?`, good_answer: 'Names the point and how the placement handles it, with the fact that shows it.' }));
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
  const largest = {};
  for (const [key, kept] of mine) {
    const type = key === id ? 'decision' : kept.type;
    largest[type] = Math.max(largest[type] ?? 0, bytes({ id: key, type: kept.type, value: kept.value }));
  }
  for (const [type, size] of Object.entries(largest)) assert.ok(size <= (type === 'decision' ? 4096 : settings.record_bytes), `${type} records stay small (${size})`);
  const roots = door.writes.filter(write => write.ids.includes(id)).length;
  assert.ok(roots > 50, 'the root was written at every change');
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
