// The decision tools over the person's own records, with a made-up method and made-up decisions. Ported from the old
// app's run-decision, one-pass and outcome tests where they do not depend on the old store: one source opens one
// decision, a step is answered only in its turn and replays, every check is answered and the calling AI's grounded
// refusals hold, citations are the decision's own evidence or current pursuits, a decision needs every question and
// its fields, a new decision needs a failed result first, and the records keep the old store's layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerADecisionQuestion, caseIdFor, makeTheDecision, nextDecisionQuestion, reportADecisionResult, sayWhatWasDone, startADecision } from '../read-data/decisions.mjs';
import { shareADecision } from '../read-data/share-a-decision.mjs';
import { methodCatalogue } from '../read-data/method.mjs';
import { memoryDoor, plainChecks, plainMethod, today } from './fixtures.mjs';

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
  const root = door.value(first.case_id);
  assert.deepEqual(root.answered_steps, []);
  assert.equal(root.method.id, 'plain', 'the decision keeps the method it was opened with');
  assert.equal(root.method_id, 'plain', 'and its id beside it, for lists that weigh decisions by method');
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
  assert.deepEqual(door.value(id).answered_steps.map(stub => stub.step_id), ['scope', 'outcome']);
  assert.equal(door.value(id).guidance, undefined, 'the root holds no answers itself');
});

test('a change too large for one door message is written in parts, the root last, and a step keeps each check as its id, question and row identity', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  const long = { ...outcomeAnswer, current_state: 'The old price no longer covers the kiln costs. '.repeat(1200) };
  door.writes.length = 0;
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: long }, { door });
  assert.deepEqual(door.writes.map(write => write.ids), [[`decision-step:${id}:001`], [id]], 'the step alone, then the root');
  assert.deepEqual(door.writes.map(write => write.key), [`answer-a-decision-question:${id}:1:part:0`, `answer-a-decision-question:${id}:1`]);
  const [kept] = door.value(`decision-step:${id}:001`).checklist.checks;
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

test('an answer cites only the decision\'s evidence or a current pursuit, which is copied in as it stood', async () => {
  const door = account();
  door.put('pursuit:camp', 'pursuit', { title: 'Keep the camp running', now: 'Losing money', after: 'Covering costs', status: 'active' });
  door.put('pursuit:old', 'pursuit', { title: 'An old aim', now: 'a', after: 'b', status: 'ended' });
  const { case_id: id } = await startADecision(opened, { door });
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.deepEqual(reply.pursuits.map(item => item.id), ['pursuit:camp'], 'the outcome question carries the current pursuits');
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: { ...outcomeAnswer, evidence_refs: ['pursuit:old'] } }, { door }), /is not a ref of this case/);
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: { ...outcomeAnswer, evidence_refs: ['e1', 'pursuit:camp'] } }, { door });
  assert.deepEqual(door.value(id).cited_pursuits, { 'pursuit:camp': 'Keep the camp running: now Losing money; should be Covering costs' });
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
  const root = door.value(id);
  assert.equal(root.status, 'needs_outcome');
  assert.equal(root.decision_generation, 1);
  assert.deepEqual(root.decision_usage, { model_calls: 3 });
  assert.equal((await makeTheDecision({ decision_id: id, decision }, { door })).already_decided, true);
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'keep' } }, { door }), /requires a failed result/);
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
  const root = door.value(id);
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
  const root = door.value(id);
  assert.equal(root.guidance, undefined);
  assert.equal(root.calls, undefined);
  assert.equal(root.call_count, 300);
  assert.deepEqual(root.answered_steps.map(stub => stub.step_id), ['scope', 'outcome']);
  assert.equal(door.value(`decision-step:${id}:000`).step_id, 'scope');
  assert.equal(door.value(`decision-call:${id}:000299`).route, 'guide');
  assert.equal(door.value(`decision-call:${id}:000000`).submission, undefined, 'a call keeps no payload');
  assert.deepEqual(door.writes.at(-1).ids, [id], 'the root is written after its parts');
});

test('the tool rows reach only the decision records, the person\'s pursuits and their method lists', () => {
  const tools = ['tool:start-a-decision', 'tool:next-decision-question', 'tool:answer-a-decision-question', 'tool:make-the-decision', 'tool:report-a-decision-result', 'tool:say-what-was-done'];
  for (const id of tools) {
    const row = rows.find(each => each.id === id);
    assert.ok(row, `${id} has a row`);
    const rights = row.invoke.records.rights;
    for (const right of rights) assert.ok(['decision', 'decision-step', 'decision-call', 'pursuit', 'record:method', 'record:method-check'].includes(right.kind), `${id} reaches ${right.kind}`);
    for (const kind of ['record:method', 'record:method-check']) assert.deepEqual(rights.find(right => right.kind === kind)?.operations, ['records:list'], `${id} only lists ${kind} rows`);
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
  assert.equal(door.value(id).shared, undefined, 'nothing is kept as shared before an accepted verdict for these words');
  const shared = await shareADecision({ decision_id: id, rewrite, reidentification: { accepted: true, review_binding: { input_identity: check.check.input_identity } } }, { door });
  assert.deepEqual(shared.send, { tool: settings.share.pool_tool, entry: rewrite });
  assert.equal(door.value(id).shared.review_identity, check.check.input_identity);
  const changed = await shareADecision({ decision_id: id, rewrite: { ...rewrite, why: 'Costs rose and most people still came.' } }, { door });
  assert.notEqual(changed.check.input_identity, check.check.input_identity, 'the verdict binds exactly the words it reviewed');
});

test('sharing reads only the decision and the person\'s never-publish rows, and packs the tools it imports', () => {
  const row = rows.find(each => each.id === 'tool:share-a-decision');
  const rights = row.invoke.records.rights;
  for (const right of rights) assert.ok(['decision', 'decision-step', `record:${settings.share.never_publish_row}`].includes(right.kind), right.kind);
  assert.deepEqual(rights.find(right => right.kind === `record:${settings.share.never_publish_row}`).operations, ['records:list']);
  const packed = row.invoke.files.package_files.map(item => item.package ?? item.module);
  for (const name of ['decide-with-a-method', 'learn-from-everyones-results', 'ask-a-small-model-for-a-verdict', 'content-identity', '@noble/hashes']) assert.ok(packed.includes(name), name);
});
