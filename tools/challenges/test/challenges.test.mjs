// tools/challenges: the definition check, the enrollment address and record, and the enrollment decision.
// Every fixture is a made-up bakery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFINITION_KIND, ENROLLMENT_KIND, buildEnrollment, decideEnrollments, enrollmentAddress, validateChallengeDefinition,
} from '../read-data/challenges.mjs';

const definition = (id, minScore, extra = {}) => ({
  kind: DEFINITION_KIND,
  id,
  label: `Challenge ${id}`,
  engagement_window: { unit: 'day', length: 30 },
  audience_decider_ref: `rule:${id}`,
  feed_ref: `feed:${id}`,
  enrollment_policy: { min_score: minScore },
  ...extra,
});

test('a complete definition is valid, with or without an objective reference', () => {
  assert.equal(validateChallengeDefinition(definition('bake-month', 0.5)).valid, true);
  assert.equal(validateChallengeDefinition(definition('fix-the-crust', 0.5, { objective_ref: 'goal:crust' })).valid, true);
});

test('missing references, an empty label and a window of zero are each named', () => {
  const { valid, errors } = validateChallengeDefinition({
    kind: DEFINITION_KIND, id: 'x', label: '', engagement_window: { unit: 'day', length: 0 },
    audience_decider_ref: '', feed_ref: 'feed:x', enrollment_policy: {},
  });
  assert.equal(valid, false);
  for (const part of ['label', 'audience_decider_ref', 'engagement_window.length', 'enrollment_policy.min_score']) {
    assert.ok(errors.some(error => error.includes(part)), part);
  }
});

test('any unit and any length is valid: no fixed number of days is built in', () => {
  assert.equal(validateChallengeDefinition(definition('six-weeks', 0.5, { engagement_window: { unit: 'week', length: 6 } })).valid, true);
  assert.equal(validateChallengeDefinition(definition('three-sessions', 0.5, { engagement_window: { unit: 'session', length: 3 } })).valid, true);
});

test('a definition of the wrong kind, a non-object and an empty objective_ref are refused', () => {
  assert.match(validateChallengeDefinition({ ...definition('a', 1), kind: 'other' }).errors[0], /kind must be/);
  assert.equal(validateChallengeDefinition(null).valid, false);
  assert.equal(validateChallengeDefinition(definition('a', 1, { objective_ref: '  ' })).valid, false);
});

test('the enrollment address depends on the challenge and the observer only', () => {
  assert.equal(enrollmentAddress('c1', 'o1'), 'challenge::c1::enrollment::o1');
  assert.equal(enrollmentAddress('c1', 'o1'), enrollmentAddress('c1', 'o1'));
  assert.notEqual(enrollmentAddress('c1', 'o1'), enrollmentAddress('c1', 'o2'));
  assert.notEqual(enrollmentAddress('c1', 'o1'), enrollmentAddress('c2', 'o1'));
});

test('an enrollment copies the window and takes its status word from the caller', () => {
  const source = definition('c1', 0.5);
  const record = buildEnrollment(source, 'o1', '2026-01-01T09:00:00Z', 'started');
  assert.deepEqual(record, {
    kind: ENROLLMENT_KIND, challenge_id: 'c1', observer_id: 'o1', started_at: '2026-01-01T09:00:00Z',
    engagement_window: { unit: 'day', length: 30 }, status_key: 'started',
  });
  source.engagement_window.length = 99;
  assert.equal(record.engagement_window.length, 30, 'a later edit to the definition does not move the member\'s window');
  assert.equal(buildEnrollment(definition('c2', 0.5), 'o1', 'now', 'invited').status_key, 'invited');
});

const ask = (definitions, scores) => decideEnrollments({ definitions, scores, observerId: 'o1', startedAt: '2026-01-01T09:00:00Z', statusKey: 'started' });

test('a person joins every challenge whose score reaches its own threshold (many memberships)', () => {
  const defs = [definition('everyone', 0.5), definition('rye-fans', 0.5), definition('strict', 0.9)];
  const { enrollments, skipped } = ask(defs, { everyone: 1, 'rye-fans': 0.5, strict: 0.8 });
  assert.deepEqual(enrollments.map(item => item.record.challenge_id), ['everyone', 'rye-fans']);
  assert.deepEqual(enrollments.map(item => item.address), ['challenge::everyone::enrollment::o1', 'challenge::rye-fans::enrollment::o1']);
  assert.deepEqual(skipped.map(item => item.challenge_id), ['strict']);
  assert.match(skipped[0].reason, /below min_score 0\.9/);
});

test('a challenge with no score is skipped with that reason, never read as a low score', () => {
  const { enrollments, skipped } = ask([definition('everyone', 0)], {});
  assert.deepEqual(enrollments, []);
  assert.match(skipped[0].reason, /no score was given/);
});

test('an invalid definition is skipped with its problems and does not stop the rest', () => {
  const broken = { ...definition('broken', 0.5), feed_ref: '' };
  const { enrollments, skipped } = ask([broken, definition('ok', 0.5)], { broken: 1, ok: 1 });
  assert.deepEqual(enrollments.map(item => item.record.challenge_id), ['ok']);
  assert.equal(skipped[0].reason, 'definition is not valid');
  assert.ok(skipped[0].errors.some(error => error.includes('feed_ref')));
});

test('a new challenge needs only a definition and a score: no code names any audience', () => {
  const extra = definition('over-sixty', 0.5);
  assert.deepEqual(ask([extra], { 'over-sixty': 0.75 }).enrollments.map(item => item.record.challenge_id), ['over-sixty']);
});

test('running the decision twice gives the same addresses, so storing them twice keeps one record each', () => {
  const defs = [definition('a', 0.5), definition('b', 0.5)];
  const scores = { a: 1, b: 1 };
  assert.deepEqual(ask(defs, scores).enrollments.map(item => item.address), ask(defs, scores).enrollments.map(item => item.address));
});
