// Ported from old trillion test/pursuits.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. DecisionEngine.recordPursuits and pursuits (src/engine.mjs) are do-work/
// answer-the-pursuits-page.mjs `pursuitsOf` over the records door; the change question carrying them is
// tool:answer-a-decision-question (decisions.mjs pursuitsFor); engine.summaries is tool:see-my-decisions; "a second
// engine over the same file" is a second reader over the same door.
// Left out: the record log's earlier values of each pursuit (eeaf.valuesAt): the history of a record is the account's
// record store's (trillion-rust), which no door read here returns; the ended pursuit is still asserted kept with its
// status ended, not erased. And the second test (pursuits read in bounded pages, offset/limit/next_offset, old
// src/pursuit-rooms.mjs handlePursuitRoomRequest): no running owner pages pursuits (searched the three repos for
// handlePursuitRoomRequest, pursuit-rooms and next_offset beside pursuits: only answer-the-pursuits-page.mjs, which
// answers GET /pursuits whole, and records-door's own paging of any list).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pursuitsOf } from '../do-work/answer-the-pursuits-page.mjs';
import { answerADecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { seeMyDecisions } from '../read-data/work-screen.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';

test('pursuits are kept beside decisions, travel with the change question, and one dropped is ended, not erased', async () => {
  const door = account();
  const engine = pursuitsOf(door);
  await assert.rejects(engine.recordPursuits([{ title: 'No after', now: 'x' }]), /where it should get to/);
  await assert.rejects(engine.recordPursuits([{ title: 'All his files in the cloud', now: 'On a drive', after: 'In the cloud' }]), /write its title to the person/);
  await assert.rejects(engine.recordPursuits([{ title: 'Your files in the cloud', now: 'On a drive', after: 'Her agents reach them' }]), /write its after to the person/);
  await engine.recordPursuits([
    { title: 'Lean and strong', now: '11% body fat', after: '5 to 7% body fat', why_it_matters: 'Energy for everything else' },
    { title: 'Pottery school', now: 'Two paying students', after: 'A school that pays the rent' },
  ]);
  const record = await startADecision({
    source_id: 'snack-3', goal: 'Pick a late snack',
    evidence: [{ ref: 'person:words', claim: 'Wants something to eat.' }],
    options: [{ id: 'fruit', label: 'Fruit' }, { id: 'skip', label: 'Skip' }],
  }, { door });
  const next = await answerADecisionQuestion({ decision_id: record.case_id, step_id: 'scope', answer: fill(record.question, { refs: ['person:words'] }) }, { door });
  assert.equal(next.question.step_id, 'outcome');
  assert.deepEqual(next.pursuits.map(item => item.title), ['Lean and strong', 'Pottery school']);
  assert.equal(next.pursuits[0].id, 'pursuit:lean-and-strong');
  // An answer may cite a current pursuit by its id, and the decision keeps the pursuit's words as they stood.
  const outcome = refs => ({ ...fill(next.question, { refs: ['person:words'] }), evidence_refs: refs, current_state: 'Hungry, mid-cut.', desired_result: 'Fed without costing the cut.' });
  const verdicts = judged(next.question, 'person:words');
  await assert.rejects(answerADecisionQuestion({ decision_id: record.case_id, step_id: 'outcome', answer: outcome(['pursuit:not-recorded']), verdicts }, { door }), /cite case evidence/);
  await answerADecisionQuestion({ decision_id: record.case_id, step_id: 'outcome', answer: outcome(['person:words', 'pursuit:lean-and-strong']), verdicts }, { door });
  assert.equal((await readDecision(door, record.case_id)).cited_pursuits['pursuit:lean-and-strong'], 'Lean and strong: now 11% body fat; should be 5 to 7% body fat');
  assert.deepEqual((await seeMyDecisions({}, { door })).summaries[0].pursuits, [{ id: 'pursuit:lean-and-strong', title: 'Lean and strong' }]);
  // A second reader over the same records reads them back, apart from the decisions.
  const again = pursuitsOf(door);
  assert.equal((await seeMyDecisions({}, { door })).summaries.length, 1);
  // One AI updating one pursuit, by the id list_pursuits gave it, never ends the others.
  await again.recordPursuits([{ id: 'pursuit:lean-and-strong', title: 'Lean and strong', now: '10.5% body fat', after: '5 to 7% body fat' }]);
  assert.deepEqual((await again.pursuits()).map(item => [item.id, item.now]), [['pursuit:lean-and-strong', '10.5% body fat'], ['pursuit:pottery-school', 'Two paying students']]);
  // The whole list, with replace_all, ends every pursuit left out.
  await again.recordPursuits([{ title: 'Lean and strong', now: '10% body fat', after: '5 to 7% body fat' }], { replace_all: true });
  assert.deepEqual((await again.pursuits()).map(item => [item.title, item.now]), [['Lean and strong', '10% body fat']]);
  // The dropped pursuit is kept, its status ended.
  assert.equal(door.value('pursuit:pottery-school').status, 'ended');
  assert.equal(door.value('pursuit:lean-and-strong').now, '10% body fat');
});
