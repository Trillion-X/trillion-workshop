// test/kept-runs-partial-fold.test.mjs
//
// A complete fold needs its inputs times space_factor free (nextMerge). A store whose runs hold mostly overwritten values
// can be too full for that, so its debt was never worked off while every read probed every run (a 4.2 GB own-records
// book, 23 runs, 3.35 GB of debt, 2026-10-21). When the complete fold does not fit, the widest age-adjacent window of runs
// that does fit is folded; its output frees their bytes, the next wake has more room, and the complete fold runs once it
// fits. space_factor and the share of the limit are unchanged, and no estimate of live bytes is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

const key = at => `k${String(at).padStart(5, '0')}`;
const value = (at, round) => ({ at, round, text: 'v'.repeat(60) });

function fixture({ rounds = 22, keys = 300, roomRuns = 8 } = {}) {
  const host = sqliteHost(':memory:');
  // The database's size is what its run tables hold, so a merge's partial output counts and a dropped run frees its bytes.
  const sizeNow = () => host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'room_run_*'").toArray()
    .reduce((sum, table) => sum + Number(host.sql.exec(`SELECT COALESCE(SUM(LENGTH(body)), 0) AS n FROM ${table.name}`).toArray()[0].n), 0);
  const sql = { exec: (query, ...params) => host.sql.exec(query, ...params), get databaseSize() { return sizeNow(); } };
  const settings = { prefix: 'room', page_bytes: 2048, memtable_bytes: 1 << 30, fan_in: 4, max_runs: 100, space_share: 1, space_factor: 1.5,
    compaction_debt_min_bytes: 1, compaction_debt_ratio: 0.01, database_limit_bytes: 1 };
  const open = () => keptRuns(sql, { transaction: host.transaction, ...settings });
  let space = open();
  for (let round = 0; round < rounds; round += 1) {
    for (let at = 0; at < keys; at += 1) space.put(key(at), value(at, round), undefined, round ? 100 : 0);
    space.flush();
  }
  const total = space.held().runs.reduce((sum, run) => sum + run.bytes, 0);
  const each = total / rounds;
  // Room for a window of about roomRuns runs at space_factor, and not for the complete fold.
  settings.database_limit_bytes = Math.floor(sizeNow() + each * 1.5 * roomRuns);
  space = open();
  return { host, open, space, settings, sizeNow, rounds, keys, each };
}

test('a store too full for the complete fold folds a window of runs per wake until it fits, never past its room', () => {
  const { host, open, settings, sizeNow, rounds, keys } = fixture();
  try {
    let space = open();
    const before = space.held().runs.length;
    assert.equal(before, rounds);
    assert.equal(space.mergeDue(), true, 'a fold is due');
    const completeNeed = space.held().runs.reduce((sum, run) => sum + run.bytes, 0) * settings.space_factor;
    assert.ok(completeNeed > settings.database_limit_bytes - sizeNow(), 'the complete fold does not fit');
    const counts = [before];
    let peak = 0;
    for (let wake = 0; space.mergeDue(); wake += 1) {
      assert.ok(wake < 400, 'the debt drains in a bounded number of wakes');
      space = open();
      for (let turns = 0; space.meta.get('merge') !== undefined || turns === 0; turns += 1) {
        assert.ok(turns < 400);
        space.step({ max_pages: 64 });
        peak = Math.max(peak, sizeNow());
        if (space.meta.get('merge') === undefined) break;
      }
      counts.push(space.held().runs.length);
    }
    assert.ok(peak <= settings.database_limit_bytes, `the database never passed its limit (${peak} of ${settings.database_limit_bytes})`);
    assert.ok(space.held().runs.length <= 2, `runs fell from ${before} to ${space.held().runs.length}`);
    assert.ok(counts.length > 3, 'it took several wakes: ' + counts.join(' '));
    assert.ok(counts.every((count, at) => at === 0 || count < counts[at - 1]), 'every wake cut the run count: ' + counts.join(' '));
    for (let at = 0; at < keys; at += 7) assert.deepEqual(space.get(key(at)), value(at, rounds - 1), 'lookups stay correct');
  } finally { host.db.close(); }
});

test('when no two neighbouring runs fit the room, nothing starts and nothing is due', () => {
  const { host, open, settings, sizeNow } = fixture({ rounds: 6, roomRuns: 1 });
  try {
    const space = open();
    const smallest = Math.min(...space.held().runs.map(run => run.bytes));
    assert.ok(smallest * 2 * settings.space_factor > settings.database_limit_bytes - sizeNow(), 'no pair fits');
    assert.equal(space.mergeDue(), false);
  } finally { host.db.close(); }
});

test('a partial fold lowers the recorded debt by the bytes its output shed, so folds stop when the debt is worked off', () => {
  const { host, open } = fixture();
  try {
    let space = open();
    const debt = () => space.meta.get('compaction_debt') ?? 0;
    const start = debt();
    assert.ok(start > 0);
    for (let turns = 0; turns < 400; turns += 1) { space.step({ max_pages: 64 }); if (space.meta.get('merge') === undefined) break; }
    space = open();
    assert.ok(debt() < start, `debt fell from ${start} to ${debt()}`);
  } finally { host.db.close(); }
});
