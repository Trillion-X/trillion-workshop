// What the product did for a person in the last week (read-data/setup-week.mjs): finished work, kept words and files, with
// bounded reads. The records are made up; the harness names are the ones keep-and-wake knows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setupWeek } from '../read-data/setup-week.mjs';

const NOW = Date.parse('2026-11-20T06:00:00Z');
const RECENT = '2026-11-19T10:00:00.000Z';
const OLD = '2026-11-01T10:00:00.000Z';
const agents = work => ({ recentWork: () => ({ work, agents: [{ agent_id: 'a1', name: 'Codex' }] }) });
const finished = taken_by => ({ state: 'finished', taken_by, finished_at: RECENT, result: {} });
const EMPTY_RECORDS = { fields: [], scan: () => [] };

test('a job an AI finished this week is counted under that AI\'s name, with the time of its last finish', async () => {
  const answer = await setupWeek({ agents: agents([finished('a1'), finished('a1')]), records: EMPTY_RECORDS, storedSince: async () => null, now: NOW });
  assert.deepEqual(answer.finished.map(row => [row.name, row.count, row.at]), [['Codex', 2, RECENT]]);
  assert.deepEqual(answer.recorded, []);
  assert.deepEqual(answer.arrived, []);
});

test('work finished before the last seven days is left out, so an empty list means nothing happened', async () => {
  const answer = await setupWeek({ agents: agents([{ ...finished('a1'), finished_at: OLD }]), records: EMPTY_RECORDS, storedSince: async () => null, now: NOW });
  assert.deepEqual(answer.finished, []);
  assert.equal(answer.since, '2026-11-13T06:00:00.000Z');
});

test('files kept since the week began are counted once under Files', async () => {
  const answer = await setupWeek({ agents: agents([]), records: EMPTY_RECORDS, storedSince: async () => ({ count: 3, at: RECENT }), now: NOW });
  assert.deepEqual(answer.arrived, [{ name: 'Files', domain: null, count: 3, at: RECENT }]);
});

test('a failed read rejects the whole answer, so the screen shows it unknown, never empty', async () => {
  await assert.rejects(setupWeek({ agents: agents([]), records: EMPTY_RECORDS, storedSince: async () => { throw new Error('store down'); }, now: NOW }), /store down/);
});
