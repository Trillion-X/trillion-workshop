// A decision the person made themselves (tool:record-a-persons-own-decision): their own message, or a run their own
// signed-in page started, is kept as the decision with their exact words and time as its evidence, and the method's
// method is marked not walked, never answered. An AI saying the person decided is refused, and a decision
// an AI makes still needs every row of its method answered. Every name, message and decision here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTheDecision, recordAPersonsOwnDecision, reportADecisionResult, startADecision } from '../read-data/decisions.mjs';
import { decidedSummary } from '../read-data/work-screen.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { caseView, run } from './fixtures.mjs';
import { account } from './old-engine-for-tests.mjs';

const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const TOOL = 'tool:record-a-persons-own-decision';

const opened = {
  source_id: 'chat:own-verdict', goal: 'Decide whether the made-up bakery opens on Sundays',
  evidence: [{ ref: 'e1', claim: 'Sunday walk-ins were counted for four weeks' }],
  options: [{ id: 'open', label: 'Open on Sundays' }, { id: 'closed', label: 'Stay closed on Sundays' }],
};
const said = 'my verdict is go, open on Sundays, it is decided';
const MESSAGE_ID = 'message:2026-03-01T10:00:00.000Z:0123456789abcdef01234567';
const personMessage = { conversation_id: 'made-up-chat:1', app: 'Made-up chat', speaker: 'person', at: '2026-03-01T10:00:00.000Z', text: `Thanks for the counts. ${said}. Go ahead.` };
const verdict = (person, extra = {}) => ({ decision_id: null, option_id: 'open', next_action: 'Put the Sunday hours on the door sign', success_measure: 'The first four Sundays each take in more than they cost', person, ...extra });

// The decision is opened in the caller's store; `own` hands the verdict in with the records the store holds and keeps the answer.
// The verdict carries the records its call is handed (the row's input schema), so they are added to it here.
function ownVerdict(store, { verdict, origin, run: runKey }) {
  const answer = recordAPersonsOwnDecision({ verdict: { ...verdict, records: store.all() }, origin, run: runKey });
  if (answer.keep.length) store.write(answer.keep);
  return answer;
}

async function opening({ message = personMessage } = {}) {
  const door = account();
  if (message) door.put(MESSAGE_ID, 'message', message);
  const { case_id: id } = await run(door, startADecision, opened);
  return { door, id, own: input => ownVerdict(door, input) };
}

test('the person\'s own message decides: their words and time are the evidence, and the method is marked not walked', async () => {
  const { door, id, own } = await opening();
  const reply = own({ verdict: { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: id } });
  assert.equal(reply.decided_by, 'person');
  assert.equal(reply.method_walked, false);
  assert.match(reply.note, /decided this themselves \(kept_person_message, 2026-03-01T10:00:00.000Z\).*method was not walked/);
  const kept = caseView(door, id);
  assert.equal(kept.status, 'needs_outcome');
  assert.equal(kept.decided_by, 'person');
  assert.equal(kept.method_walked, false);
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
  const again = own({ verdict: { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: id } });
  assert.equal(again.already_decided, true);
  assert.equal(caseView(door, id).decision_generation, 1);
});

test('a verdict pressed on the person\'s own signed-in page is the person\'s, attested by the run\'s origin', async () => {
  const { door, id, own } = await opening({ message: null });
  const reply = own({ verdict: { ...verdict({ said: 'Open on Sundays' }), decision_id: id }, origin: 'page', run: 'page-run-1' });
  assert.equal(reply.decided_by, 'person');
  const { decision } = caseView(door, id);
  assert.equal(decision.person_source.basis, 'signed_in_person_screen');
  assert.equal(decision.person_source.source_ref, 'run:page-run-1');
});

