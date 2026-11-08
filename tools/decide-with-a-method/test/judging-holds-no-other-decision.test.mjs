// Ported from old trillion test/judging-holds-no-other-decision.test.mjs (tag old-trillion-before-worker-retire,
// b6ae0ebf81), deleted by Trillion-X/trillion #243. The old engine ran its check judge inside the queue every change to
// a person's decisions went through; here Trillion asks no model (the calling AI's verdicts come with the answer,
// read-data/verdicts.mjs), so what can still hold one decision behind another is the answer's own write. The first test
// holds one decision's write open at the door and starts and answers another meanwhile; a resend of the same answer is
// a replay and writes nothing (the old judge was asked once). The second sends two answers to one step at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerADecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';

const input = source_id => ({
  source_id, goal: `Choose how to answer ${source_id}.`,
  evidence: [{ ref: 'said', claim: 'The person asked for one clear answer.' }],
  options: [{ id: 'a', label: 'Answer now' }, { id: 'b', label: 'Answer later' }],
});

async function atOutcome(door, source_id) {
  const { case_id: id, question: scope } = await startADecision(input(source_id), { door });
  const { question } = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: fill(scope, { refs: ['said'] }) }, { door });
  assert.equal(question.step_id, 'outcome');
  return { id, send: { decision_id: id, step_id: 'outcome', answer: fill(question, { refs: ['said'] }), verdicts: judged(question, 'said') } };
}

test('a judge held open on one decision never holds another decision\'s start or answer', async () => {
  const door = account();
  const slow = await atOutcome(door, 'slow');
  // The slow decision's answer is held at the door until it is let go.
  let open = null;
  const held = new Promise(resolve => { open = resolve; });
  let asked = 0;
  const write = door.write.bind(door);
  door.write = async (list, options) => {
    if (list.some(record => record.id === slow.id)) { asked += 1; await held; }
    return write(list, options);
  };
  const judging = answerADecisionQuestion(slow.send, { door });
  while (!asked) await new Promise(resolve => setTimeout(resolve, 1));
  // While it is held: another decision starts and takes its scope answer, and a deadline proves none waited.
  const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error('waited behind the open judge')), 2000));
  const other = await Promise.race([atOutcome(door, 'other'), deadline]);
  assert.ok(other.id);
  open();
  const reply = await judging;
  assert.equal(reply.question.step_id, 'proof', 'the judged answer lands');
  // Sent again, the same answer is a repeat: it is not judged or kept twice.
  const writes = door.writes.length;
  const again = await answerADecisionQuestion(slow.send, { door });
  assert.equal(again.question.step_id, 'proof');
  assert.equal(again.replayed, true);
  assert.equal(asked, 1);
  assert.equal(door.writes.length, writes, 'a repeat writes nothing');
});

test('two answers to one step judged at once keep the first and refuse the second', async () => {
  const door = account();
  const { send } = await atOutcome(door, 'race');
  const other = { ...send, answer: { ...send.answer, desired_result: `${send.answer.desired_result} Said another way.` } };
  const [first, second] = await Promise.allSettled([answerADecisionQuestion(send, { door }), answerADecisionQuestion(other, { door })]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.match(second.reason.message, /different answer/);
});
