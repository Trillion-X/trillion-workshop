import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

// A range that opens values reads each winning page once per call, not once per winner that changes run. With the
// page cache off, a 32-winner range over 20 interleaved runs must read the same number of pages at 2,000 keys and at
// 8,000 keys (N vs 4N): the reads bound by the window and its runs, never by the keys behind it.
function fixture(keys, runs) {
  const host = sqliteHost(':memory:');
  let bodies = 0;
  const sql = { exec: (query, ...params) => { if (/SELECT body FROM \S+ WHERE page = \?/.test(query)) bodies += 1; return host.sql.exec(query, ...params); }, get databaseSize() { return 0; } };
  const space = keptRuns(sql, { transaction: fn => host.transaction(fn), prefix: 'bounded', page_bytes: 128, big_bytes: 96,
    memtable_bytes: 1 << 30, fan_in: 1000, max_runs: 100000, compaction_debt_min_bytes: 1 << 30, cache_bytes: 0 });
  for (let r = 0; r < runs; r += 1) {
    for (let at = r; at < keys; at += runs) space.put(`k${String(at).padStart(5, '0')}`, { at, text: 'x'.repeat(60) });
    space.flush();
  }
  return { space, reads: () => bodies, reset: () => { bodies = 0; } };
}

test('a value range over interleaved runs reads a bounded number of pages at N and 4N keys', () => {
  const runs = 20, limit = 32;
  const small = fixture(2000, runs), large = fixture(8000, runs);
  small.reset(); large.reset();
  const a = small.space.range('k00000', 'k99999', { limit, readValue: () => true });
  const b = large.space.range('k00000', 'k99999', { limit, readValue: () => true });
  assert.equal(a.length, limit);
  assert.deepEqual(a.map(([key]) => key), b.map(([key]) => key).slice(0, limit), 'the same winners in order');
  assert.deepEqual(a[0][1], { at: 0, text: 'x'.repeat(60) }, 'the winning value is read');
  assert.equal(small.reads(), large.reads(), 'four times the keys read the same pages');
  assert.ok(large.reads() <= runs, `read ${large.reads()} pages for ${limit} winners across ${runs} runs`);
});
