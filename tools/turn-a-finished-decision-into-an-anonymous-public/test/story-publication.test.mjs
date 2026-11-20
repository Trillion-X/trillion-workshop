// Which finished decisions are written as stories: the owner's own choice (or the default row from its day), never an
// unfinished decision, never a story taken down, and never twice for one result basis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basisOf, storiesOn, storyStep } from '../read-data/story-publication.mjs';

const row = { on: true, from_day: '2026-09-28' };
const record = {
  id: 'case-1',
  created_at: '2026-10-01T10:00:00Z',
  input: { goal: 'A goal', evidence: [], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  decision: { option_id: 'a', reason: 'Why', next_action: 'Next', success_measure: 'Measure' },
};

test('the owner\'s own stories choice wins over the default row, on or off', () => {
  assert.equal(storiesOn(false, row, '2026-10-01T10:00:00Z'), false);
  assert.equal(storiesOn(true, { on: false, from_day: '2026-09-28' }, '2026-01-01T00:00:00Z'), true);
});

test('the default row covers only decisions made on or after its day', () => {
  assert.equal(storiesOn(undefined, row, '2026-09-27T23:59:00Z'), false);
  assert.equal(storiesOn(undefined, row, '2026-09-28T00:00:00Z'), true);
  assert.equal(storiesOn(undefined, { on: false, from_day: '2026-09-28' }, '2026-10-01T00:00:00Z'), false);
});

test('a story is written only for a finished decision while stories are on', () => {
  assert.equal(storyStep({ on: false, record, saved: null }), 'skip');
  assert.equal(storyStep({ on: true, record: { ...record, decision: undefined }, saved: null }), 'skip');
  assert.equal(storyStep({ on: true, record, saved: null }), 'write');
});

test('a story taken down is never written again, and one already written for this basis is not written twice', () => {
  assert.equal(storyStep({ on: true, record, saved: { withdrawn: true, basis: 'decided' } }), 'withdrawn');
  assert.equal(storyStep({ on: true, record, saved: { published: true, basis: basisOf(record) } }), 'unchanged');
});

test('a new result is a new basis, so the story is written again', () => {
  const reported = { ...record, reports: [{ result: 'met', summary: 'It worked.', reported_at: '2026-10-20T00:00:00Z' }] };
  assert.equal(basisOf(reported), '2026-10-20T00:00:00Z');
  assert.equal(storyStep({ on: true, record: reported, saved: { published: true, basis: 'decided' } }), 'write');
});
