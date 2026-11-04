// test/record-log-write-prior-reads.test.mjs
//
// A write reads what its records held before it for all of them together (parts/record-log/do-work/record-log-store.mjs
// holdPriorStates over priorStatesOf, the reader a replay uses), not each id from every run two or three times. On the
// founder's own records (2026-10-20, 21 runs, 9 with blocked filters on disk) a tool:watch-sources run that wrote its new
// signal rows read each new id's entry from every run once to build its change, again to check it and twice more to
// apply it, one statement a run each, and stopped at its 4,000-statement bound; a fixture of the same shape spent 20,821
// of 23,118 statements so. This holds a cold write of new, changed and removed records to the same answers as a store
// that never left memory, and its run statements to about R * ceil(N / 64) for N records over R runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const RUNS = 8;
const runs = { filter_bytes: 1, memtable_bytes: 64 * 1024, cache_bytes: 1024, max_runs: 1000, fan_in: 1000 };

// RUNS runs of records whose ids interleave over the whole id space, each run's filter a blocked one on disk.
function seeded() {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction, runs });
  for (let run = 0; run < RUNS; run += 1) {
    store.write(Array.from({ length: 300 }, (_, at) => ({ id: `note:${String(at * RUNS + run).padStart(5, '0')}`, type: 'note', value: { run, at, text: 'v'.repeat(80) } })));
    store.checkpoint();
  }
  for (let wake = 0; wake < 200; wake += 1) store.maintain({ max_pages: 0 });
  assert.ok(store.held().keys.runs.filter(run => run.filter === 'blocks').length >= RUNS, JSON.stringify(store.held().keys.runs));
  return host;
}

// 100 new records between the kept ones, 20 changed and 10 removed, in one write.
const change = [
  ...Array.from({ length: 100 }, (_, at) => ({ id: `note:${String(at * 17).padStart(5, '0')}x`, type: 'note', value: { fresh: at } })),
  ...Array.from({ length: 20 }, (_, at) => ({ id: `note:${String(at * 29).padStart(5, '0')}`, type: 'note', value: { changed: at } })),
  ...Array.from({ length: 10 }, (_, at) => ({ id: `note:${String(at * 31 + 3).padStart(5, '0')}`, type: 'note', value: null })),
];

test('a cold write of new, changed and removed records reads their prior states together and answers as a warm store', () => {
  const warmHost = seeded();
  const warm = recordLogStore(warmHost.sql, { transaction: warmHost.transaction, runs });
  const warmAnswer = warm.write(change);

  const host = seeded();
  const exec = host.sql.exec.bind(host.sql);
  let statements = 0, counting = false;
  host.sql.exec = (query, ...params) => { if (counting && /record_keys_run_\d+/.test(query)) statements += 1; return exec(query, ...params); };
  const cold = recordLogStore(host.sql, { transaction: host.transaction, runs });
  cold.read('note:00000');
  counting = true;
  const answer = cold.write(change);
  counting = false;

  assert.deepEqual([...answer.previous_types].sort(), [...warmAnswer.previous_types].sort(), 'the same records are named as replacing what they held');
  assert.deepEqual(answer.written.sort(), warmAnswer.written.sort());
  const ids = [...new Set([...change.map(record => record.id), 'note:00001', 'note:02399'])];
  for (const id of ids) assert.deepEqual(cold.read(id), warm.read(id), id);
  const reopened = recordLogStore(host.sql, { transaction: host.transaction, runs });
  for (const id of ids) assert.deepEqual(reopened.read(id), warm.read(id), `${id} after a restart`);
  const bound = RUNS * Math.ceil(change.length / 64) * 8;
  assert.ok(statements <= bound, `a write of ${change.length} records over ${RUNS} blocked runs read the runs in ${statements} statements, at most ${bound}`);
});
