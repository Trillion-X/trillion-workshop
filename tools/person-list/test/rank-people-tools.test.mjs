// tool:rank-people-by-activity run as the container runs it, with no records door: the activity is handed in and the
// ranked people are the answer. Fixtures are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { rankActivity } from '../read-data/rank-activity.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const row = rowOf(rows, 'tool:rank-people-by-activity');
const scoring = {
  weights: { post: 5, reply: 1 },
  metrics: [{ key: 'all_time', label: 'All time', lookback_days: null, order: 0 }, { key: 'week', label: 'Last 7 days', lookback_days: 7, order: 1 }],
  levels: [{ level: 1, name: 'New', min_points: 0 }, { level: 2, name: 'Regular', min_points: 5 }],
  rank_by: 'all_time',
  now: '2026-09-27T12:00:00Z',
};
const activity = [
  { person: 'ana', kind: 'post', at: '2026-09-26T10:00:00Z' },
  { person: 'ana', kind: 'reply', at: '2026-09-26T11:00:00Z' },
  { person: 'ben', kind: 'reply', at: '2026-09-01T10:00:00Z' },
  { person: 'ben', kind: 'reply', at: '2026-09-25T10:00:00Z' },
];

test('the row declares no records door, and its answer holds the people ranked from the activity handed in', async () => {
  assert.equal(row.invoke.records, undefined);
  const answer = await answerOf(row, { ...scoring, activity }, { records: [] });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.ranked.map(item => [item.person, item.rank, item.points, item.level.name]), [['ana', 1, 6, 'Regular'], ['ben', 2, 2, 'New']]);
  assert.deepEqual(answer.kept, [], 'nothing is written');
});

test('no scoring is refused in words', () => {
  assert.throws(() => rankActivity({ activity }), /Scoring needs weights/);
});

test('the recorded-activity tool is gone: the only ranking row takes activity as input', () => {
  assert.equal(rows.records.some(record => record.payload.id === 'tool:rank-people-by-recorded-activity'), false);
  assert.ok(row.input_schema.required.includes('activity'));
});
