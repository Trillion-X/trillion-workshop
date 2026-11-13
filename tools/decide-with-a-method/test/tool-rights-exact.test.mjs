// Each decision tool row runs its step of one decision with exactly the rights its row declares (records.rights), over the
// same records the stand-in keeps. Every record kind a call reads, lists or writes must be granted to the row making the
// call, so a kind a write path needs but no row grants (decision-refs, when the layout names it) fails here, not live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addDecisionEvidence, answerADecisionQuestion, endDecisions, makeTheDecision, nextDecisionQuestion, reportADecisionResult, sayWhatWasDone, startADecision } from '../read-data/decisions.mjs';
import { memoryDoor, plainChecks, plainMethod, today } from './fixtures.mjs';
import { readDecision } from '../read-data/decision-records.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);
const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));

// The door as the row's container gives it: a read, list or write of a kind the row does not declare for that operation is refused as not granted.
function granted(door, toolId) {
  const row = rows.find(each => each.id === toolId);
  assert.ok(row, `${toolId} has a row`);
  const rights = new Map((row.invoke?.records?.rights ?? []).map(item => [item.kind, new Set(item.operations)]));
  const need = (kind, operation) => {
    if (!rights.get(kind)?.has(operation)) throw Object.assign(new Error(`${toolId} is not granted ${operation} on ${kind}`), { code: 'not_granted' });
  };
  return {
    read: async (type, id) => { need(type, 'records:read'); return door.read(type, id); },
    async *list(input) { need(input.type, 'records:list'); yield* door.list(input); },
    write: async (list, options) => { for (const record of list) need(record.type, 'records:write'); return door.write(list, options); },
  };
}

function account() {
  const door = memoryDoor();
  door.put(`record:${settings.records.method_row}:plain`, `record:${settings.records.method_row}`, plainMethod());
  for (const check of plainChecks()) door.put(`record:${settings.records.check_row}:${check.id}`, `record:${settings.records.check_row}`, check);
  return door;
}

const opened = {
  source_id: 'chat:rights-exact', goal: 'Decide the rights-exact camp price',
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
const judged = [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'second-judge-test' }];
const proofAnswer = { check_by: today(), measure: 'Count the spring sign ups', evidence_refs: ['e1'] };
const decision = { option_id: 'raise', reason: 'Kiln costs went up and families still came', next_action: 'Email the families the new price', success_measure: 'Twelve sign ups by May', evidence_refs: ['e1', 'e2'], who_it_changes: 'The twelve families pay a little more and keep their camp' };

test('each decision tool, run with exactly its declared rights, takes its step of a decision laid out in its parts', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door: granted(door, 'tool:start-a-decision') });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door: granted(door, 'tool:answer-a-decision-question') });
  assert.equal((await nextDecisionQuestion({ decision_id: id }, { door: granted(door, 'tool:next-decision-question') })).question.step_id, 'outcome');
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door: granted(door, 'tool:answer-a-decision-question') });
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: proofAnswer }, { door: granted(door, 'tool:answer-a-decision-question') });
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Families asked about the price in April' }] }, { door: granted(door, 'tool:add-decision-evidence') });
  await makeTheDecision({ decision_id: id, decision: { ...decision, evidence_refs: ['e1', 'e2', 'e3'] } }, { door: granted(door, 'tool:make-the-decision') });
  await reportADecisionResult({ decision_id: id, result: 'met', summary: 'Twelve families signed up', answered_by: 'person' }, { door: granted(door, 'tool:report-a-decision-result') });
  await sayWhatWasDone({ decision_id: id, state: 'done', what_happened: 'The new price went out to the families' }, { door: granted(door, 'tool:say-what-was-done') });
  await endDecisions({ decisions: [{ decision_id: id, because: 'The decision is carried out' }], by: 'calling-ai' }, { door: granted(door, 'tool:end-a-decision') });
});

test('a large row, a revision and a reopened decision are kept under each tool\'s own rights', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door: granted(door, 'tool:start-a-decision') });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door: granted(door, 'tool:answer-a-decision-question') });
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door: granted(door, 'tool:answer-a-decision-question') });
  await answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: proofAnswer }, { door: granted(door, 'tool:answer-a-decision-question') });
  // A claim over record_bytes is kept in parts of decision-part, so the add row must be granted that kind too.
  const big = 'A made-up fact about the spring camp. '.repeat(1500);
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: big }] }, { door: granted(door, 'tool:add-decision-evidence') });
  await makeTheDecision({ decision_id: id, decision: { ...decision, evidence_refs: ['e1', 'e2', 'e3'] } }, { door: granted(door, 'tool:make-the-decision') });
  // A revision of a decided decision reopens it: the decision it had moves to decision_history, under the answer row's rights.
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: { ...outcomeAnswer, desired_result: 'The kiln is paid for by the camp price' }, revise: { because: 'The kiln quote changed after the price was set' }, verdicts: judged }, { door: granted(door, 'tool:answer-a-decision-question') });
  const kept = await readDecision(door, id, ['outcome']);
  assert.equal(kept.decision_history.length, 1, 'the earlier decision is kept in its history');
  assert.equal(kept.input.evidence.find(item => item.ref === 'e3').claim, big, 'the large row reads back whole');
  assert.ok(kept.guidance.find(item => item.step_id === 'outcome').version >= 2, 'the revision is a new version');
});

test('a read-only row is refused as not granted a write that names the refs record', async () => {
  const door = account();
  await startADecision(opened, { door: granted(door, 'tool:start-a-decision') });
  const reader = granted(door, 'tool:see-my-decisions');
  const refs = settings.records.refs ?? 'decision-refs';
  await assert.rejects(reader.write([{ id: `${refs}:probe`, type: refs, value: {} }], { key: 'probe' }), /not granted records:write on decision-refs/);
});
