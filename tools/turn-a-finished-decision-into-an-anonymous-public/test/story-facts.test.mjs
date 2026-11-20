// Story facts: only finished decisions, the latest settled result, retracted evidence dropped, the length cap, the
// fallback kind, and the opaque BLAKE3-derived story address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFinished, isStoryId, kindOf, latestResult, mintStoryId, storyFacts } from '../read-data/story-facts.mjs';
import settings from '../read-data/story-settings.json' with { type: 'json' };

const record = {
  id: 'case-1',
  input: {
    goal: 'Decide whether Jordan should move Riley to the Harbor Club academy before the spring season',
    evidence: [
      { ref: 'a', claim: 'Riley has lost four of the last five matches on the second serve.' },
      { ref: 'b', claim: 'The academy costs a large sum each term.', retracted_at: '2026-09-02T00:00:00Z' },
    ],
    options: [
      { id: 'move', label: 'Move to the academy now' },
      { id: 'grip', label: 'Fix the second-serve grip at home first' },
    ],
  },
  decision: { option_id: 'grip', reason: 'The losses come from one fixable stroke.', next_action: 'Book three sessions this week.', success_measure: 'Second-serve points won rise above half.' },
  reports: [{ result: 'met', summary: 'Three of four matches were won after the change.', reported_at: '2026-09-20T10:00:00Z' }],
};

test('only a decision that chose from its options is finished', () => {
  assert.equal(isFinished(record), true);
  assert.equal(isFinished({ ...record, decision: undefined }), false);
  assert.equal(isFinished({ ...record, input: { ...record.input, options: [] } }), false);
});

test('the latest settled result is the newest report or check, and an unknown check is never a result', () => {
  assert.deepEqual(latestResult(record), { result: 'met', what_happened: 'Three of four matches were won after the change.', at: '2026-09-20T10:00:00Z' });
  const later = { ...record, outcome_checks: [{ result: 'failed', reason: 'The count fell.', checked_at: '2026-10-01T00:00:00Z' }, { result: 'unknown', reason: 'No data.', checked_at: '2026-10-05T00:00:00Z' }] };
  assert.equal(latestResult(later).result, 'failed');
  assert.equal(latestResult({ ...record, reports: [], outcome_checks: [{ result: 'unknown', checked_at: '2026-10-05T00:00:00Z' }] }), null);
});

test('facts come from the decision, drop retracted evidence, and name the chosen option by its label', () => {
  const facts = storyFacts(record);
  assert.equal(facts.chosen, 'Fix the second-serve grip at home first');
  assert.deepEqual(facts.context, ['Riley has lost four of the last five matches on the second serve.']);
  assert.equal(facts.why, 'The losses come from one fixable stroke.');
  assert.equal(facts.outcome.result, 'met');
});

test('the length cap drops thinking first, then context, and never the decision itself', () => {
  const thinking = ['x'.repeat(300), 'y'.repeat(300)];
  const roomy = storyFacts(record, { thinking });
  assert.equal(roomy.thinking.length, 2);
  const tight = storyFacts(record, { thinking, limit: 700 });
  assert.equal(tight.thinking.length, 0);
  assert.equal(tight.context.length, 1);
  assert.equal(tight.chosen, 'Fix the second-serve grip at home first');
  const tightest = storyFacts(record, { thinking, limit: 50 });
  assert.equal(tightest.context.length, 0);
  assert.equal(tightest.goal, record.input.goal);
});

test('an unlisted kind is filed under the fallback kind, a listed one is kept', () => {
  const fallback = settings.kinds.find(kind => kind.fallback).id;
  assert.equal(kindOf('astrology'), fallback);
  assert.equal(kindOf('money'), 'money');
});

test('a story address is 20 lowercase hex characters, fresh each time, and never the decision id', () => {
  const first = mintStoryId();
  assert.ok(isStoryId(first));
  assert.notEqual(first, mintStoryId());
  assert.equal(isStoryId('case-1'), false);
  assert.equal(isStoryId(first.toUpperCase()), false);
  assert.equal(first.includes(record.id), false);
});
