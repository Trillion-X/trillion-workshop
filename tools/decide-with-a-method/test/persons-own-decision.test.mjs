// A decision the person made themselves (tool:record-a-persons-own-decision): their own message, or a run their own
// signed-in page started, is kept as the decision with their exact words and time as its evidence, and the method's
// steps are named as decided by the person, never answered. An AI saying the person decided is refused, and a decision
// an AI makes still walks the method. Every name, message and decision here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTheDecision, recordAPersonsOwnDecision, reportADecisionResult, startADecision } from '../read-data/decisions.mjs';
import { decidedSummary } from '../read-data/work-screen.mjs';
import { caseView, memoryDoor, plainChecks, plainMethod } from './fixtures.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);
const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const TOOL = 'tool:record-a-persons-own-decision';

// The door as the row's container gives it: a kind the row does not declare for an operation is refused.
function granted(door, toolId) {
  const row = rows.find(each => each.id === toolId);
  const rights = new Map((row.invoke?.records?.rights ?? []).map(item => [item.kind, new Set(item.operations)]));
  const need = (kind, operation) => { if (!rights.get(kind)?.has(operation)) throw new Error(`${toolId} is not granted ${operation} on ${kind}`); };
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
  source_id: 'chat:own-verdict', goal: 'Decide whether the made-up bakery opens on Sundays',
  evidence: [{ ref: 'e1', claim: 'Sunday walk-ins were counted for four weeks' }],
  options: [{ id: 'open', label: 'Open on Sundays' }, { id: 'closed', label: 'Stay closed on Sundays' }],
};
const said = 'my verdict is go, open on Sundays, it is decided';
const MESSAGE_ID = 'message:2026-03-01T10:00:00.000Z:0123456789abcdef01234567';
const personMessage = { conversation_id: 'made-up-chat:1', app: 'Made-up chat', speaker: 'person', at: '2026-03-01T10:00:00.000Z', text: `Thanks for the counts. ${said}. Go ahead.` };
const verdict = (person, extra = {}) => ({ decision_id: null, option_id: 'open', next_action: 'Put the Sunday hours on the door sign', success_measure: 'The first four Sundays each take in more than they cost', person, ...extra });

async function opening({ message = personMessage } = {}) {
  const door = account();
  if (message) door.put(MESSAGE_ID, 'message', message);
  const { case_id: id } = await startADecision(opened, { door: granted(door, 'tool:start-a-decision') });
  return { door, id, run: input => recordAPersonsOwnDecision(input, { door: granted(door, TOOL) }) };
}

test('the person\'s own message decides: their words and time are the evidence, and the method is marked not walked', async () => {
  const { door, id, run } = await opening();
  const reply = await run({ verdict: { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: id } });
  assert.equal(reply.decided_by, 'person');
  assert.equal(reply.method_walked, false);
  assert.deepEqual(reply.steps_decided_by_the_person, plainMethod().steps.map(step => step.id));
  assert.match(reply.note, /decided this themselves \(kept_person_message, 2026-03-01T10:00:00.000Z\).*method was not walked \(4 steps marked decided by the person\)/);
  const kept = caseView(door, id);
  assert.equal(kept.status, 'needs_outcome');
  assert.equal(kept.decided_by, 'person');
  assert.equal(kept.method_walked, false);
  assert.deepEqual(kept.steps_decided_by_the_person, ['scope', 'outcome', 'proof', 'existing']);
  assert.deepEqual(kept.answered_steps, [], 'no step is written as answered');
  assert.equal(kept.decision.option_id, 'open');
  assert.equal(kept.decision.reason, said);
  assert.deepEqual(kept.decision.evidence_refs, ['person-verdict-1']);
  assert.deepEqual(kept.decision.person_source, { basis: 'kept_person_message', source_ref: MESSAGE_ID, said, at: personMessage.at });
  const evidence = kept.input.evidence.find(item => item.ref === 'person-verdict-1');
  assert.equal(evidence.claim, said);
  assert.equal(evidence.person_source.source_ref, MESSAGE_ID);
  assert.deepEqual(decidedSummary(kept), { decided: true, decided_at: kept.decided_at, carried_out: false, decided_by: 'person', method_walked: false });
  // The same verdict again is that decision.
  const again = await run({ verdict: { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: id } });
  assert.equal(again.already_decided, true);
  assert.equal(caseView(door, id).decision_generation, 1);
});

