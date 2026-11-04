import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

// A start loads only filter_boot_bytes of filters, and each filter left out costs one SQL probe per read. On a store
// with a merge backlog that probed every run: one setting read on the founder's store took 1,666 statements and
// 2.4 million rows, and the store could not start to run the merges (2026-10-16). With a backlog a start loads its
// filters up to filter_bytes, so a read of an absent key asks SQL nothing however many runs wait to merge.
function store(runs, { max_runs }) {
  const host = sqliteHost(':memory:');
  const settings = { transaction: host.transaction, prefix: 'boot', filter_bytes: 64 * 1024, filter_boot_bytes: 64, max_runs, fan_in: 4 };
  const space = keptRuns(host.sql, settings);
  for (let run = 0; run < runs; run += 1) {
    // Every run spans the whole key range, so no read is settled by a run's first and last keys alone.
    space.put(`a${String(run).padStart(3, '0')}`, { run });
    space.put(`z${String(run).padStart(3, '0')}`, { run });
    space.flush();
  }
  let statements = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (...args) => { statements += 1; return exec(...args); };
  const reopened = keptRuns(host.sql, settings);
  const opened = statements;
  return { host, reopened, opened, reads: () => statements - opened };
}

test('a store with a merge backlog answers an absent key from filters it loaded at start', () => {
  for (const runs of [12, 48]) {
    const { host, reopened, reads } = store(runs, { max_runs: 8 });
    assert.equal(reopened.get('m-absent'), undefined);
    assert.equal(reads(), 0, `${runs} runs: an absent key probes no run by SQL`);
    assert.deepEqual(reopened.get('a005'), { run: 5 });
    host.db.close();
  }
});

test('a store within max_runs keeps the bounded start and probes left-out filters by selected bytes', () => {
  const { host, reopened, reads } = store(12, { max_runs: 24 });
  assert.equal(reopened.get('m-absent'), undefined);
  assert.ok(reads() > 0, 'filters past filter_boot_bytes are asked by SQL');
  host.db.close();
});
