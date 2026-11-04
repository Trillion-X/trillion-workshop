import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

test('a cold merge resumes without replaying its output, even across repeated restarts', () => {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, {
    transaction: host.transaction, prefix: 'replay', page_bytes: 128, memtable_bytes: 4096,
    fan_in: 2, max_runs: 2,
  });
  let space = open();
  for (let index = 0; index < 240; index += 1) space.put(`k${String(index).padStart(4, '0')}`, { index, text: 'x'.repeat(45) });
  space.flush();
  for (let index = 240; index < 480; index += 1) space.put(`k${String(index).padStart(4, '0')}`, { index, text: 'y'.repeat(45) });
  space.flush();
  assert.equal(space.step({ max_pages: 64 }).pages, 64);
  const merge = space.meta.get('merge');
  assert.equal(merge.pages, 64);

  const exec = host.sql.exec.bind(host.sql);
  let outputReads = 0;
  let filterWrites = 0;
  let failOutputPage = true;
  host.sql.exec = (query, ...params) => {
    // Page bodies only: opening the store reads the first key of each run's first page.
    if (query.includes(`SELECT body FROM replay_run_${merge.output} WHERE page = ?`)) outputReads += 1;
    if (query.startsWith(`INSERT INTO replay_run_${merge.output} (page,`) && params[0] < 0) filterWrites += 1;
    if (failOutputPage && query.startsWith(`INSERT INTO replay_run_${merge.output} (page,`) && params[0] >= 64) {
      failOutputPage = false;
      throw new Error('injected output write failure');
    }
    return exec(query, ...params);
  };
  space = open();
  assert.throws(() => space.step({ max_pages: 64 }), /injected output write failure/);
  assert.equal(space.meta.get('merge').pages, 64, 'the failed merge step rolled back its cursor');
  for (let turns = 0; ; turns += 1) {
    assert.ok(turns < 100, 'the interrupted merge must finish');
    space = open();
    if (!space.mergeDue()) break;
    assert.ok(space.step({ max_pages: 64 }).pages > 0, 'each cold turn writes new output');
  }
  assert.equal(outputReads, 0, 'cold recovery does not read completed output pages');
  assert.equal(filterWrites, 0, 'cold recovery does not rewrite a whole filter');
  const run = [...host.sql.exec('SELECT filter_bits FROM replay_runs')];
  assert.equal(run.length, 1);
  assert.equal(run[0].filter_bits, 0, 'a restarted merge publishes an exact run without an optional filter');
  for (let index = 0; index < 480; index += 1) {
    assert.deepEqual(space.get(`k${String(index).padStart(4, '0')}`), { index, text: (index < 240 ? 'x' : 'y').repeat(45) });
  }
  assert.equal(space.get('k0000\u0000'), undefined, 'a missing key within the run fence is still absent');
});

test('an uninterrupted merge keeps its membership filter', () => {
  const host = sqliteHost(':memory:');
  const space = keptRuns(host.sql, {
    transaction: host.transaction, prefix: 'warm', page_bytes: 128, memtable_bytes: 4096,
    fan_in: 2, max_runs: 2,
  });
  space.put('a', { text: 'first' });
  space.flush();
  space.put('b', { text: 'second' });
  space.flush();
  while (space.mergeDue()) space.step({ max_pages: 1 });
  const rows = [...host.sql.exec('SELECT filter_bits FROM warm_runs')];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].filter_bits > 0);
  assert.deepEqual(space.get('a'), { text: 'first' });
  assert.deepEqual(space.get('b'), { text: 'second' });
});