test('an AI saying the person decided, with no message of theirs and no page run, is refused and told to walk the method', async () => {
  const { door, id, own } = await opening();
  assert.throws(() => own({ verdict: { ...verdict({ said }), decision_id: id } }), /Only the person decides without the method.*tool:make-the-decision/);
  // An AI cannot set the origin through its input: the field is not the call's, and the engine fills origin from the task.
  assert.throws(() => own({ verdict: { ...verdict({ said }), decision_id: id, origin: 'page' } }), /origin/);
  assert.throws(() => own({ verdict: { ...verdict({ said }), decision_id: id }, origin: 'ai', run: 'r1' }), /Only the person decides/);
  assert.equal(caseView(door, id).decision, null, 'nothing was decided');
});

test('a message the person did not say, or words not in it, is refused', async () => {
  const fromAnAi = await opening({ message: { ...personMessage, speaker: 'ai' } });
  assert.throws(() => fromAnAi.own({ verdict: { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: fromAnAi.id } }), /said by ai, not the person/);
  const { id, own } = await opening();
  assert.throws(() => own({ verdict: { ...verdict({ message_id: MESSAGE_ID, said: 'my verdict is no' }), decision_id: id } }), /not in message/);
  assert.throws(() => own({ verdict: { ...verdict({ message_id: 'message:none', said }), decision_id: id } }), /No message message:none/);
  assert.throws(() => own({ verdict: { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: id, option_id: 'later' } }), /later/);
});

test('a decision an AI makes still needs the method: make-the-decision refuses before every row is answered', async () => {
  const { door, id } = await opening();
  assert.throws(() => run(door, makeTheDecision, { decision_id: id, decision: { option_id: 'open', reason: said, next_action: 'Put up the sign', success_measure: 'More taken in than it costs', evidence_refs: ['e1'] } }), /Method .* rows without an answer/);
});

test('the person\'s word stands over a decision already made, which moves to the history', async () => {
  const { door, id, own } = await opening();
  own({ verdict: { ...verdict({ said: 'Stay closed' }), option_id: 'closed', decision_id: id }, origin: 'page', run: 'page-run-1' });
  own({ verdict: { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: id } });
  const kept = caseView(door, id);
  assert.equal(kept.decision.option_id, 'open');
  assert.equal(kept.decision_generation, 2);
  assert.equal(kept.decision_history.length, 1);
  assert.equal(kept.decision_history[0].decision.option_id, 'closed');
  assert.equal(kept.decision_history[0].replaced_by, 'person');
  // Its result is reported like any decision's.
  run(door, reportADecisionResult, { decision_id: id, result: 'met', summary: 'Four Sundays each took in more than they cost', answered_by: 'person' });
});

// The row as the engine runs it: its program is handed the call's input as the verdict (invoke.stdin) and its records come
// with the call. The row must reach the records the call hands in, or the decision it names is not there.
test('the row, run as the engine runs it, finds the decision from the records its call hands in and answers it as the person\'s', async () => {
  const { door, id } = await opening();
  const row = rowOf(rows, TOOL);
  const got = await answerOf(row, { ...verdict({ message_id: MESSAGE_ID, said }), decision_id: id, records: door.all() }, { task: { origin: 'sample-run' } });
  assert.equal(got.status, 0, got.error);
  assert.equal(got.result.decided_by, 'person');
  // The root is kept last, with the evidence and the revision and refs records a change of it needs.
  assert.equal(got.result.keep.at(-1).id, id);
  assert.equal(got.result.keep.at(-1).type, 'decision');
});

test('the row takes the call\'s records and the origin only from the run\'s task', () => {
  const row = rowOf(rows, TOOL);
  assert.deepEqual(row.invoke.stdin, { verdict: { fill: { from: 'input' } }, origin: { fill: { from: 'task', field: 'origin' } }, run: { fill: { from: 'task', field: 'request_key' } } });
  assert.deepEqual(row.input_schema, settings.input_schemas[TOOL]);
  assert.equal(row.input_schema.additionalProperties, false);
  assert.ok(!('origin' in row.input_schema.properties));
  assert.ok('records' in row.input_schema.properties);
});
