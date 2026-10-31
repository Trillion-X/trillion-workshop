// Tests for tools/practice-and-review: the scheduling step, the fold of a grade history, the due queue, and the two
// scripts the tool rows run. Every policy, item and grade here is made up for the test; the tool ships none.
// Ported from the cases of the old spaced-repetition package's schedule, project-due and apply-review-response tests.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';

import { checkPolicy, dueQueueFromResponses, foldReviewHistory, nextScheduleRecord, policyFromRows, priorFromRecord, scheduleNextReview } from '../read-data/review-schedule.mjs';

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

const POLICY = {
  initial_ease: 2.5,
  min_ease: 1.3,
  first_interval_days: 1,
  second_interval_days: 6,
  grade_quality: { miss: 0, shaky: 0.6, solid: 0.8, instant: 1 },
  lapse_below_quality: 0.6,
};

const step = (grade, prior, policy = POLICY) => scheduleNextReview({ prior, grade, reviewedAtMs: T0, policy });
const prompt = (id, text = id) => ({ id, text });
const response = (promptId, grade, atMs, learner = 'learner-1') => ({ prompt_id: promptId, grade, at: iso(atMs), learner });

test('the first success uses the first gap, the second success the second gap', () => {
  const first = step('solid');
  assert.equal(first.state.reps, 1);
  assert.equal(first.state.interval_days, 1);
  assert.equal(first.dueAtMs, T0 + DAY);
  assert.equal(first.lapsed, false);
  const second = step('solid', { reps: 1, ease_factor: 2.5, interval_days: 1 });
  assert.equal(second.state.reps, 2);
  assert.equal(second.state.interval_days, 6);
  assert.equal(second.dueAtMs, T0 + 6 * DAY);
});

test('later successes grow the gap by ease', () => {
  const third = step('solid', { reps: 2, ease_factor: 2.5, interval_days: 6 });
  assert.equal(third.state.reps, 3);
  assert.ok(third.state.interval_days > 6);
  assert.equal(third.state.interval_days, Math.round(6 * third.state.ease_factor));
});

test('a better grade raises ease more, and never shortens the gap', () => {
  const prior = { reps: 2, ease_factor: 2.5, interval_days: 6 };
  const solid = step('solid', prior);
  const instant = step('instant', prior);
  assert.ok(instant.state.ease_factor > solid.state.ease_factor);
  assert.ok(instant.state.interval_days >= solid.state.interval_days);
});

test('a lapse resets repetitions and goes back to the first gap', () => {
  const lapse = step('miss', { reps: 5, ease_factor: 2.6, interval_days: 90 });
  assert.equal(lapse.lapsed, true);
  assert.equal(lapse.state.reps, 0);
  assert.equal(lapse.state.interval_days, 1);
  assert.equal(lapse.dueAtMs, T0 + DAY);
});

test('ease never falls below the policy floor', () => {
  assert.ok(step('miss', { reps: 0, ease_factor: 1.3, interval_days: 1 }).state.ease_factor >= POLICY.min_ease);
});

test('a grade the policy does not list is a total lapse, and the answer says it was not listed', () => {
  const unknown = step('totally-forgot');
  assert.equal(unknown.quality, 0);
  assert.equal(unknown.lapsed, true);
  assert.equal(unknown.state.reps, 0);
  assert.equal(unknown.grade_in_policy, false);
  assert.equal(step('solid').grade_in_policy, true);
  assert.equal(step('constructor').grade_in_policy, false);
});

test('a policy can use a number scale or new words with no code change', () => {
  const policy = { ...POLICY, grade_quality: { 0: 0, 3: 0.6, 5: 1, flawless: 1 } };
  assert.equal(step('5', undefined, policy).quality, 1);
  assert.equal(step('flawless', undefined, policy).quality, 1);
  assert.equal(step('5', undefined, policy).lapsed, false);
  assert.equal(step('0', undefined, policy).lapsed, true);
});

test('a recall quality outside 0 to 1 is clamped', () => {
  const policy = { ...POLICY, grade_quality: { over: 9, under: -4 } };
  assert.equal(step('over', undefined, policy).quality, 1);
  assert.equal(step('under', undefined, policy).quality, 0);
});

