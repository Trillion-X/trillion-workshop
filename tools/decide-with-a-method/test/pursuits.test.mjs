// Ported from old trillion test/pursuits.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. DecisionEngine.recordPursuits and pursuits (src/engine.mjs) are do-work/
// answer-the-pursuits-page.mjs `pursuitsOf` over the records door; an answer or the decision cites one by its id (method-rows/answers.mjs `citable`, decisions.mjs `keepCited`); engine.summaries is tool:see-my-decisions; "a second
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
import { makeTheDecision, startADecision } from '../read-data/decisions.mjs';
import { recordMethodAnswers } from '../method-rows/answers.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { seeMyDecisions } from '../read-data/work-screen.mjs';
import { account, answerAll } from './old-engine-for-tests.mjs';
import { METHOD_VIEW, STEP_ROW } from './fixtures.mjs';

test('pursuits are kept beside decisions, are cited by an answer and by the decision, and one dropped is ended, not erased', async () => {
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
  // An answer, and the decision, may cite a current pursuit by its id; the decision keeps the pursuit's words as they stood.
  const answer = refs => ({ row: STEP_ROW('scope'), answer: 'Hungry, mid-cut, and fed without costing the cut.', evidence_refs: refs });
  const refused = await recordMethodAnswers({ decision_id: record.case_id, method: METHOD_VIEW, answers: [answer(['pursuit:not-recorded'])] }, { door });
  assert.match(refused.refused[0].why, /pursuit:not-recorded/);
  const kept = await recordMethodAnswers({ decision_id: record.case_id, method: METHOD_VIEW, answers: [answer(['person:words', 'pursuit:lean-and-strong'])] }, { door });
  assert.equal(kept.recorded.length, 1);
  await answerAll(door, record.case_id, { ref: 'person:words' });
  const decision = { option_id: 'fruit', reason: 'Fed without costing the cut.', next_action: 'Eat an apple', success_measure: 'Not hungry in an hour', evidence_refs: ['person:words', 'pursuit:lean-and-strong'] };
  await makeTheDecision({ decision_id: record.case_id, decision }, { door });
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
