// tools/practice-and-review/do-work/schedule-next-review.mjs
//
// The next time an item is due, from how well the person just recalled it. Run by the Workshop tool
// `tool:schedule-next-review` in the tool container:
//
//   node do-work/schedule-next-review.mjs < <the input as JSON>
//
// and prints { state, due_at, due_on, lapsed, quality, grade_in_policy, record? } as JSON on its last line. It keeps
// nothing: the caller keeps `state` (or `record`) with the item and hands it back as `prior` at the next review. `prior`
// is the state the last answer gave, or a schedule record kept earlier; a record with none of the three numbers is a new
// item. When prompt_id and schedule_id are given, `record` is the next schedule record to keep. The policy is `policy`,
// or the first of `rows` whose kind is `policy_kind`; this tool has none of its own. A missing policy field, a prior that
// is not readable, or a time that is not a time is refused with the reason.
import { text } from 'node:stream/consumers';
import { nextScheduleRecord, parseTime, policyFromRows, priorFromRecord, scheduleNextReview } from '../read-data/review-schedule.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
if (typeof input.grade !== 'string' || input.grade === '') {
  throw new Error('grade is required: the grade word the person gave, one of the words in policy.grade_quality');
}
const policy = input.policy ?? (input.rows ? policyFromRows(input.rows, input.policy_kind) : null) ?? undefined;
const reviewedAtMs = parseTime(input.reviewed_at ?? new Date().toISOString(), 'reviewed_at');
const prior = input.prior ?? undefined;
const result = scheduleNextReview({ prior: priorFromRecord(prior), grade: input.grade, reviewedAtMs, policy });
const dueAt = new Date(result.dueAtMs).toISOString();
const answer = {
  state: result.state,
  due_at: dueAt,
  due_on: dueAt.slice(0, 10),
  lapsed: result.lapsed,
  quality: result.quality,
  grade_in_policy: result.grade_in_policy,
};
if (input.prompt_id !== undefined || input.schedule_id !== undefined) {
  if (typeof input.prompt_id !== 'string' || typeof input.schedule_id !== 'string') {
    throw new Error('to get a record, give both prompt_id (the item) and schedule_id (the id for the new record)');
  }
  answer.record = nextScheduleRecord({ prior, prompt_id: input.prompt_id, learner: input.learner, schedule_id: input.schedule_id, grade: input.grade, reviewedAtMs, policy });
}
console.log(JSON.stringify(answer));