test('the policy shapes the spacing: other gaps give other due times', () => {
  const policy = { ...POLICY, first_interval_days: 3, second_interval_days: 9 };
  assert.equal(step('solid', undefined, policy).dueAtMs, T0 + 3 * DAY);
});

test('the same input gives the same answer', () => {
  assert.deepEqual(step('solid'), step('solid'));
});

test('there is no default policy: a missing or partial one is refused with what to give', () => {
  assert.throws(() => scheduleNextReview({ grade: 'solid', reviewedAtMs: T0 }), /policy is required.*initial_ease.*grade_quality/s);
  assert.throws(() => checkPolicy({}), /policy is required/);
  assert.throws(() => checkPolicy({ ...POLICY, min_ease: undefined, first_interval_days: 'a day' }), /min_ease must be a number; first_interval_days must be a number/);
  assert.throws(() => checkPolicy({ ...POLICY, grade_quality: {} }), /grade_quality must map at least one grade word/);
  assert.throws(() => checkPolicy({ ...POLICY, grade_quality: { good: 'high' } }), /grade_quality\.good must be a number/);
  assert.throws(() => checkPolicy({ ...POLICY, second_interval_days: 0 }), /second_interval_days must be above 0/);
  assert.equal(checkPolicy(POLICY), POLICY);
});

test('a prior that is not the last answer\'s state is refused', () => {
  assert.throws(() => step('solid', { reps: 1 }), /prior must be \{ reps, ease_factor, interval_days \}/);
});

test('folding a history does not depend on the order it is given in', () => {
  const folded = foldReviewHistory([{ grade: 'solid', at: iso(T0 + 7 * DAY) }, { grade: 'solid', at: iso(T0) }], POLICY);
  assert.equal(folded.state.reps, 2);
  assert.equal(folded.dueAtMs, T0 + 7 * DAY + 6 * DAY);
});

test('no history folds to null, and a lapse in the middle resets repetitions', () => {
  assert.equal(foldReviewHistory([], POLICY), null);
  const folded = foldReviewHistory([
    { grade: 'solid', at: iso(T0) },
    { grade: 'solid', at: iso(T0 + DAY) },
    { grade: 'miss', at: iso(T0 + 2 * DAY) },
  ], POLICY);
  assert.equal(folded.state.reps, 0);
});

test('a response whose time is not a time is refused, naming it', () => {
  assert.throws(() => foldReviewHistory([{ grade: 'solid', at: 'soon' }], POLICY), /responses\[0\]\.at must be a time/);
});

test('never-reviewed items are due first; reviewed ones wait for their folded time', () => {
  const queue = dueQueueFromResponses({ prompts: [prompt('p1'), prompt('p2')], responses: [response('p1', 'solid', T0)], nowMs: T0 + 12 * 3_600_000, policy: POLICY });
  assert.equal(queue[0].prompt.id, 'p2');
  assert.equal(queue[0].is_due, true);
  assert.equal(queue[0].review_count, 0);
  assert.equal(queue[0].due_at, null);
  assert.equal(queue[1].prompt.id, 'p1');
  assert.equal(queue[1].is_due, false);
  assert.equal(queue[1].due_at, iso(T0 + DAY));
});

test('a miss returns sooner than an instant recall (history decides)', () => {
  const miss = foldReviewHistory([{ grade: 'miss', at: iso(T0) }], POLICY);
  const instant = foldReviewHistory([{ grade: 'solid', at: iso(T0) }, { grade: 'instant', at: iso(T0) }], POLICY);
  assert.ok(miss.dueAtMs < instant.dueAtMs);
});

test('an item becomes due once now passes its folded due time', () => {
  const responses = [response('p1', 'solid', T0)];
  const at = nowMs => dueQueueFromResponses({ prompts: [prompt('p1')], responses, nowMs, policy: POLICY });
  assert.equal(at(T0 + 12 * 3_600_000)[0].is_due, false);
  assert.equal(at(T0 + 2 * DAY)[0].is_due, true);
  assert.equal(at(T0 + DAY)[0].is_due, true);
});