test('a stage deadline checkpoints a partial merge and resumes after a cold reopen', () => {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, {
    transaction: host.transaction, prefix: 'deadline', page_bytes: 128, memtable_bytes: 4096,
    fan_in: 2, max_runs: 2,
  });
  let space = open();
  for (let run = 0; run < 2; run += 1) {
    for (let index = run * 240; index < (run + 1) * 240; index += 1) {
      space.put(`k${String(index).padStart(4, '0')}`, { index, text: 'x'.repeat(45) });
    }
    space.flush();
  }
  const first = space.step({ max_pages: 256, hasTime: () => false });
  assert.equal(first.more, true);
  assert.ok(space.meta.get('merge').after?.startsWith('k'), 'the input cursor is kept');
  assert.ok(first.pages <= 65, `${first.pages} pages were written before yielding`);
  space = open();
  for (let turns = 0; space.mergeDue(); turns += 1) {
    assert.ok(turns < 100, 'the merge must finish after the clock resumes');
    space.step({ max_pages: 64 });
  }
  for (let index = 0; index < 480; index += 1) {
    assert.deepEqual(space.get(`k${String(index).padStart(4, '0')}`), { index, text: 'x'.repeat(45) });
  }
});

test('a tombstone-only turn saves its input cursor and bounds reads across cold restarts and rollback', () => {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, {
    transaction: host.transaction, prefix: 'deleted', page_bytes: 512,
    memtable_bytes: 1_000_000, fan_in: 4, max_runs: 4,
  });
  let space = open();
  for (let run = 0; run < 4; run += 1) {
    for (let index = 0; index < 2_000; index += 1) space.remove(`k${String(index).padStart(4, '0')}`);
    if (run === 0) space.put('z-live', { value: 'kept' });
    space.flush();
  }
  const originalExec = host.sql.exec.bind(host.sql);
  let inputPageReads = 0;
  let failCheckpoint = false;
  host.sql.exec = (query, ...params) => {
    if (query.startsWith('SELECT body FROM deleted_run_') && query.includes('WHERE page = ?')) inputPageReads += 1;
    if (failCheckpoint && query.startsWith('INSERT INTO deleted_meta') && params[0] === 'merge') {
      failCheckpoint = false;
      throw new Error('injected merge checkpoint failure');
    }
    return originalExec(query, ...params);
  };
  inputPageReads = 0;
  const first = space.step({ max_pages: 1 });
  assert.equal(first.pages, 0, 'deleting keys need not write an output page');
  assert.ok(inputPageReads <= 11, `one turn read ${inputPageReads} input pages`);
  const afterFirst = space.meta.get('merge').after;
  assert.ok(afterFirst?.startsWith('k'), 'a zero-output turn advances the durable cursor');

  space = open();
  failCheckpoint = true;
  assert.throws(() => space.step({ max_pages: 1 }), /injected merge checkpoint failure/);
  assert.equal(space.meta.get('merge').after, afterFirst, 'a failed checkpoint rolls back its cursor');

  let zeroOutputTurns = 1;
  for (let turns = 0; space.mergeDue(); turns += 1) {
    assert.ok(turns < 200, 'the tombstone merge must finish through bounded turns');
    space = open();
    inputPageReads = 0;
    const result = space.step({ max_pages: 1 });
    assert.ok(inputPageReads <= 11, `turn ${turns} read ${inputPageReads} input pages`);
    if (result.pages === 0) zeroOutputTurns += 1;
  }
  assert.ok(zeroOutputTurns > 1, 'multiple zero-output turns make durable progress');
  space = open();
  assert.deepEqual(space.get('z-live'), { value: 'kept' });
  for (const index of [0, 999, 1_999]) assert.equal(space.get(`k${String(index).padStart(4, '0')}`), undefined);
  assert.equal([...host.sql.exec('SELECT run FROM deleted_runs')].length, 1);
});

test('a fresh merge omits its optional filter when resident filters reach their memory budget', () => {
  const host = sqliteHost(':memory:');
  const space = keptRuns(host.sql, {
    transaction: host.transaction, prefix: 'smallfilter', page_bytes: 128,
    memtable_bytes: 4096, fan_in: 2, max_runs: 2, filter_bytes: 1,
  });
  space.put('a', { value: 1 });
  space.flush();
  space.put('b', { value: 2 });
  space.flush();
  while (space.mergeDue()) space.step({ max_pages: 1 });
  assert.deepEqual([...host.sql.exec('SELECT filter_bits FROM smallfilter_runs')].map(row => row.filter_bits), [0]);
  assert.deepEqual(space.get('a'), { value: 1 });
  assert.deepEqual(space.get('b'), { value: 2 });
  assert.equal(space.get('a\u0000'), undefined);
});
