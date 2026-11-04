// test/kept-runs-fill-filter.test.mjs
//
// A run published without a membership filter (a merge resumed after a restart, or one over the resident filter budget)
// is given a blocked filter as idle work (parts/record-log/do-work/kept-runs.mjs fillFilters), so an absent key costs at
// most one small filter row instead of a halving over the run's pages. On the owner's store on 2026-10-10 a 2.2 GB run of
// 50,240 pages had no filter, and every new id written (each action receipt, each index key) read about 19 rows probing
// it: POST /executions read about 245 rows a call. This holds the answers the same before, during and after the fill,
// across a restart in the middle of it, and fails when an absent key still searches the run's pages once it is filled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

const key = index => `k${String(index).padStart(5, '0')}`;

test('a run with no filter is given one in bounded, resumable steps, and absent keys stop searching its pages', () => {
  const host = sqliteHost(':memory:');
  // Published with no filter at all: no filter memory to give it.
  const bare = keptRuns(host.sql, { transaction: host.transaction, prefix: 'fill', page_bytes: 256, filter_bytes: 0 });
  for (let index = 0; index < 3000; index += 1) bare.put(key(index), { index, text: 'x'.repeat(30) });
  bare.flush();
  bare.remove(key(1));
  bare.put(key(3000), { index: 3000, text: 'new' });
  bare.flush();
  assert.deepEqual([...host.sql.exec('SELECT filter_bits FROM fill_runs')].map(row => row.filter_bits), [0, 0]);

  const exec = host.sql.exec.bind(host.sql);
  let halvings = 0;
  let filterRows = 0;
  let pagesFilled = 0;
  host.sql.exec = (query, ...params) => {
    if (query.includes('WITH RECURSIVE halving')) halvings += 1;
    if (/SELECT body FROM fill_run_\d+ WHERE page = \?/.test(query) && params[0] < 0) filterRows += 1;
    if (/WHERE page >= \? AND page < \? ORDER BY page/.test(query) && query.includes('fill_run_')) pagesFilled += params[1] - params[0];
    return exec(query, ...params);
  };
  const open = () => keptRuns(host.sql, { transaction: host.transaction, prefix: 'fill', page_bytes: 256, fill_pages: 40, fill_save_pages: 80 });
  const absent = Array.from({ length: 200 }, (_, at) => `${key(at * 7)}~`);
  const check = space => {
    assert.equal(space.get(key(1)), undefined, 'a tombstone in the newer run still hides the older value');
    assert.deepEqual(space.get(key(3000)), { index: 3000, text: 'new' });
    for (let index = 0; index < 3000; index += 97) if (index !== 1) assert.deepEqual(space.get(key(index)), { index, text: 'x'.repeat(30) });
    for (const missing of absent) assert.equal(space.get(missing), undefined);
  };

  let space = open();
  const pages = [...host.sql.exec('SELECT pages FROM fill_runs')].reduce((sum, row) => sum + row.pages, 0);
  halvings = 0;
  check(space);
  const before = halvings;
  assert.ok(before >= absent.length, `before the fill each absent key searched the run's pages (${before} searches)`);
  assert.equal(space.fillDue(), true);

  // Fill part of the way, then restart: the fill continues from its last save, never from the first page.
  for (let turn = 0; turn < 3; turn += 1) space.fillFilters();
  check(space);
  const saved = space.meta.get('filter_fill');
  assert.ok(saved && saved.page > 0, 'the fill saved how far it reached');
  space = open();
  for (let turns = 0; space.fillDue(); turns += 1) {
    assert.ok(turns < 200, 'the fill finishes');
    const step = space.fillFilters();
    assert.ok(step.pages <= 40, 'each step reads a bounded number of pages');
    check(space);
  }
  assert.ok(pagesFilled <= pages + 80 + 40, `the restart repeated at most the pages since the last save (${pagesFilled} read for ${pages})`);
  // A one-page run is answered from its one page without a search, so only the run of many pages is filled.
  assert.deepEqual([...host.sql.exec('SELECT pages > 1 AS many, filter_bits < 0 AS filtered FROM fill_runs ORDER BY age')].map(row => [row.many, row.filtered]), [[1, 1], [0, 0]]);
  assert.equal(space.meta.get('filter_fill'), undefined);

  for (const reopened of [space, open()]) {
    halvings = 0;
    filterRows = 0;
    check(reopened);
    console.log(`absent keys: ${before} page searches before the fill, ${halvings} after; ${filterRows} filter rows read`);
    assert.ok(halvings <= 40, `after the fill an absent key rarely searches pages (${halvings} searches for ${before} before)`);
    assert.ok(filterRows <= 16, `filter rows are read once each and kept (${filterRows} reads)`);
    assert.equal(reopened.fillDue(), false);
  }
});

test('a run written with a resident filter is never filled again', () => {
  const host = sqliteHost(':memory:');
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'kept', page_bytes: 256 });
  for (let index = 0; index < 500; index += 1) space.put(key(index), { index });
  space.flush();
  assert.equal(space.fillDue(), false);
  assert.deepEqual(space.fillFilters(), { filled: false, more: false, pages: 0 });
  assert.ok([...host.sql.exec('SELECT filter_bits FROM kept_runs')][0].filter_bits > 0);
});

test('a fill saves its progress every fill_pages pages though the run has fewer pages than fill_save_pages, so a restart keeps it', () => {
  const host = sqliteHost(':memory:');
  const bare = keptRuns(host.sql, { transaction: host.transaction, prefix: 'fill', page_bytes: 256, filter_bytes: 0 });
  for (let index = 0; index < 3000; index += 1) bare.put(key(index), { index, text: 'x'.repeat(30) });
  bare.flush();
  const pages = [...host.sql.exec('SELECT pages FROM fill_runs')][0].pages;
  const open = () => keptRuns(host.sql, { transaction: host.transaction, prefix: 'fill', page_bytes: 256, fill_pages: 40 });
  let space = open();
  assert.ok(pages > 120 && pages < 8192, `the run has ${pages} pages, fewer than the default fill_save_pages`);
  for (let turn = 0; turn < 3; turn += 1) space.fillFilters({ max_pages: 20 });
  const saved = space.meta.get('filter_fill');
  assert.ok(saved && saved.page >= 40, `progress was saved before the run was done (${saved?.page ?? 'nothing'})`);
  space = open();
  const step = space.fillFilters({ max_pages: 20 });
  assert.ok(step.pages <= 20);
  assert.ok(space.meta.get('filter_fill').page >= saved.page, 'the restart continued from the save');
  for (let turns = 0; space.fillDue(); turns += 1) { assert.ok(turns < 200); space.fillFilters({ max_pages: 20 }); }
  assert.equal([...host.sql.exec('SELECT filter_bits < 0 AS filtered FROM fill_runs')][0].filtered, 1);
});