test('a learner filter folds only that learner\'s grades', () => {
  const mixed = [response('p1', 'solid', T0), response('p1', 'miss', T0 + DAY, 'learner-2')];
  const queue = dueQueueFromResponses({ prompts: [prompt('p1')], responses: mixed, nowMs: T0 + 2 * DAY, policy: POLICY, learner: 'learner-1' });
  assert.equal(queue[0].review_count, 1);
  const everyone = dueQueueFromResponses({ prompts: [prompt('p1')], responses: mixed, nowMs: T0 + 2 * DAY, policy: POLICY });
  assert.equal(everyone[0].review_count, 2);
});

test('due items come first, soonest due first, then by text and id; an item carries what it came with', () => {
  const prompts = [{ id: 'c', text: 'Beta', note: 'kept' }, { id: 'b', text: 'Alpha' }, { id: 'a', text: 'Alpha' }, prompt('late', 'Zeta')];
  const queue = dueQueueFromResponses({ prompts, responses: [response('late', 'solid', T0)], nowMs: T0 + 12 * 3_600_000, policy: POLICY });
  assert.deepEqual(queue.map(item => item.prompt.id), ['a', 'b', 'c', 'late']);
  assert.equal(queue[2].prompt.note, 'kept');
});

test('an item without an id, two items with one id, or a response without an item are refused', () => {
  assert.throws(() => dueQueueFromResponses({ prompts: [{ text: 'x' }], responses: [], nowMs: T0, policy: POLICY }), /prompts\[0\] needs an id/);
  assert.throws(() => dueQueueFromResponses({ prompts: [prompt('a'), prompt('a')], responses: [], nowMs: T0, policy: POLICY }), /appears twice/);
  assert.throws(() => dueQueueFromResponses({ prompts: [prompt('a')], responses: [{ grade: 'solid', at: iso(T0) }], nowMs: T0, policy: POLICY }), /responses\[0\]\.prompt_id/);
});

