// A scope switch turned off is a claim about the case ("people never read these words"), so its reason is graded by a
// second judge like any check: when the method rows say how (`answer_rules.switch_reason`, or a switch's own
// `reason_check`), a scope answer that turns a switch off is kept only with a verdict on that reason, the verdict rests on
// the case's own evidence (never only on the reason's own words), and a reason the judge finds wrong is refused. A method
// whose rows say nothing about switch reasons is answered as before. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerADecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { plainChecks, plainMethod, memoryDoor } from './fixtures.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));

const SWITCH_REASON = {
  check: 'Do the records of this case show the switch is off: {question}',
  good_answer: 'The case evidence supports the reason, and no evidence of the case contradicts it.',
  refuses: 'A reason the case evidence contradicts or does not support.',
};
const HUMAN_FACING_CHECK = {
  check: 'Does any record of this case show people read or hear the words of this work?',
  good_answer: 'No evidence of the case shows a screen, notification, label or message people read.',
  refuses: 'A reason the case evidence contradicts: people read or hear the words of this work.',
};

// The plain test method, with a human_facing switch and the rule that a switch reason is judged, as method-row DATA.
function judgedMethod({ rule = true, own = true } = {}) {
  const method = plainMethod();
  if (rule) method.answer_rules.switch_reason = SWITCH_REASON;
  method.checks.push({ id: 'human_facing', question: 'Will people read or hear the words of this work?', ...(own ? { reason_check: HUMAN_FACING_CHECK } : {}), skip_requires: [{ name: 'why_not', label: 'Why no one reads it', kind: 'text', min_words: 3 }] });
  return method;
}
function account(method) {
  const door = memoryDoor();
  door.put(`record:${settings.records.method_row}:plain`, `record:${settings.records.method_row}`, method);
  for (const check of plainChecks()) door.put(`record:${settings.records.check_row}:${check.id}`, `record:${settings.records.check_row}`, check);
  return door;
}
const opened = {
  source_id: 'chat:board-header-1', goal: 'Decide where the sync status is shown',
  evidence: [
    { ref: 'e1', claim: 'The sync job writes its status into the phone board header' },
    { ref: 'e2', claim: 'The status list lives in the sync tool folder' },
  ],
  options: [{ id: 'header', label: 'Keep it in the header' }, { id: 'log', label: 'Move it to the log' }],
};
const scope = {
  decision_context: { worth_weighing: true, compare_existing: false, human_facing: false },
  omission_reasons: {
    compare_existing: { searched: ['the sync tool folder'], evidence_refs: ['e2'] },
    human_facing: { why_not: 'only the sync job reads the status', evidence_refs: ['e2'] },
  },
  evidence_refs: ['e1', 'e2'],
};
const judge = 'fresh-subagent-test';
// The kept scope step of the one case in the door.
const keptScope = door => [...door.records.values()].map(kept => kept.value).find(value => value?.step_id === 'scope' && 'judged_checks' in value) ?? null;

test('the scope question names each switch whose reason is judged, and how to send the verdicts', async () => {
  const door = account(judgedMethod());
  const started = await startADecision(opened, { door });
  const question = started.next_question ?? started.question ?? started;
  const asked = JSON.stringify(question);
  assert.match(asked, /"verdict_checks":\[[^\]]*"compare_existing"[^\]]*"human_facing"/, 'every switch with a reason check can take a verdict');
  assert.match(asked, /"grader":"second-judge"/);
});

test('a switch turned off with no verdict on its reason is refused, and nothing of the answer is kept', async () => {
  const door = account(judgedMethod());
  const { case_id: id } = await startADecision(opened, { door });
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door }), /compare_existing, human_facing/);
  await assert.rejects(
    answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope, verdicts: [{ check: 'compare_existing', meets: true, rests_on: 'e2', graded_by: judge }] }, { door }),
    /human_facing/,
  );
  assert.equal(keptScope(door), null, 'no step is kept');
});

test('a verdict on a switch reason must rest on a record of the case, not on the reason\'s own words', async () => {
  const door = account(judgedMethod());
  const { case_id: id } = await startADecision(opened, { door });
  const verdicts = [
    { check: 'compare_existing', meets: true, rests_on: 'e2', graded_by: judge },
    { check: 'human_facing', meets: true, rests_on: 'only the sync job reads the status', graded_by: judge },
  ];
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope, verdicts }, { door }), /human_facing \(rests_on must name a case evidence ref/);
});

test('a switch reason the judge finds the case records contradict is refused with the words of its check', async () => {
  const door = account(judgedMethod());
  const { case_id: id } = await startADecision(opened, { door });
  const verdicts = [
    { check: 'compare_existing', meets: true, rests_on: 'e2', graded_by: judge },
    { check: 'human_facing', meets: false, rests_on: 'e1', missing: 'people read or hear the words of this work', graded_by: judge },
  ];
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope, verdicts }, { door }), /omission_reasons\.human_facing: .*people read or hear the words of this work/);
});

test('a switch reason graded against the case records is kept with its verdict and who judged it', async () => {
  const door = account(judgedMethod());
  const { case_id: id } = await startADecision(opened, { door });
  const verdicts = [
    { check: 'compare_existing', meets: true, rests_on: 'e2', graded_by: judge },
    { check: 'human_facing', meets: true, rests_on: 'e2', graded_by: judge },
  ];
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope, verdicts }, { door });
  const kept = keptScope(door);
  assert.equal(kept.judged_checks, 2);
  assert.deepEqual(kept.verdicts.given.map(item => [item.id, item.meets, item.graded_by]), [['compare_existing', true, judge], ['human_facing', true, judge]]);
});

test('a switch\'s own reason check is what the judge is asked for that switch; the method-wide one for the rest', async () => {
  const door = account(judgedMethod());
  const { case_id: id } = await startADecision(opened, { door });
  const verdicts = [
    { check: 'compare_existing', meets: true, rests_on: 'e2', graded_by: judge },
    // These words are of the method-wide check, not of human_facing's own, so the refusal is not grounded and not taken.
    { check: 'human_facing', meets: false, rests_on: 'e1', missing: 'do the records of this case show', graded_by: judge },
  ];
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope, verdicts }, { door }), /human_facing \(missing must copy words of the check: Does any record of this case show people read/);
});

test('a switch that is on, or turned on by another, takes no verdict', async () => {
  const door = account(judgedMethod());
  const { case_id: id } = await startADecision(opened, { door });
  const on = { decision_context: { compare_existing: true, human_facing: true }, evidence_refs: ['e1'] };
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: on }, { door });
  assert.equal(keptScope(door).judged_checks, 0);
});

test('a method whose rows say nothing about switch reasons answers the scope as before', async () => {
  const door = account(judgedMethod({ rule: false, own: false }));
  const { case_id: id } = await startADecision(opened, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  assert.equal(keptScope(door).judged_checks, 0);
});
