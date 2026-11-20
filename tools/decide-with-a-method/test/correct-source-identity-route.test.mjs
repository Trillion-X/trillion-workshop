// The correction of a message decision that targets the wrong app's chat, ported from the old engine (old codebase
// commit b6ae0ebf815f, correctSourceIdentity). The caller hands in the kept message, its source and the handoff as facts;
// the tool refuses any mismatch, rewrites only the decision, keeps the replaced one, and answers an exact repeat as already corrected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { correctSourceIdentity } from '../read-data/correct-source-identity.mjs';
import { makeTheDecision, startADecision } from '../read-data/decisions.mjs';
import { account, answerAll, seedSteps } from './old-engine-for-tests.mjs';
import { run, heldOf } from './fixtures.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import words from '../read-data/correct-source-identity.json' with { type: 'json' };

const MESSAGE = 'message:synthetic-person-1';
const SOURCE = 'chat:synthetic-app-a-1';
const HANDOFF = 'h_synthetic1';
const APPS = ['app-a', 'app-b'];
const AGENT = 'synthetic-agent';
const opened = { source_id: MESSAGE, goal: 'Continue the handoff', evidence: [{ ref: 'e1', claim: 'The person asked to continue it in the other chat' }],
  options: [{ id: 'act', label: 'Act' }, { id: 'revisit', label: 'Revisit' }] };
const facts = (over = {}) => ({
  message: { id: MESSAGE, speaker: 'person', conversation_id: SOURCE, app: 'app-a', ...over.message },
  source: { id: SOURCE, app: 'app-a', ...over.source },
  handoff: { handoff_id: HANDOFF, from_agent: AGENT, input: { arrived: { message_id: MESSAGE, source_id: SOURCE, from_person: true } }, ...over.handoff },
});
const correct = (door, decision_id, over = {}) => run(door, correctSourceIdentity, {
  decision_id, message_id: MESSAGE, source_id: SOURCE, handoff_id: HANDOFF, handoff_agent: AGENT, facts: facts(over), apps: APPS, ...over.input,
});

// A decision made with the given option and reason, its method answered the way the decisions test answers it.
async function madeDecision(door, option_id, reason) {
  const { case_id } = await run(door, startADecision, opened);
  await seedSteps(door, case_id, ['scope', 'outcome', 'proof']);
  await answerAll(door, case_id);
  await run(door, makeTheDecision, { decision_id: case_id, decision: { option_id, reason, evidence_refs: ['e1'], next_action: 'Send it on', success_measure: 'Done', move: 'Keep open' } });
  return case_id;
}

test('a message decision that names another app is corrected to its original chat, and the replaced decision is kept', async () => {
  const door = account();
  const id = await madeDecision(door, 'act', 'Send it to app-b, the other chat.');
  const fixed = await correct(door, id);
  assert.equal(fixed.already_corrected, false);
  assert.equal(fixed.decision_generation, 2);
  assert.match(fixed.decision.next_action, new RegExp(`${HANDOFF} in its original app-a chat ${SOURCE}`));
  assert.equal(fixed.decision.option_id, 'act', 'the choice stays');
  const saved = await readDecision(heldOf(door), id);
  assert.equal(saved.decision_generation, 2);
  assert.equal(saved.decision_history.at(-1).reason, words.correction_reason);
  assert.equal(saved.decision_history.at(-1).handoff_id, HANDOFF);
  assert.equal(saved.decision_history.at(-1).decision.reason, 'Send it to app-b, the other chat.', 'the replaced decision is kept');
});

test('an exact repeat of the same correction changes nothing', async () => {
  const door = account();
  const id = await madeDecision(door, 'act', 'Send it to app-b, the other chat.');
  await correct(door, id);
  const again = await correct(door, id);
  assert.equal(again.already_corrected, true);
  assert.equal(again.decision_generation, 2);
  assert.deepEqual(again.keep, []);
});

test('a mismatched message, source or handoff is refused and nothing is written', async () => {
  const door = account();
  const id = await madeDecision(door, 'act', 'Send it to app-b, the other chat.');
  const refused = [
    [{ message: { speaker: 'ai' } }, words.refuse.mismatch],
    [{ source: { app: 'app-b' } }, words.refuse.mismatch],
    [{ handoff: { from_agent: 'someone-else' } }, words.refuse.mismatch],
    [{ handoff: { input: { arrived: { message_id: 'message:other', source_id: SOURCE, from_person: true } } } }, words.refuse.mismatch],
  ];
  for (const [over, message] of refused) assert.throws(() => correct(door, id, over), new RegExp(message.replace(/[.]/g, '\\.')));
  assert.throws(() => run(door, correctSourceIdentity, { decision_id: id, message_id: MESSAGE, source_id: SOURCE, handoff_id: 'not-a-handoff', handoff_agent: AGENT, facts: facts(), apps: APPS }), new RegExp(words.refuse.unverified.replace(/[.]/g, '\\.')));
  const saved = await readDecision(heldOf(door), id);
  assert.equal(saved.decision_generation, 1);
  assert.equal(saved.decision_history, undefined);
});

test('a decision that is not an act on this message, or names no other app, is refused', async () => {
  const door = account();
  const revisit = await madeDecision(door, 'revisit', 'Send it to app-b, the other chat.');
  assert.throws(() => correct(door, revisit), new RegExp(words.refuse.not_active));
  const doorTwo = account();
  const unproven = await madeDecision(doorTwo, 'act', 'Keep it where it is.');
  assert.throws(() => correct(doorTwo, unproven), new RegExp(words.refuse.unproven));
});
