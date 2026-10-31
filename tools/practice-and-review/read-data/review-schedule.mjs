// tools/practice-and-review/read-data/review-schedule.mjs
//
// When should a thing a person is learning come back? A person recalls an item and grades how well; this works out the
// next time it is due. Pure and deterministic: no disk, no clock (every time arrives as an argument), no storage.
//
// One scheduling step serves every subject (a flashcard, a drill, a passage, a move to practise). The item is opaque: the
// step reads three numbers carried from the last review and the grade just given, never the item's content.
//
// The grade is an open word, not a fixed list. The person's policy maps each grade word to a recall quality between 0 and
// 1, so a new grade (a number scale, "forgot", "trivial") is a row in their policy, not a code change. A grade the policy
// does not list counts as a total lapse, and the answer says so (grade_in_policy: false) so a typo cannot hide.
//
// The policy is the person's. This file ships none: every number that shapes the spacing (starting ease, ease floor, the
// first two gaps, the quality below which an item lapses, the grade map) is required, and a missing one is refused with
// the field's name.
//
// The step is the SM-2 family: ease moves by the grade's quality on a 0-5 scale, the gap after the first success and
// after the second are the policy's, and later gaps grow by ease. A lapse sets repetitions to 0 and the gap back to the
// policy's first gap.

const MS_PER_DAY = 86_400_000;

const NUMBER_FIELDS = ['initial_ease', 'min_ease', 'first_interval_days', 'second_interval_days', 'lapse_below_quality'];

const isNumber = value => typeof value === 'number' && Number.isFinite(value);

/** The policy, checked once. Throws one error naming every field that is missing or wrong. */
export function checkPolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).length === 0) {
    throw new Error(`policy is required: give { ${NUMBER_FIELDS.join(', ')}, grade_quality: { <grade word>: <recall quality 0 to 1> } }. This tool ships no default policy; the numbers that shape the spacing are the person's.`);
  }
  const problems = [];
  for (const field of NUMBER_FIELDS) if (!isNumber(policy[field])) problems.push(`${field} must be a number`);
  for (const field of ['min_ease', 'first_interval_days', 'second_interval_days']) {
    if (isNumber(policy[field]) && policy[field] <= 0) problems.push(`${field} must be above 0`);
  }
  const grades = policy.grade_quality;
  if (grades === null || typeof grades !== 'object' || Array.isArray(grades) || Object.keys(grades).length === 0) {
    problems.push('grade_quality must map at least one grade word to a recall quality between 0 and 1');
  } else {
    for (const [word, quality] of Object.entries(grades)) if (!isNumber(quality)) problems.push(`grade_quality.${word} must be a number`);
  }
  if (problems.length) throw new Error(`the policy is not usable: ${problems.join('; ')}`);
  return policy;
}

/** The state carried between reviews, checked. Throws when a number is missing. */
function checkState(state) {
  if (state === null || typeof state !== 'object' || ![state.reps, state.ease_factor, state.interval_days].every(isNumber)) {
    throw new Error('prior must be { reps, ease_factor, interval_days }, all numbers, exactly as the last review returned them; leave prior out for an item reviewed for the first time');
  }
  return { reps: state.reps, ease_factor: state.ease_factor, interval_days: state.interval_days };
}

const clamp01 = value => (Number.isNaN(value) ? 0 : Math.min(1, Math.max(0, value)));

/** Epoch ms of an ISO time. Throws on a time that is not one, naming the argument. */
export function parseTime(text, name) {
  const ms = typeof text === 'string' ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(ms)) throw new Error(`${name} must be a time such as 2026-01-31T09:00:00Z`);
  return ms;
}

/**
 * The next review state from a recall grade.
 * @param {{ prior?: {reps:number, ease_factor:number, interval_days:number}, grade: string, reviewedAtMs: number, policy: object }} input
 * @returns {{ state: {reps:number, ease_factor:number, interval_days:number}, dueAtMs: number, lapsed: boolean, quality: number, grade_in_policy: boolean }}
 */
export function scheduleNextReview({ prior, grade, reviewedAtMs, policy }) {
  checkPolicy(policy);
  const before = prior === undefined ? { reps: 0, ease_factor: policy.initial_ease, interval_days: 0 } : checkState(prior);
  const gradeInPolicy = Object.hasOwn(policy.grade_quality, grade);
  const quality = clamp01(gradeInPolicy ? policy.grade_quality[grade] : 0);
  const lapsed = quality < policy.lapse_below_quality;

  // SM-2 ease update on a 0-5 scale, never below the policy's floor.
  const q5 = quality * 5;
  const easeFactor = Math.max(policy.min_ease, before.ease_factor + (0.1 - (5 - q5) * (0.08 + (5 - q5) * 0.02)));

  let reps;
  let intervalDays;
  if (lapsed) {
    reps = 0;
    intervalDays = policy.first_interval_days;
  } else {
    reps = before.reps + 1;
    if (reps === 1) intervalDays = policy.first_interval_days;
    else if (reps === 2) intervalDays = policy.second_interval_days;
    else intervalDays = Math.max(1, Math.round(before.interval_days * easeFactor));
  }

  return {
    state: { reps, ease_factor: easeFactor, interval_days: intervalDays },
    dueAtMs: reviewedAtMs + intervalDays * MS_PER_DAY,
    lapsed,
    quality,
    grade_in_policy: gradeInPolicy,
  };
}

