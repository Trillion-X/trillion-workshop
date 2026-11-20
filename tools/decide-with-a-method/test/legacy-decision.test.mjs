// A decision made before method rows keeps its answers (read-data/legacy-decision.mjs, read by workedSteps in
// read-data/answer-words.mjs). The legacy root is built here, as an older store kept it: its answered steps whole in
// `guidance`, its method inline as the snapshot `method`. Every name and answer is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legacyAnswers, legacyMethodRows } from '../read-data/legacy-decision.mjs';
import { workedSteps } from '../read-data/answer-words.mjs';
import { heldOf, memoryDoor, METHOD_VIEW, methodAccount, STEP_ROW } from './fixtures.mjs';

const settings = JSON.parse(readFileSync(new URL('../method-rows/settings.json', import.meta.url), 'utf8'));
const words = JSON.parse(readFileSync(new URL('../read-data/answer-words.json', import.meta.url), 'utf8'));
const LEGACY = 'source:bGVnYWN5LW1ldGhvZC0x';

// A decision with three steps in its method snapshot. `scope` has one answer, `outcome` two (the later one is its
// answer), `proof` none, and the last entry answers a step the snapshot does not name.
function legacyAccount() {
  const door = memoryDoor();
  door.put(LEGACY, 'decision', {
    id: LEGACY,
    source_id: 'chat:legacy-1',
    status: 'needs_decision',
    decision: null,
    input: { source_id: 'chat:legacy-1', goal: 'Decide a made-up thing' },
    method: {
      id: 'plain',
      name: 'A made-up method',
      steps: [
        { id: 'scope', question: 'What is being decided?' },
        { id: 'outcome', question: 'What should be true after?' },
        { id: 'proof', question: 'What shows it?' },
      ],
    },
    guidance: [
      { step_id: 'scope', answer: { note: 'A made-up scope' }, answered_at: '2026-01-01T00:00:01.000Z' },
      { step_id: 'outcome', answer: { note: 'The first made-up outcome' }, answered_at: '2026-01-01T00:00:02.000Z', version: 1 },
      { step_id: 'outcome', answer: { answer: 'The made-up outcome is settled' }, answered_at: '2026-01-01T00:00:03.000Z', version: 2 },
      { step_id: 'retired', answer: { answer: 'A step the snapshot does not name' }, answered_at: '2026-01-01T00:00:04.000Z' },
    ],
  });
  return door;
}

test('the snapshot steps read as method rows, in its order, each checked by the default strictness', () => {
  const root = legacyAccount().value(LEGACY);
  const rows = legacyMethodRows(root);
  assert.deepEqual(rows.map(row => row.id), ['scope', 'outcome', 'proof']);
  assert.deepEqual(rows[0].values, { id: 'scope', question: 'What is being decided?' });
  assert.deepEqual(rows.map(row => row.strictness.from), ['default', 'default', 'default']);
  assert.deepEqual(rows[0].strictness.rules, settings.strictness.default.rules);
});

test('the latest answer to each named step is read, its text from `answer` or else `note`; an unnamed step and a step with no answer are left out', () => {
  const root = legacyAccount().value(LEGACY);
  assert.deepEqual(legacyAnswers(root), [
    { row: 'scope', answered_at: '2026-01-01T00:00:01.000Z', answer: { answer: 'A made-up scope' } },
    { row: 'outcome', answered_at: '2026-01-01T00:00:03.000Z', answer: { answer: 'The made-up outcome is settled' } },
  ]);
});

test('a decision made before method rows reads its worked steps with no saved view named', () => {
  const steps = workedSteps(heldOf(legacyAccount()), LEGACY);
  assert.deepEqual(steps.map(step => step.step_id), ['scope', 'outcome']);
  assert.equal(steps[0].question, 'What is being decided?');
  assert.deepEqual(steps[0].rows, [{ label: words.label, text: 'A made-up scope' }]);
  assert.deepEqual(steps[1].rows, [{ label: words.label, text: 'The made-up outcome is settled' }]);
  assert.deepEqual(steps[0].checks, [{ label: words.checked_by, text: words.checked_from.default }]);
});

test('a legacy decision answered again through the method rows shows both: the legacy answers first, then the view answers in the view order', () => {
  const door = legacyAccount();
  methodAccount(door);
  door.put(`method-answer:${LEGACY}:${encodeURIComponent(STEP_ROW('proof'))}`, settings.answers.type, { answer: 'A made-up proof' });
  door.put(`method-answer:${LEGACY}:${encodeURIComponent(STEP_ROW('scope'))}`, settings.answers.type, { answer: 'Answered again by a view row' });
  const steps = workedSteps(heldOf(door), LEGACY, METHOD_VIEW);
  assert.deepEqual(steps.map(step => step.step_id), ['scope', 'outcome', STEP_ROW('proof'), STEP_ROW('scope')]);
  assert.deepEqual(steps[2].rows, [{ label: words.label, text: 'A made-up proof' }]);
  assert.deepEqual(steps[3].rows, [{ label: words.label, text: 'Answered again by a view row' }]);
});
