// tool:rank-people-by-recorded-activity run as the container runs it, against the fake records door with exactly the row's rights.
// Fixtures are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rowOf(rows, 'tool:rank-people-by-recorded-activity');
const scoring = {
  weights: { post: 5, reply: 1 },
  metrics: [{ key: 'all_time', label: 'All time', lookback_days: null, order: 0 }, { key: 'week', label: 'Last 7 days', lookback_days: 7, order: 1 }],
  levels: [{ level: 1, name: 'New', min_points: 0 }, { level: 2, name: 'Regular', min_points: 5 }],
  rank_by: 'all_time',
  now: '2026-09-27T12:00:00Z',
};
const activity = (id, person, kind, at) => ({ id, type: 'person-activity', value: { person, kind, at } });

test('ranks the people in the records by their recorded activity, with levels', async () => {
  const answer = await runRow(row, scoring, { records: [
    activity('act:1', 'ana', 'post', '2026-09-26T10:00:00Z'),
    activity('act:2', 'ana', 'reply', '2026-09-26T11:00:00Z'),
    activity('act:3', 'ben', 'reply', '2026-09-01T10:00:00Z'),
    activity('act:4', 'ben', 'reply', '2026-09-25T10:00:00Z'),
    { id: 'note:1', type: 'note', value: { person: 'zed', kind: 'post', at: '2026-09-26T10:00:00Z' } },
  ] });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result.ranked.map(item => [item.person, item.rank, item.points, item.level.name]), [['ana', 1, 6, 'Regular'], ['ben', 2, 2, 'New']]);
});

test('a record shaped another way is read through the fields mapping', async () => {
  const answer = await runRow(row, { ...scoring, fields: { person: 'who', kind: 'what', at: 'material.created_at' } }, { records: [
    { id: 'act:1', type: 'person-activity', value: { who: 'cy', what: 'post', material: { created_at: '2026-09-26T10:00:00Z' } } },
  ] });
  assert.deepEqual(answer.result.ranked.map(item => [item.person, item.points]), [['cy', 5]]);
});

test('no scoring is refused in words, and the row may only list person-activity records', async () => {
  const answer = await runRow(row, {}, { records: [] });
  assert.equal(answer.status, 1);
  assert.match(answer.error, /Scoring needs weights/);
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'person-activity', operations: ['records:list'] }]);
});
