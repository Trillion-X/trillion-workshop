// test/kept-runs-filter-reads-per-lookup.test.mjs
//
// A blocked filter keeps its membership rows in its run's table (negative pages), and a point lookup reads one such row
// per run whose range covers the key. Blocked filters stay out of the in-process budget (2026-10-17: Sam Example's 15 blocked
// filters hold 15.7 MB against a 7.4 MB share of filter_bytes), so each absent lookup reads its rows from SQLite. This
// pins that cost: no more filter-row statements per absent lookup than there are covering blocked runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

// Every query that reads a filter row (a negative page of some run table), counted once per statement.
const FILTER_ROW_READ = /_run_\d+ WHERE page = (\?|-)/;

function bookOf(runCount) {
  const host = sqliteHost(':memory:');
  const exec = host.sql.exec.bind(host.sql);
  const counted = { lookupStatements: 0, counting: false };
  host.sql.exec = (query, ...params) => {
    if (counted.counting && FILTER_ROW_READ.test(query)) counted.lookupStatements += 1;
    return exec(query, ...params);
  };
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'book', page_bytes: 2048, memtable_bytes: 1 << 20,
    cache_bytes: 64 * 1024, filter_bytes: 1, fill_pages: 512 });
  // Every run holds keys spread over the whole key space (run r holds r, r + runCount, ...), so each run's range covers
  // every lookup and each absent key asks every run.
  const present = [];
  for (let run = 0; run < runCount; run += 1) {
    for (let at = 0; at < 60; at += 1) {
      const key = `k${String(run + runCount * at).padStart(5, '0')}`;
      present.push(key);
      space.put(key, { run, at, text: 'v'.repeat(40) });
    }
    space.flush();
  }
  for (let at = 0; at < 60; at += 1) space.fillFilters({ max_pages: 512 });
  return { space, counted, present };
}

test('an absent lookup reads at most one filter row per covering blocked run, however many runs the book holds', () => {
  const perLookup = new Map();
  for (const runCount of [4, 40]) {
    const { space, counted, present } = bookOf(runCount);
    const blocked = space.held().runs.filter(run => run.filter === 'blocks');
    assert.equal(blocked.length, runCount, 'every run holds a blocked filter');
    // Absent keys inside every run's range: every run covers each lookup.
    const absent = present.map(key => `${key}x`);
    counted.counting = true;
    for (const key of absent) assert.equal(space.get(key), undefined, `${key} is absent`);
    counted.counting = false;
    perLookup.set(runCount, counted.lookupStatements / absent.length);
    assert.ok(perLookup.get(runCount) <= blocked.length, `${perLookup.get(runCount)} filter-row statements per absent lookup in a ${runCount}-run book, at most ${blocked.length} covering blocked runs`);
    for (const key of present.filter((_, at) => at % 17 === 0)) assert.equal(space.get(key).text, 'v'.repeat(40));
  }
  // The 40-run book outgrows the 64 KB page cache, so its lookups do read filter rows; the bound above is then tested for real.
  assert.ok(perLookup.get(40) > 0, 'the 40-run book reads filter rows');
});
