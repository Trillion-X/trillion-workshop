// tools/ask-questions-sort-answers-follow-up/test/score-totals-are-measures.test.mjs
// A respondent's score, its parts per answer and its subtotals per label are the list engine's own `sum` measure
// (query-and-change-list-rows list-aggregates `measure`); the rules that earn the points stay the caller's DATA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decide, scoreAnswers } from '../read-data/score-and-segment.ts';
import { summarize } from '../read-data/results-model.ts';

const rules = [
  { readKey: 'budget', points: 0.1, match: { gte: 1 }, scoreLabel: 'fit' },
  { readKey: 'budget', points: 0.2, match: { gte: 2 }, scoreLabel: 'fit' },
  { readKey: 'timing', match: { value_map: { now: 5, later: 1 } }, scoreLabel: 'urgency' },
  { readKey: 'note', points: 4, match: { has_value: true } },
  { readKey: 'skipped', points: 9, match: { equals: 'yes' } },
];

test('the score, its parts and its subtotals add up as the list engine adds them', () => {
  const scored = scoreAnswers({ budget: 3, timing: 'now', note: 'hi', skipped: 'no' }, rules);
  assert.deepEqual(scored, { score: 9.3, breakdown: { budget: 0.3, timing: 5, note: 4 }, byLabel: { fit: 0.3, urgency: 5 } });
  assert.deepEqual(scoreAnswers({}, rules), { score: 0, breakdown: {}, byLabel: {} });
});

test('the segment is the highest threshold the measured score meets', () => {
  const segments = [{ min: 0, segmentId: 'cold' }, { min: 9, segmentId: 'warm' }, { min: 9.5, segmentId: 'hot' }];
  assert.equal(decide({ budget: 3, timing: 'now', note: 'hi' }, rules, segments).segmentId, 'warm');
  assert.equal(decide({}, rules, segments).segmentId, 'cold');
});

test('the results count each segment (and those with none) with the list engine\'s count', () => {
  const row = (respondentId, segmentId) => ({ respondentId, formId: 'f', segmentId, score: 1, decidedAt: '' });
  assert.deepEqual(summarize([row('a', 'hot'), row('b', 'hot'), row('c', null), row('d', 'cold')]), { total: 4, bySegment: { hot: 2, unsegmented: 1, cold: 1 } });
  assert.deepEqual(summarize([]), { total: 0, bySegment: {} });
  assert.doesNotMatch(readFileSync(resolve(import.meta.dirname, '../read-data/results-model.ts'), 'utf8'), /\?\? 0\) \+ 1/);
});

test('the file holds no sum of its own: it asks the list engine', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../read-data/score-and-segment.ts'), 'utf8');
  assert.match(source, /from 'trillion-workshop\/tools\/query-and-change-list-rows\/src\/list-aggregates\.mjs'/);
  assert.doesNotMatch(source, /score \+= pts|\?\? 0\) \+ pts/);
});
