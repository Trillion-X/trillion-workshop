// test/kept-runs-page-layout.test.mjs
//
// A kept run's page keeps its keys beside its offsets in its header line (parts/record-log/do-work/kept-runs.mjs). The
// layout that wrote a page is stated by its first character: `~` for the layout that keeps each suffix unquoted (only
// NUL, the separators, newlines and lone surrogates are escaped), `{` for the JSON array of suffixes that pages written
// before it hold. Every reader decodes both, a merge writes only `~`, and held() counts the pages still in `{`.
// These tests write keys that stress the escapes and check every read path on the new layout, then read pages the
// earlier code wrote (test/fixtures/kept-runs-before-directory-reader.mjs, a frozen copy of it) through every read path
// and watch a merge rewrite them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';
import { keptRuns as keptRunsBefore } from './fixtures/kept-runs-before-directory-reader.mjs';

const SETTINGS = { page_bytes: 256, memtable_bytes: 1 << 30, fan_in: 4, max_runs: 4, compaction_debt_min_bytes: 1 };
// Keys whose suffixes hold every character the escapes name, quotes and backslashes JSON would escape, non-ASCII, astral
// characters and lone surrogates, beside ordinary keys: the byte-exact round trip has to hold for all of them.
const PARTS = ['a', 'é', '\u{1F600}', '"', '\\', '\u0000', '\u0001', '\u0002', '\u0003', '\n', '\ud800', '\udc00', '😀', ' ', 'message:x'];
const keyOf = n => {
  const parts = [];
  for (let at = 0; at < 4; at += 1) parts.push(PARTS[(n * 7 + at * 5 + Math.floor(n / 3)) % PARTS.length]);
  return `${parts.join('')}\u0000${String(n).padStart(4, '0')}\u0000${n % 3 === 0 ? '"value"' : 'v'}`;
};
// Keys sharing a prefix of 70 characters take the array form of the prefix lengths, the others the one-character form.
const LONG = 'shared-prefix-'.repeat(6);
const KEYS = [...new Set([...Array.from({ length: 240 }, (_, n) => keyOf(n)), ...Array.from({ length: 40 }, (_, n) => LONG + '\u0000' + String(n))])].sort();
const valueOf = key => ({ key: key.length, text: `value for ${KEYS.indexOf(key)}` });

function fullRange(space, { reverse = false, keysOnly = false } = {}) {
  return space.range('', '\uffff\uffff', { reverse, keys_only: keysOnly }).map(([key]) => key);
}

function runTables(space, prefix) {
  return space.held().runs.map(run => ({ run: run.run, pages: run.pages, table: `${prefix}_run_${run.run}` }));
}

test('keys with escapes, quotes, backslashes, non-ASCII and lone surrogates read back byte for byte from pages in the new layout', () => {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, { transaction: host.transaction, prefix: 'lay', ...SETTINGS });
  let space = open();
  for (const key of KEYS) space.put(key, valueOf(key));
  space.flush();
  // A second flush and a merge put the keys through the writer again (every page a merge writes is the new layout).
  for (const key of KEYS.filter((_, at) => at % 5 === 0)) space.put(key, { key: key.length, text: 'changed' });
  space.flush();
  for (let step = 0; step < 200 && space.step({ max_pages: 64 }).more; step += 1);
  space = open();
  for (const key of KEYS) {
    const expected = KEYS.indexOf(key) % 5 === 0 ? { key: key.length, text: 'changed' } : valueOf(key);
    assert.deepEqual(space.get(key), expected, `get ${JSON.stringify(key)}`);
  }
  assert.deepEqual(fullRange(space), KEYS, 'forward range returns every key exactly');
  assert.deepEqual(fullRange(space, { reverse: true }), [...KEYS].reverse(), 'reverse range returns every key exactly');
  assert.deepEqual(fullRange(space, { keysOnly: true }), KEYS, 'keys-only range returns every key exactly');
  for (const { table, pages } of runTables(space, 'lay')) {
    const rows = host.sql.exec(`SELECT page, body FROM ${table} WHERE page >= 0`).toArray();
    assert.equal(rows.length, pages, `${table} holds every page it counts`);
    for (const row of rows) assert.equal(row.body[0], '~', `${table} page ${row.page} is written in the new layout`);
  }
  assert.equal(space.held().old_layout_pages, 0, 'nothing is left in the earlier layout');
});

test('pages the earlier layout wrote read through every path, and a merge rewrites them in the new layout', () => {
  const host = sqliteHost(':memory:');
  const before = keptRunsBefore(host.sql, { transaction: host.transaction, prefix: 'lay', ...SETTINGS });
  for (let round = 0; round < 6; round += 1) {
    for (const key of KEYS.filter((_, at) => at % 6 === round)) before.put(key, valueOf(key));
    before.flush();
  }
  const pagesBefore = runTables(before, 'lay').reduce((sum, run) => sum + run.pages, 0);
  assert.ok(pagesBefore > 6, 'the earlier layout wrote several runs of several pages');
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'lay', ...SETTINGS });
  for (const key of KEYS) assert.deepEqual(space.get(key), valueOf(key), `point read ${JSON.stringify(key)} from an earlier page`);
  assert.deepEqual(fullRange(space), KEYS, 'forward range over earlier pages');
  assert.deepEqual(fullRange(space, { reverse: true }), [...KEYS].reverse(), 'reverse range over earlier pages');
  assert.deepEqual(fullRange(space, { keysOnly: true }), KEYS, 'keys-only range over earlier pages');
  for (const key of KEYS.filter((_, at) => at % 2 === 0)) assert.deepEqual(space.get(key), valueOf(key));
  assert.equal(space.held().old_layout_pages, pagesBefore, 'every page written before is counted as the earlier layout');
  space.fillFilters({ max_pages: 10_000 });
  for (const key of KEYS) assert.deepEqual(space.get(key), valueOf(key), `read after filters ${JSON.stringify(key)}`);
  // Overwritten values due a complete fold, so the merge takes every run, the earlier layout's too.
  for (const key of KEYS.filter((_, at) => at % 4 === 0)) space.put(key, valueOf(key), undefined, 1000);
  space.flush();
  for (let step = 0; step < 500 && space.step({ max_pages: 64 }).more; step += 1);
  assert.equal(space.held().old_layout_pages, 0, 'a merge that finishes writes every page in the new layout');
  for (const key of KEYS) assert.deepEqual(space.get(key), valueOf(key), `read after the merge ${JSON.stringify(key)}`);
  assert.deepEqual(fullRange(space), KEYS, 'forward range after the merge');
  for (const { table } of runTables(space, 'lay')) {
    for (const row of host.sql.exec(`SELECT body FROM ${table} WHERE page >= 0`).toArray()) assert.equal(row.body[0], '~');
  }
});
