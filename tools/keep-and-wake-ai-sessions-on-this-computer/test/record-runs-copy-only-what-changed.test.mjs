// test/record-runs-copy-only-what-changed.test.mjs
// Idle work merging written runs (parts/record-log kept-runs planMerge) copies a run again only together with at
// least as many bytes written since, so what it writes grows with what changed, never with what the store holds.
// Sam Example's store on 2026-10-07 held five large runs (2,967, 8,785, 241, 6,634 and 905 pages, oldest first) and its
// idle work wrote 1.42M rows that day, the whole store about seventy times over: past seven runs the cheapest four
// adjacent ones were merged whatever their sizes, and they always held the youngest large run beside the small
// write-outs, which was then copied again every few write-outs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const small = { page_bytes: 512, memtable_bytes: 1 << 20, cache_bytes: 8192, big_bytes: 2048 };

test('small write-outs beside the live layout of large runs copy about what they wrote, not the runs beside them', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction, runs: small });
  const write = (prefix, count, size) => { for (let n = 0; n < count; n += 1) store.write([{ id: `${prefix}${String(n).padStart(5, '0')}`, type: 'note', value: { text: 'w'.repeat(size) } }]); };
  const settle = () => { while (store.maintain({ max_pages: 100000 }).more); };
  // The live layout, a fifth of its pages each, oldest first.
  for (const [at, pages] of [2967, 8785, 241, 6634, 905].entries()) { write(`base${at}-`, Math.round(pages / 5) * 2, 200); store.checkpoint(); }
  settle();
  const held = () => store.held().keys.runs;
  const baseRuns = held().length;
  let pagesWritten = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => { if (/^INSERT INTO record_keys_run_\d+ \(page,/.test(query)) pagesWritten += 1; return exec(query, ...params); };
  let seed = 11;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let mostRuns = 0;
  let writtenOut = 0;
  for (let round = 0; round < 300; round += 1) {
    write(`w${round}-`, 1 + Math.floor(random() * 12), 30 + Math.floor(random() * 270));
    const before = pagesWritten;
    store.checkpoint();
    writtenOut += pagesWritten - before;
    settle();
    mostRuns = Math.max(mostRuns, held().length);
  }
  const merged = pagesWritten - writtenOut;
  // Each merge at least doubles the run an older page sits in, so a page written out is copied about log2(store
  // pages / its pages) times over its life. Before, this wrote 68,626 pages (about 75 a page); merging any two
  // comparable runs, 5,697 (about 3.4); waiting for fan_in comparable runs, 3,457 (about 2).
  assert.ok(merged < 3 * writtenOut, `merging wrote ${merged} pages for ${writtenOut} pages written out beside ${baseRuns} runs`);
  assert.ok(mostRuns <= 24, `${mostRuns} runs at most`);
  for (let n = 0; n < 5; n += 1) assert.equal(store.read(`base${n}-00000`).text.length, 200);
});

// Write-outs come out a little larger or smaller each time. Four of them that do not nest by size (47, 52, 60 and 41
// pages, youngest first, as a seeded store held them on 2026-10-10) merged under size_ratio alone only once max_runs
// were held, so every read of a settled store probed four runs; runs of about one size (tier_spread) merge as a tier,
// and a run much larger than the small write-outs beside it still never rides along.
test('write-outs of about one size merge into one run once fan_in are held; a much larger run is not copied with them', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction, runs: small });
  const write = (prefix, count) => { for (let n = 0; n < count; n += 1) store.write([{ id: `${prefix}${String(n).padStart(5, '0')}`, type: 'note', value: { text: 'w'.repeat(200) } }]); store.checkpoint(); };
  const settle = () => { while (store.maintain({ max_pages: 100000 }).more); };
  const runs = () => store.held().keys.runs;
  // Oldest first: 41, 60, 52 and 47 pages.
  for (const [at, count] of [82, 120, 104, 94].entries()) write(`tier${at}-`, count);
  const pages = runs().map(run => run.pages).sort((a, b) => a - b);
  assert.ok(pages[3] > pages[0] * 1.2 && pages[3] < pages[0] * 1.5, `four write-outs of about one size that do not nest: ${pages.join(', ')}`);
  settle();
  assert.equal(runs().length, 1, 'they merge into one run, so a read probes one');
  // That run is now a larger tier: three small write-outs beside it wait for a fourth, and are not merged into it.
  const big = runs()[0].pages;
  for (let at = 0; at < 3; at += 1) write(`small${at}-`, 20);
  settle();
  assert.equal(runs().length, 4);
  assert.ok(runs().some(run => run.pages === big), 'the larger run is not copied with the small ones');
  write('small3-', 20);
  settle();
  assert.equal(runs().length, 2, 'the fourth small write-out completes their tier, which merges on its own');
  assert.ok(runs().some(run => run.pages === big));
  for (const prefix of ['tier0-', 'tier3-', 'small0-', 'small3-']) assert.equal(store.read(`${prefix}00000`).text.length, 200);
});