function runWithInput(name, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [new URL(`../do-work/${name}.mjs`, import.meta.url).pathname], (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('schedule-next-review: a first review gives the next state and a date-only due day', async () => {
  const answer = await runWithInput('schedule-next-review', { grade: 'solid', reviewed_at: '2026-01-01T12:00:00Z', policy: POLICY });
  assert.deepEqual(answer.state, { reps: 1, ease_factor: answer.state.ease_factor, interval_days: 1 });
  assert.equal(answer.due_at, '2026-01-02T12:00:00.000Z');
  assert.equal(answer.due_on, '2026-01-02');
  assert.equal(answer.lapsed, false);
  assert.equal(answer.grade_in_policy, true);
});

test('schedule-next-review: the state it gives goes back as prior and advances', async () => {
  const first = await runWithInput('schedule-next-review', { grade: 'solid', reviewed_at: '2026-01-01T12:00:00Z', policy: POLICY });
  const second = await runWithInput('schedule-next-review', { grade: 'solid', reviewed_at: first.due_at, prior: first.state, policy: POLICY });
  assert.equal(second.state.reps, 2);
  assert.equal(second.due_on, '2026-01-08');
});

test('schedule-next-review: no policy exits non-zero and says what to give', async () => {
  await assert.rejects(runWithInput('schedule-next-review', { grade: 'solid' }), error => /policy is required/.test(error.stderr));
});

test('list-what-is-due: counts and orders what is due', async () => {
  const answer = await runWithInput('list-what-is-due', {
    prompts: [prompt('p1'), prompt('p2')],
    responses: [response('p1', 'solid', T0)],
    now: iso(T0 + 12 * 3_600_000),
    policy: POLICY,
  });
  assert.equal(answer.due_count, 1);
  assert.deepEqual(answer.items.map(item => [item.prompt.id, item.is_due]), [['p2', true], ['p1', false]]);
});

test('list-what-is-due: no items list exits non-zero and says what to give', async () => {
  await assert.rejects(runWithInput('list-what-is-due', { policy: POLICY }), error => /prompts is required/.test(error.stderr));
});

test('the policy is found among a person\'s records by the kind they gave it, and its naming fields are dropped', () => {
  const rows = [{ payload: { kind: 'note', text: 'x' } }, { payload: { kind: 'my-policy', id: 'policy-1', ...POLICY } }];
  assert.deepEqual(policyFromRows(rows, 'my-policy'), POLICY);
  assert.equal(policyFromRows([], 'my-policy'), null);
  assert.equal(policyFromRows(rows, 'other'), null);
  assert.equal(policyFromRows('not rows', 'my-policy'), null);
});

test('the next schedule record carries the state forward, is due as a day, and is the same every time', () => {
  const prior = { schedule_id: 'old', reps: 2, ease_factor: 2.5, interval_days: 6, state: 'due' };
  const ask = { prior, prompt_id: 'p1', learner: 'learner-1', schedule_id: 'next', grade: 'solid', reviewedAtMs: T0, policy: POLICY };
  const record = nextScheduleRecord(ask);
  assert.equal(record.schedule_id, 'next');
  assert.equal(record.prompt_id, 'p1');
  assert.equal(record.learner, 'learner-1');
  assert.equal(record.state, 'due');
  assert.equal(record.reps, 3);
  assert.ok(record.interval_days > 6);
  assert.equal(record.due_on, iso(T0 + record.interval_days * DAY).slice(0, 10));
  assert.deepEqual(nextScheduleRecord(ask), record);
});

test('a lapse record goes back to reps 0 and the first gap; a first review needs no prior', () => {
  const lapse = nextScheduleRecord({ prior: { reps: 5, ease_factor: 2.6, interval_days: 90 }, prompt_id: 'p1', schedule_id: 'n', grade: 'miss', reviewedAtMs: T0, policy: POLICY });
  assert.equal(lapse.reps, 0);
  assert.equal(lapse.interval_days, 1);
  assert.equal(lapse.due_on, iso(T0 + DAY).slice(0, 10));
  const first = nextScheduleRecord({ prompt_id: 'p1', schedule_id: 'n', grade: 'solid', reviewedAtMs: T0, policy: POLICY });
  assert.equal(first.reps, 1);
  assert.equal(first.interval_days, 1);
});

test('a prior record written before scheduling (none of the three numbers) is a new item; a half-filled one is refused', () => {
  const legacy = { schedule_id: 'legacy', prompt_id: 'p1', state: 'due' };
  const record = nextScheduleRecord({ prior: legacy, prompt_id: 'p1', schedule_id: 'n', grade: 'solid', reviewedAtMs: T0, policy: POLICY });
  assert.equal(record.reps, 1);
  assert.equal(record.interval_days, 1);
  assert.throws(() => priorFromRecord({ reps: 3 }), /prior must be/);
});

test('a policy from the person\'s records changes the record the same as a given policy', () => {
  const rows = [{ payload: { kind: 'my-policy', ...POLICY, first_interval_days: 3 } }];
  const record = nextScheduleRecord({ prompt_id: 'p1', schedule_id: 'n', grade: 'solid', reviewedAtMs: T0, policy: policyFromRows(rows, 'my-policy') });
  assert.equal(record.due_on, iso(T0 + 3 * DAY).slice(0, 10));
});

test('schedule-next-review: with ids it also gives the next record; policy can come from rows; a legacy prior is a new item', async () => {
  const answer = await runWithInput('schedule-next-review', {
    grade: 'solid',
    reviewed_at: '2026-01-01T12:00:00Z',
    prior: { schedule_id: 'legacy', state: 'due' },
    prompt_id: 'p1',
    learner: 'learner-1',
    schedule_id: 'next',
    rows: [{ payload: { kind: 'my-policy', ...POLICY } }],
    policy_kind: 'my-policy',
  });
  assert.equal(answer.record.schedule_id, 'next');
  assert.equal(answer.record.reps, 1);
  assert.equal(answer.record.due_on, '2026-01-02');
  await assert.rejects(runWithInput('schedule-next-review', { grade: 'solid', prompt_id: 'p1', policy: POLICY }), error => /both prompt_id/.test(error.stderr));
});

test('list-what-is-due: the policy can come from rows', async () => {
  const answer = await runWithInput('list-what-is-due', { prompts: [prompt('p1')], rows: [{ payload: { kind: 'my-policy', ...POLICY } }], policy_kind: 'my-policy', now: iso(T0) });
  assert.equal(answer.due_count, 1);
});
