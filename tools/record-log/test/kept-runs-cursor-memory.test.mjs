import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Measure inside SQLite reads while all range sources are still alive. Counting the
// LRU after range returns misses pages pinned by cursor closures outside that LRU.
// Each child owns one in-memory database and a fixed one-row answer. Wide pages
// contain unrelated values, not large requested output.
const probe = `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { keptRuns } from ${JSON.stringify(new URL(import.meta.resolve('../do-work/kept-runs.mjs')).href)};
const db = new DatabaseSync(':memory:');
let measuring = false, baseline = 0, peak = 0, bodyReads = 0, heapPeak = 0, heapBase = 0;
const sql = { exec(query,...params) {
  if (measuring && /SELECT.*(?:body|sought).*FROM cursor_run_/s.test(query)) {
    global.gc(); const usage=process.memoryUsage();
    peak = Math.max(peak,usage.heapUsed+usage.external-baseline);
    heapPeak=Math.max(heapPeak,usage.heapUsed-heapBase); bodyReads++;
  }
  const rows = db.prepare(query).all(...params);
  return { toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]() };
} };
const options = { prefix:'cursor',page_bytes:128*1024,big_bytes:1024*1024,
  memtable_bytes:2*1024*1024,cache_bytes:0,filter_bytes:0,max_runs:1000 };
let space = keptRuns(sql,options);
const runs = Number(process.argv[1]);
for (let run=0;run<runs;run++) {
  space.put('a',{answer:run});
  space.put('m',{unused:(String(run).padStart(5,'0')+'-').repeat(8500)});
  space.put('n',{unused:(String(run).padStart(5,'0')+'+').repeat(8500)});
  space.put('z',{answer:run}); space.flush();
}
space = keptRuns(sql,options);
global.gc(); const initial=process.memoryUsage(); baseline=initial.heapUsed+initial.external; heapBase=initial.heapUsed; measuring=true;
const answer=space.range('a','zz',{limit:1}); measuring=false;
assert.deepEqual(answer,[['a',{answer:runs-1}]]);
console.log(JSON.stringify({runs,peak,heapPeak,bodyReads,answer,cacheBytes:space.held().cache_bytes}));
db.close();
`;

function measured(runs) {
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe, String(runs)],
    { encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}

test('tiny range output does not pin one decoded page per overlapping run outside the LRU', { timeout: 180000 }, () => {
  const small=measured(16), large=measured(64);
  console.log('Node actual SQLite range live-source heap plus external strings after GC',JSON.stringify({small,large}));
  assert.equal(small.cacheBytes,0); assert.equal(large.cacheBytes,0);
  assert.ok(large.bodyReads>=64,'all overlapping sources were contacted');
  assert.ok(large.peak-small.peak < 2*1024*1024,
    '48 extra overlapping 102KiB pages retained '+(large.peak-small.peak)+' extra heap bytes');
});
