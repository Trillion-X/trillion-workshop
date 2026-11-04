import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

const withinBudget = space => {
  const held = space.held();
  assert.ok(held.filter_bytes + held.merge_filter_bytes <= space.settings.filter_bytes,
    `${held.filter_bytes} resident + ${held.merge_filter_bytes} merge bytes exceed ${space.settings.filter_bytes}`);
};

test('repeated warm write-outs share the cold-open filter cap while keeping persisted filters', () => {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, {
    transaction: host.transaction, prefix: 'filter_cap', filter_bytes: 128,
  });
  let space = open();
  for (let index = 0; index < 12; index += 1) {
    space.put(`key${String(index).padStart(2, '0')}`, { index });
    space.flush();
    withinBudget(space);
  }
  assert.equal(space.held().filter_bytes, 128, 'only the newest two 64-byte filters stay resident');
  const rows = [...host.sql.exec('SELECT filter_bits FROM filter_cap_runs')];
  assert.equal(rows.length, 12);
  assert.ok(rows.every(row => row.filter_bits === 512), 'evicted filters are still persisted');
  space = open();
  withinBudget(space);
  for (let index = 0; index < 12; index += 1) {
    const key = `key${String(index).padStart(2, '0')}`;
    assert.deepEqual(space.get(key), { index });
    assert.equal(space.get(`${key}\u0000`), undefined);
  }
  host.db.close();
});

test('a fresh filter larger than its entire cap is omitted without losing records or tombstones', () => {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, {
    transaction: host.transaction, prefix: 'filter_oversized', filter_bytes: 32,
  });
  let space = open();
  space.put('a', { index: 1 });
  space.put('b', { index: 2 });
  space.flush();
  space.remove('a');
  space.flush();
  withinBudget(space);
  assert.equal(space.held().filter_bytes, 0);
  assert.ok([...host.sql.exec('SELECT filter_bits FROM filter_oversized_runs')].every(row => row.filter_bits === 0));
  assert.equal([...host.sql.exec('SELECT page FROM filter_oversized_run_1 WHERE page < 0')].length, 0);
  space = open();
  assert.equal(space.get('a'), undefined);
  assert.deepEqual(space.get('b'), { index: 2 });
  assert.equal(space.get('a\u0000'), undefined);
  host.db.close();
});

test('write-outs reserve an unfinished merge filter and recovery preserves a rolled-back flush', () => {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, {
    transaction: host.transaction, prefix: 'filter_reserved', filter_bytes: 512,
    page_bytes: 128, fan_in: 2, max_runs: 24,
  });
  let space = open();
  for (let run = 0; run < 2; run += 1) {
    for (let index = run * 12; index < (run + 1) * 12; index += 1) {
      space.put(`key${String(index).padStart(2, '0')}`, { index, text: 'x'.repeat(20) });
    }
    space.flush();
  }
  assert.equal(space.step({ max_pages: 1 }).more, true);
  assert.equal(space.held().merge_filter_bytes, 240);
  withinBudget(space);
  space.put('new-one', { index: 24 });
  space.flush();
  withinBudget(space);
  assert.equal(space.held().merge_filter_bytes, 240, 'a write-out does not take the active merge reservation');
  space.put('new-two', { index: 25 });
  const exec = host.sql.exec.bind(host.sql);
  let fail = true;
  host.sql.exec = (query, ...params) => {
    if (fail && query.startsWith('INSERT INTO filter_reserved_runs')) {
      fail = false;
      throw new Error('injected catalog write failure');
    }
    return exec(query, ...params);
  };
  assert.throws(() => space.flush(), /injected catalog write failure/);
  withinBudget(space);
  assert.deepEqual(space.get('new-two'), { index: 25 }, 'the failed write-out retains its memtable');
  space.reloadCatalog();
  space.flush();
  withinBudget(space);
  space = open();
  for (let turns = 0; space.mergeDue(); turns += 1) {
    assert.ok(turns < 100, 'the cold merge finishes through bounded turns');
    space.step({ max_pages: 1 });
    withinBudget(space);
  }
  space = open();
  withinBudget(space);
  for (let index = 0; index < 24; index += 1) {
    assert.deepEqual(space.get(`key${String(index).padStart(2, '0')}`), { index, text: 'x'.repeat(20) });
  }
  assert.deepEqual(space.get('new-one'), { index: 24 });
  assert.deepEqual(space.get('new-two'), { index: 25 });
  host.db.close();
});
