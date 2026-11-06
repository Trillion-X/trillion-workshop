// Ported from old trillion test/person-answers.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The old test drove the MCP tools (start_decision, answer_question) of the retired service
// through test/in-process-mcp.mjs; here they are this tool's tool:start-a-decision and tool:answer-a-decision-question
// over the in-memory door, with a made-up method whose alignment step names three fields only the person can answer
// (`answered_by: "person"`, read-data/method.mjs ask_others), as the universal method's alignment step did.
// Left out, no running owner: the service asking the person directly through an MCP elicitation form (in-process-mcp
// `elicitation`/`answerForm`, the "limited time" message): Trillion asks no one here, the calling AI relays the question
// (method.mjs: "Anyone other than the calling AI is asked directly, or the AI relays the exact question"); searched the
// three repos for elicitation and answerForm in decision code: none. So the first test relays the person's words with
// answered_by, the road the second test's relayed answer takes. Two one-word answers ("Probably", "Yes") have a word
// added so they meet the made-up method's two-word minimum (answer_rules.field_min_words) and only the person rule is tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerADecisionQuestion, nextDecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { plainChecks, plainMethod } from './fixtures.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';

function alignedMethod() {
  const method = plainMethod();
  method.steps.splice(2, 0, { id: 'alignment', question: 'Is this aligned with who the person is?', fields: [
    { name: 'truth_aligned', label: 'What is true about it' },
    { name: 'who_they_are', label: 'Who they are', answered_by: 'person', ask: 'Who are you, in a few words?' },
    { name: 'worth_pursuing', label: 'Worth pursuing', answered_by: 'person', ask: 'Is this worth your limited time?' },
    { name: 'fuel', label: 'What fuels it', answered_by: 'person', ask: 'What keeps you going at it?' },
    { name: 'stop_reason', label: 'When to stop' },
  ] });
  method.backbone[0].steps.push('alignment');
  return method;
}
const door = () => account({ method: alignedMethod(), checks: [...plainChecks(), { id: 'alignment-own-words', part_of: 'plain', step: 'alignment', check: 'Are the person\'s answers in their own words?', good_answer: 'Quotes the person.' }] });

// Every check the current step carries, answered the way a careful caller would, with the judge's verdicts.
async function handled(ai, caseId) {
  const { question } = await nextDecisionQuestion({ decision_id: caseId }, { door: ai });
  return question?.checklist ? { checklist: fill(question, { refs: ['video:1'] }).checklist } : {};
}
const verdictsAt = async (ai, caseId) => judged((await nextDecisionQuestion({ decision_id: caseId }, { door: ai })).question, 'video:1');

async function walkToAlignment(ai, sourceId) {
  const start = await startADecision({ source_id: sourceId, goal: 'Pick the next training focus', evidence: [{ ref: 'video:1', claim: 'Lost long rallies' }], options: [{ id: 'a', label: 'Footwork' }, { id: 'b', label: 'Fitness' }] }, { door: ai });
  const caseId = start.case_id;
  assert.ok(start.question.answer_schema.required.includes('decision_context'), 'the reply carries the answer shape');
  await answerADecisionQuestion({ decision_id: caseId, step_id: 'scope', answer: fill(start.question, { refs: ['video:1'] }) }, { door: ai });
  const outcome = await answerADecisionQuestion({ decision_id: caseId, step_id: 'outcome', answer: { desired_result: 'Win long rallies', current_state: 'Loses them often', ...(await handled(ai, caseId)), evidence_refs: ['video:1'] }, verdicts: await verdictsAt(ai, caseId) }, { door: ai });
  assert.deepEqual(outcome.question.ask_others.map(item => item.field), ['who_they_are', 'worth_pursuing', 'fuel']);
  return caseId;
}
const send = async (ai, caseId, answer) => answerADecisionQuestion({ decision_id: caseId, step_id: 'alignment', answer: { ...answer, ...(await handled(ai, caseId)), evidence_refs: ['video:1'] }, verdicts: await verdictsAt(ai, caseId) }, { door: ai });

test('a question only the person can answer is asked to the person, and the saved answer says who answered', async () => {
  const ai = door();
  const caseId = await walkToAlignment(ai, 'person-direct');
  const { question } = await nextDecisionQuestion({ decision_id: caseId }, { door: ai });
  assert.match(question.ask_others.find(item => item.field === 'worth_pursuing').ask, /limited time/);
  const person = { worth_pursuing: 'Yes, the season starts soon', who_they_are: 'Fast feet, wants a ranking, loves match play', fuel: 'I love competing' };
  await send(ai, caseId, { truth_aligned: 'She wants to win', stop_reason: 'Winning is wanted however it happens', ...person, answered_by: { worth_pursuing: 'person', who_they_are: 'person', fuel: 'person' } });
  const saved = await readDecision(ai, caseId, ['alignment']);
  const alignment = saved.guidance.find(item => item.step_id === 'alignment').answer;
  assert.equal(alignment.fuel, 'I love competing');
  assert.equal(alignment.answered_by.fuel, 'person');
});

test('without direct asking, the AI is told the exact question to relay and cannot skip it', async () => {
  const ai = door();
  const caseId = await walkToAlignment(ai, 'person-relayed');
  await assert.rejects(send(ai, caseId, { truth_aligned: 'She wants it', worth_pursuing: 'I think so', who_they_are: 'Likes sport', fuel: 'Probably likes it', stop_reason: 'Winning matters here' }), error => {
    assert.match(error.message, /about the person the decision belongs to/);
    assert.match(error.message, /what you already know about this person/);
    return true;
  });
  await send(ai, caseId, { truth_aligned: 'She wants it', worth_pursuing: 'Yes, it is', who_they_are: 'Fast feet, wants a ranking', fuel: 'Loves it', stop_reason: 'Winning matters here', answered_by: { worth_pursuing: 'person', who_they_are: 'person', fuel: 'person' } });
});

test('an answer the AI already knows about the person is taken with its source, and the person is not asked', async () => {
  const ai = door();
  const caseId = await walkToAlignment(ai, 'known-from-memory');
  const reply = await send(ai, caseId, { truth_aligned: 'She wants it', worth_pursuing: 'Yes: they have trained for this match for a month', who_they_are: 'Quick feet, aiming for a regional ranking, loves long rallies', fuel: 'Plays five days a week', stop_reason: 'Winning matters here', answered_by: { worth_pursuing: 'memory: training notes from last month', who_they_are: 'memory: what they said about their game', fuel: 'file: practice log' } });
  assert.equal(reply.question.step_id, 'proof');
});