test('a verdict pressed on the person\'s own signed-in page is the person\'s, attested by the run\'s origin', async () => {
  const { door, id, run } = await opening({ message: null });
  const reply = await run({ verdict: { ...verdict({ said: 'Open on Sundays' }), decision_id: id }, origin: 'page', run: 'page-run-1' });
  assert.equal(reply.decided_by, 'person');
  const { decision } = caseView(door, id);
  assert.equal(decision.person_source.basis, 'signed_in_person_screen');
  assert.equal(decision.person_source.source_ref, 'run:page-run-1');
});

test('an AI saying the person decided, with no message of theirs and no page run, is refused and told to walk the method', async () => {
  const { door, id, run } = await opening();
  await assert.rejects(run({ verdict: { ...verdict({ said }), decision_id: id } }), /Only the person decides without the method.*tool:next-decision-question.*tool:make-the-decision/);
  // An AI cannot set the origin through its input: the field is not the call's, and the engine fills origin from the task.
  await assert.rejects(run({ verdict: { ...verdict({ said }), decision_id: id, origin: 'page' } }), /origin/);
  await assert.rejects(run({ verdict: { ...verdict({ said }), decision_id: id }, origin: 'ai' , run: 'r1' }), /Only the person decides/);
  assert.equal(caseView(door, id).decision, null, 'nothing was decided');
});

test('a message the person did not say, or words not in it, is refused', async () => {
  const fromAnAi = await opening({ message: { ...personMessage, speaker: 'ai' } });
  await assert.rejects(fromAnAi.run({ verdict: { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: fromAnAi.id } }), /said by ai, not the person/);
  const { id, run } = await opening();
  await assert.rejects(run({ verdict: { ...verdict({ message_id: MESSAGE_ID, said: 'my verdict is no' }), decision_id: id } }), /not in message/);
  await assert.rejects(run({ verdict: { ...verdict({ message_id: 'message:none', said }), decision_id: id } }), /No message message:none/);
  await assert.rejects(run({ verdict: { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: id, option_id: 'later' } }), /later/);
});

test('a decision an AI makes still needs the method: make-the-decision refuses before the questions are answered', async () => {
  const { door, id } = await opening();
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { option_id: 'open', reason: said, next_action: 'Put up the sign', success_measure: 'More taken in than it costs', evidence_refs: ['e1'] } },
    { door: granted(door, 'tool:make-the-decision') }), /Complete the guided questions before deciding/);
});

test('the person\'s word stands over a decision already made, which moves to the history', async () => {
  const { door, id, run } = await opening();
  await run({ verdict: { ...verdict({ said: 'Stay closed' }), option_id: 'closed', decision_id: id }, origin: 'page', run: 'page-run-1' });
  await run({ verdict: { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: id } });
  const kept = caseView(door, id);
  assert.equal(kept.decision.option_id, 'open');
  assert.equal(kept.decision_generation, 2);
  assert.equal(kept.decision_history.length, 1);
  assert.equal(kept.decision_history[0].decision.option_id, 'closed');
  assert.equal(kept.decision_history[0].replaced_by, 'person');
  // Its result is reported like any decision's.
  await reportADecisionResult({ decision_id: id, result: 'met', summary: 'Four Sundays each took in more than they cost', answered_by: 'person' }, { door: granted(door, 'tool:report-a-decision-result') });
});

test('the row fills the call\'s input as the verdict and the origin only from the run\'s task', () => {
  const row = rows.find(each => each.id === TOOL);
  assert.deepEqual(row.invoke.stdin, { verdict: { fill: { from: 'input' } }, origin: { fill: { from: 'task', field: 'origin' } }, run: { fill: { from: 'task', field: 'request_key' } } });
  assert.deepEqual(row.input_schema, settings.input_schemas[TOOL]);
  assert.equal(row.input_schema.additionalProperties, false);
  assert.ok(!('origin' in row.input_schema.properties));
  assert.deepEqual(row.invoke.records.rights.find(item => item.kind === 'message').operations, ['records:read']);
});
