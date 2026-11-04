// test/kept-runs-get-many.test.mjs
//
// getMany(keys) answers what get(key) answers for every key (parts/record-log/do-work/kept-runs.mjs), and asks each run
// once for all the keys together. A blocked filter keeps its membership rows in its run's table, so a lookup of one key
// reads one filter row of each run it may be in; on the owner's own records (2026-10-20, 21 runs, 9 with blocked
// filters) a command that looked up about 400 keys read about 4,000 such rows, one statement each, and stopped at its
// statement bound. This holds getMany equal to get over random keys across runs with overwrites and removals (filters
// resident, blocked, stored or absent), and holds its statements at about R * ceil(N / 64) for N keys over R runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

// A small seeded generator, so a failure names the same keys again.
function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
const key = index => `k${String(index).padStart(5, '0')}`;

function counting(host) {
  const exec = host.sql.exec.bind(host.sql);
  const counted = { statements: 0, filterRows: 0, queries: [], on: false };
  host.sql.exec = (query, ...params) => {
    if (counted.on) {
      counted.statements += 1;
      counted.queries.push(query);
      if (/_run_\d+ WHERE page (= \?|IN \(SELECT value FROM json_each\(\?\)\))$/.test(query)
        && (typeof params[0] === 'number' ? params[0] < 0 : JSON.parse(params[0]).every(page => page < 0))) counted.filterRows += 1;
    }
    return exec(query, ...params);
  };
  return counted;
}

// Runs written one after another, each overwriting and removing some keys of the ones before, and some writes left in
// the memtable. filter: 'blocks' (filled as idle work), 'resident' or 'none'.
function book(filter, seed) {
  const host = sqliteHost(':memory:');
  const counted = counting(host);
  const options = { transaction: host.transaction, prefix: 'many', page_bytes: 1024, cache_bytes: 16 * 1024,
    filter_bytes: filter === 'resident' ? 8 * 1024 * 1024 : filter === 'none' ? 0 : 1, max_runs: 1000, fan_in: 1000 };
  const space = keptRuns(host.sql, options);
  const next = random(seed);
  const model = new Map();
  for (let run = 0; run < 6; run += 1) {
    for (let at = 0; at < 400; at += 1) {
      const index = Math.floor(next() * 3000);
      if (next() < 0.15) { space.remove(key(index)); model.delete(key(index)); }
      else { const value = { run, at, text: 'v'.repeat(Math.floor(next() * 60)) }; space.put(key(index), value); model.set(key(index), value); }
    }
    space.flush();
  }
  for (let at = 0; at < 200; at += 1) space.fillFilters({ max_pages: 512 });
  for (let at = 0; at < 30; at += 1) {
    const index = Math.floor(next() * 3000);
    if (at % 3 === 0) { space.remove(key(index)); model.delete(key(index)); } else { space.put(key(index), { mem: at }); model.set(key(index), { mem: at }); }
  }
  return { space, model, next };
}

// R runs of about 4,000 keys each, every run's keys spread over the whole key space, so each run's blocked filter holds
// several rows and each run's range covers every key asked. A page cache smaller than one filter row (4 KB) keeps none
// of them, as a cache of 2 MB keeps few of the thousands of rows of a run of millions of keys.
function blockedBook(runCount) {
  const host = sqliteHost(':memory:');
  const counted = counting(host);
  const options = { transaction: host.transaction, prefix: 'cost', page_bytes: 2048, memtable_bytes: 4 << 20, cache_bytes: 4096,
    filter_bytes: 1, max_runs: 1000, fan_in: 1000 };
  const space = keptRuns(host.sql, options);
  for (let run = 0; run < runCount; run += 1) {
    for (let at = 0; at < 4000; at += 1) space.put(key(run + runCount * at).padEnd(7, '0'), at);
    space.flush();
  }
  for (let at = 0; at < 400; at += 1) space.fillFilters({ max_pages: 512 });
  return { space, counted };
}

test('getMany answers what get answers for every key, across runs with overwrites, removals and the memtable', () => {
  for (const filter of ['blocks', 'resident', 'none']) {
    for (const seed of [1, 7, 42]) {
      const { space, model, next } = book(filter, seed);
      if (filter === 'blocks') assert.ok(space.held().runs.every(run => run.filter === 'blocks'), 'every run holds a blocked filter');
      const asked = Array.from({ length: 500 }, () => (next() < 0.1 ? `${key(Math.floor(next() * 3000))}x` : key(Math.floor(next() * 3200))));
      asked.push(asked[0], asked[3]);
      const many = space.getMany(asked);
      assert.deepEqual([...many.keys()], [...new Set(asked)], `${filter}/${seed}: one answer a key, in the order asked`);
      for (const name of asked) {
        assert.deepEqual(many.get(name), space.get(name), `${filter}/${seed}: ${name} as get answers it`);
        assert.deepEqual(many.get(name), model.get(name), `${filter}/${seed}: ${name} as written last`);
      }
      assert.deepEqual(space.getMany([]), new Map());
    }
  }
});

