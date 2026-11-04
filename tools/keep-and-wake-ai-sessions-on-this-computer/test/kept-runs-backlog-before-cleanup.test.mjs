// test/kept-runs-backlog-before-cleanup.test.mjs
//
// Runs past max_runs merge before obsolete large values are retired (parts/record-log/do-work/kept-runs.mjs step): every
// read probes every run, while a value waiting to be retired only holds storage. On the owner's store (2026-10-10) the
// retiring went first, 16 parts a wake, and 183 runs piled up behind it, so every take and hand-off read about 20,000
// rows. This queues many retirements, then makes a backlog, and fails when the backlog waits for the queue, when a value
// is lost, or when the queue never drains once the backlog is gone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

const settings = { prefix: 'backlog', page_bytes: 128, big_bytes: 32, memtable_bytes: 1 << 30, fan_in: 2, max_runs: 4 };
const key = at => `k${String(at).padStart(4, '0')}`;
const value = (at, version) => ({ at, version, text: version.repeat(100) });
const count = (host, table) => [...host.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`)][0].n;

test('a backlog of runs merges before obsolete large values are retired, and the retiring still finishes', () => {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, { transaction: host.transaction, ...settings });
  let space = open();
  const total = 200;
  for (let at = 0; at < total; at += 1) space.put(key(at), value(at, 'old'));
  space.flush();
  for (let at = 0; at < total; at += 1) space.put(key(at), value(at, 'new'));
  space.flush();
  for (let turns = 0; space.meta.get('merge') !== undefined || space.held().runs.length > 1; turns += 1) {
    assert.ok(turns < 500, 'the first merge did not publish');
    space.step({ max_pages: 64 });
  }
  const queued = count(host, 'backlog_big_drops');
  assert.equal(queued, total, 'every older value waits to be retired');
  // Small write-outs arrive while the queue waits: a backlog well past max_runs.
  for (let run = 0; run < 12; run += 1) {
    space.put(`s${String(run).padStart(3, '0')}`, { run });
    space.flush();
  }
  assert.equal(space.held().runs.length, 13);
  let turns = 0;
  for (; space.held().runs.length > settings.max_runs; turns += 1) {
    assert.ok(turns < 12, `the backlog waited: ${space.held().runs.length} runs after ${turns} steps`);
    space = open();
    space.step({ max_pages: 64 });
  }
  assert.ok(count(host, 'backlog_big_drops') > 0, 'the backlog merged while values still waited to be retired');
  for (let guard = 0; ; guard += 1) {
    assert.ok(guard < 500, 'the retiring never finished');
    space = open();
    if (!space.step({ max_pages: 64 }).more) break;
  }
  assert.equal(count(host, 'backlog_big_drops'), 0);
  assert.equal(count(host, 'backlog_big'), total, 'only the newer values are kept');
  for (let at = 0; at < total; at += 1) assert.deepEqual(space.get(key(at)), value(at, 'new'), key(at));
  for (let run = 0; run < 12; run += 1) assert.deepEqual(space.get(`s${String(run).padStart(3, '0')}`), { run });
});
