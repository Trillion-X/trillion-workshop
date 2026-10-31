// tools/challenges/read-data/challenges.mjs
//
// Time-boxed challenges people enroll in, as DATA. A challenge definition is a record (any length, any unit,
// any audience); an enrollment is one (challenge, observer) membership. Pure: no clock, no I/O, no scoring.
//
// What this file does not own:
//   - Scoring who fits a challenge. A person's audience rule is scored elsewhere (the run-experiments tool scores
//     candidates against a decider); the score arrives here as a number, one per challenge.
//   - Access. `engagement_window` is an overlay on engagement. Nothing here, and nothing reading these records,
//     should treat a window ending as a reason to take content away.
//   - Words for status. `status_key` is an open string the caller supplies; its look is the caller's.

export const DEFINITION_KIND = 'challenge-definition';
export const ENROLLMENT_KIND = 'challenge-enrollment';

const isText = value => typeof value === 'string' && value.trim().length > 0;
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const objectOr = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

// Structural check of one definition. It does not follow the references it holds (audience_decider_ref, feed_ref,
// objective_ref): those belong to the records they name. Missing or malformed parts are listed, never guessed.
export function validateChallengeDefinition(raw) {
  const row = objectOr(raw);
  const window = objectOr(row.engagement_window);
  const policy = objectOr(row.enrollment_policy);
  const errors = [];
  if (row.kind !== DEFINITION_KIND) errors.push(`kind must be "${DEFINITION_KIND}"`);
  if (!isText(row.id)) errors.push('id must be a non-empty string');
  if (!isText(row.label)) errors.push('label must be a non-empty string');
  if (!isText(row.audience_decider_ref)) errors.push('audience_decider_ref must be a non-empty string (the reference to the rule that scores who fits)');
  if (!isText(row.feed_ref)) errors.push('feed_ref must be a non-empty string (the reference to the ordered content the challenge walks through)');
  if (!isText(window.unit)) errors.push('engagement_window.unit must be a non-empty string');
  if (!isNumber(window.length) || window.length <= 0) errors.push('engagement_window.length must be a positive number');
  if (!isNumber(policy.min_score)) errors.push('enrollment_policy.min_score must be a finite number');
  if (row.objective_ref !== undefined && !isText(row.objective_ref)) errors.push('objective_ref, when present, must be a non-empty string');
  return { valid: errors.length === 0, errors };
}

// The same (challenge, observer) pair always gives the same address, so enrolling twice writes one record.
export function enrollmentAddress(challengeId, observerId) {
  return `challenge::${challengeId}::enrollment::${observerId}`;
}

// A fresh membership. The window is copied from the definition now, so a later edit to the definition does not
// move an existing member's window. `startedAt` and `statusKey` come from the caller.
export function buildEnrollment(definition, observerId, startedAt, statusKey) {
  return {
    kind: ENROLLMENT_KIND,
    challenge_id: definition.id,
    observer_id: observerId,
    started_at: startedAt,
    engagement_window: { ...definition.engagement_window },
    status_key: statusKey,
  };
}

// Which of these challenges does one observer join? `scores` maps a challenge id to the observer's score for it.
// A challenge joins when its definition is valid and the score reaches its own min_score. Every challenge that does
// not join is listed with the reason, so a missing score is never read as a low one.
export function decideEnrollments({ definitions, scores, observerId, startedAt, statusKey }) {
  const enrollments = [];
  const skipped = [];
  for (const definition of definitions) {
    const id = isText(definition?.id) ? definition.id : '';
    const { valid, errors } = validateChallengeDefinition(definition);
    if (!valid) { skipped.push({ challenge_id: id, reason: 'definition is not valid', errors }); continue; }
    const score = scores[definition.id];
    if (!isNumber(score)) { skipped.push({ challenge_id: id, reason: 'no score was given for this challenge' }); continue; }
    if (score < definition.enrollment_policy.min_score) {
      skipped.push({ challenge_id: id, reason: `score ${score} is below min_score ${definition.enrollment_policy.min_score}` });
      continue;
    }
    enrollments.push({ address: enrollmentAddress(definition.id, observerId), record: buildEnrollment(definition, observerId, startedAt, statusKey) });
  }
  return { enrollments, skipped };
}