test('N keys over R blocked runs cost about R * ceil(N / 64) statements, where one get a key costs N * R filter rows', () => {
  const runs = 6;
  const { space, counted } = blockedBook(runs);
  assert.equal(space.held().runs.filter(run => run.filter === 'blocks').length, runs, 'every run holds a blocked filter');
  // Keys absent from every run, inside every run's range: each run must be asked about every one.
  const absent = Array.from({ length: 200 }, (_, at) => `${key(at * 97)}~`);
  counted.on = true;
  for (const name of absent) assert.equal(space.get(name), undefined);
  counted.on = false;
  const oneByOne = { statements: counted.statements, filterRows: counted.filterRows };

  const { space: again, counted: batched } = blockedBook(runs);
  batched.on = true;
  const many = again.getMany(absent);
  batched.on = false;
  assert.ok([...many.values()].every(value => value === undefined));
  const bound = runs * Math.ceil(absent.length / 64);
  assert.ok(oneByOne.filterRows >= absent.length * runs * 0.9, `one get a key read ${oneByOne.filterRows} filter rows for ${absent.length} keys over ${runs} runs`);
  assert.ok(batched.filterRows <= bound, `getMany read filter rows in ${batched.filterRows} statements, at most ${bound}`);
  assert.ok(batched.statements <= bound + 2 * runs, `getMany ran ${batched.statements} statements in all (one get a key: ${oneByOne.statements})`);
});

// R unfiltered runs of 4,000 keys each, interleaved over the whole key space, so every run holds pages of every part of it.
function unfilteredBook(runCount) {
  const host = sqliteHost(':memory:');
  const counted = counting(host);
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'near', page_bytes: 2048, memtable_bytes: 4 << 20, cache_bytes: 4096,
    filter_bytes: 0, max_runs: 1000, fan_in: 1000 });
  for (let run = 0; run < runCount; run += 1) {
    for (let at = 0; at < 4000; at += 1) space.put(key(run + runCount * at), { run, at });
    space.flush();
  }
  return { space, counted };
}

test('keys close together in a run are placed among its fences read once, not searched 64 at a time, and answer as get', () => {
  const runs = 6;
  const { space, counted } = unfilteredBook(runs);
  assert.equal(space.held().runs.length, runs);
  // 2,000 keys in id order, as a list's rows are read: about a twelfth of each run, its pages side by side.
  const near = Array.from({ length: 2000 }, (_, at) => key(5000 + at));
  const fenceStatements = () => counted.queries.filter(query => /SELECT page, first FROM/.test(query)).length;
  counted.on = true;
  const many = space.getMany(near);
  counted.on = false;
  for (const name of near) assert.deepEqual(many.get(name), space.get(name), name);
  const fences = fenceStatements();
  // Two searches a run (its least and greatest key) of at most four rounds, then one read of the fences between.
  assert.ok(fences <= runs * 6, `2,000 near keys over ${runs} runs read fences in ${fences} statements, at most ${runs * 6}`);

  // Keys far apart (more pages between them than keys) are searched as before, and answer as get.
  const { space: again } = unfilteredBook(runs);
  const far = Array.from({ length: 12 }, (_, at) => key(at * 1999 + 7));
  far.push('k', 'zzz', key(23999));
  const spread = again.getMany(far);
  for (const name of far) assert.deepEqual(spread.get(name), again.get(name), name);
  // Strict and from-bounded probes, through ranges: every window answers as the key alone.
  const windows = again.ranges(near.slice(0, 40).map(name => ({ lo: name, hi: `${name}\u0000` })));
  for (const [name, value] of windows) assert.deepEqual(value, again.get(name), name);
});

// 2026-10-21: one ten-row list write in the owner's own records asked for the same execution record, not kept yet, 42
// times, each a membership read of all 25 runs. A key found in no run and not in the memtable is answered absent again
// without reading, until a write of it (the memtable) or a catalog read; a removed key the same.
test('a key found in no run is answered absent again without reading, until it is written', () => {
  const runs = 6;
  const { space, counted } = blockedBook(runs);
  const missing = `${key(97)}~`, kept = key(runs * 5).padEnd(7, '0');
  assert.equal(space.get(missing), undefined);
  assert.equal(space.getMany([missing, `${key(98)}~`]).get(missing), undefined);
  counted.on = true;
  for (let at = 0; at < 40; at += 1) assert.equal(space.get(missing), undefined);
  assert.equal(space.getMany([missing, `${key(98)}~`]).size, 2);
  counted.on = false;
  assert.equal(counted.statements, 0, `asked again, an absent key read nothing: ${counted.queries.slice(0, 3)}`);
  // Written, it is found at once; removed and flushed, it is absent again, and so asked again it reads nothing.
  space.put(missing, { now: 1 });
  assert.deepEqual(space.get(missing), { now: 1 });
  assert.deepEqual(space.getMany([missing]).get(missing), { now: 1 });
  space.flush();
  assert.deepEqual(space.get(missing), { now: 1 }, 'found in the run it was written out to');
  space.remove(missing);
  space.flush();
  assert.equal(space.get(missing), undefined);
  counted.on = true; counted.statements = 0;
  assert.equal(space.get(missing), undefined);
  counted.on = false;
  assert.equal(counted.statements, 0, 'a removed key asked again reads nothing');
  // A key present all along is never taken for absent.
  assert.equal(space.get(kept), 5);
  // A catalog read again asks again.
  space.reloadCatalog();
  counted.on = true; counted.statements = 0;
  assert.equal(space.get(`${key(98)}~`), undefined);
  counted.on = false;
  assert.ok(counted.statements > 0, 'after the catalog is read again an absence is asked again');
});