/**
 * One item's responses, oldest first, folded through the scheduler. Returns null when there are none (never reviewed).
 * @param {{ grade: string, at: string }[]} responses in any order; equal times keep their given order
 */
export function foldReviewHistory(responses, policy) {
  checkPolicy(policy);
  const timed = responses.map((response, index) => ({ grade: response.grade, ms: parseTime(response.at, `responses[${index}].at`) }));
  timed.sort((a, b) => a.ms - b.ms);
  let state;
  let dueAtMs = 0;
  for (const { grade, ms } of timed) {
    const next = scheduleNextReview({ prior: state, grade, reviewedAtMs: ms, policy });
    state = next.state;
    dueAtMs = next.dueAtMs;
  }
  return state === undefined ? null : { state, dueAtMs };
}

/**
 * What is due at nowMs. Never-reviewed items are due at once; reviewed ones when their folded due time has passed.
 * Due items first, then the soonest due, then by text and id so the order never depends on input order.
 * @param {{ id: string, text?: string }[]} prompts opaque items; everything else on one is handed back untouched
 * @param {{ prompt_id: string, grade: string, at: string, learner?: string }[]} responses
 */
export function dueQueueFromResponses({ prompts, responses, nowMs, policy, learner }) {
  checkPolicy(policy);
  const byPrompt = new Map();
  responses.forEach((response, index) => {
    if (typeof response.prompt_id !== 'string' || response.prompt_id === '') {
      throw new Error(`responses[${index}].prompt_id must name the item the response is for`);
    }
    if (learner !== undefined && response.learner !== learner) return;
    if (!byPrompt.has(response.prompt_id)) byPrompt.set(response.prompt_id, []);
    byPrompt.get(response.prompt_id).push(response);
  });

  const seen = new Set();
  const standings = prompts.map((prompt, index) => {
    if (prompt === null || typeof prompt !== 'object' || typeof prompt.id !== 'string' || prompt.id === '') {
      throw new Error(`prompts[${index}] needs an id string`);
    }
    if (seen.has(prompt.id)) throw new Error(`prompts[${index}].id ${prompt.id} appears twice; give each item one id`);
    seen.add(prompt.id);
    const own = byPrompt.get(prompt.id) ?? [];
    const folded = foldReviewHistory(own, policy);
    if (folded === null) return { prompt, is_due: true, review_count: 0, state: null, due_at: null, dueAtMs: 0 };
    return {
      prompt,
      is_due: folded.dueAtMs <= nowMs,
      review_count: own.length,
      state: folded.state,
      due_at: new Date(folded.dueAtMs).toISOString(),
      dueAtMs: folded.dueAtMs,
    };
  });

  standings.sort((a, b) => {
    if (a.is_due !== b.is_due) return a.is_due ? -1 : 1;
    if (a.dueAtMs !== b.dueAtMs) return a.dueAtMs - b.dueAtMs;
    return String(a.prompt.text ?? '').localeCompare(String(b.prompt.text ?? '')) || a.prompt.id.localeCompare(b.prompt.id);
  });
  return standings.map(({ dueAtMs: _ms, ...standing }) => standing);
}

/**
 * The policy a person keeps among their records: the first row whose payload (or value, or the row itself) has the given
 * kind, without the fields that only name the record. Returns null when no row has it.
 * @param {unknown} rows records as read from the person's store: [{ payload }] or bare payloads
 * @param {string} kind the kind the person gave their policy record
 */
export function policyFromRows(rows, kind) {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const payload = row !== null && typeof row === 'object' ? (row.payload ?? row.value ?? row) : null;
    if (payload !== null && typeof payload === 'object' && payload.kind === kind) {
      const { kind: _kind, id: _id, policy_id: _policyId, ...policy } = payload;
      return policy;
    }
  }
  return null;
}

/**
 * The state to carry off a schedule record kept earlier. A record with none of the three numbers (written before
 * scheduling existed) is a new item, so the scheduler starts fresh; a record with some of them is refused as unreadable.
 */
export function priorFromRecord(record) {
  if (record === undefined || record === null) return undefined;
  const given = ['reps', 'ease_factor', 'interval_days'].filter(field => record[field] !== undefined);
  if (given.length === 0) return undefined;
  return checkState(record);
}

/**
 * The next schedule record for an item after a review: the new state, the date it is due (a day, UTC) and state "due".
 * The caller supplies the record's id and the time, so the same input always builds the same record.
 */
export function nextScheduleRecord({ prior, prompt_id, learner, schedule_id, grade, reviewedAtMs, policy }) {
  const result = scheduleNextReview({ prior: priorFromRecord(prior), grade, reviewedAtMs, policy });
  return {
    schedule_id,
    prompt_id,
    learner,
    due_on: new Date(result.dueAtMs).toISOString().slice(0, 10),
    state: 'due',
    ...result.state,
  };
}
