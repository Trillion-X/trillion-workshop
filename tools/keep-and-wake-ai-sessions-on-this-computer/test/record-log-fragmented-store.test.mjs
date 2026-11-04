// test/record-log-fragmented-store.test.mjs
// A store left fragmented (hundreds of small runs, no kept checksum) the way Sam Example's was on 2026-10-05 recovers by
// idle work alone, and no single wake of that work holds the store for long: every maintain() stays under a fixed
// budget while the runs merge down and the checksum is built, and reads get cheaper as it goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

// Wall time of one wake in this process; the store's own CPU limit is far above it, so a wake past it is a job that
// grows with the store instead of a bounded slice.
const WAKE_BUDGET_MS = 2000;

test('a store of 100 small runs and no checksum merges down and builds it, each wake bounded', () => {
  const host = sqliteHost(':memory:');
  let store = recordLogStore(host.sql, { transaction: host.transaction });
  const records = 20000;
  for (let n = 0; n < records; n += 1) {
    store.write([{ id: `rec:${String(n).padStart(8, '0')}`, type: n % 3 ? 'note' : 'job', value: { n, text: 'w'.repeat(120) } }]);
    if ((n + 1) % 200 === 0) store.checkpoint();
  }
  const meta = keptRuns(host.sql, { transaction: host.transaction, prefix: 'record_keys' }).meta;
  meta.set('covered', meta.get('covered').at);
  store = recordLogStore(host.sql, { transaction: host.transaction });
  assert.equal(store.held().keys.runs.length, 100);
  assert.equal(store.checksum({ build: false }).root, null);
  let wakes = 0;
  let worst = 0;
  for (;;) {
    const started = performance.now();
    const { more } = store.maintain();
    worst = Math.max(worst, performance.now() - started);
    wakes += 1;
    assert.ok(wakes < 2000, 'the work ends');
    if (!more) break;
  }
  assert.ok(worst < WAKE_BUDGET_MS, `the longest wake took ${Math.round(worst)} ms`);
  // Size-tier merging leaves bounded read fan-out without forcing mixed-size runs into one fan-in: doing that
  // copied a young large run whole at every later write-out.
  assert.ok(store.held().keys.runs.length <= 7, `${store.held().keys.runs.length} runs left`);
  assert.notEqual(store.checksum({ build: false }).root, null, 'the checksum is built');
  assert.equal(store.ids('job').length, Math.ceil(records / 3));
  assert.equal(store.read('rec:00012345').n, 12345);
});
