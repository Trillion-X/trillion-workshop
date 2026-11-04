import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

const settings = { prefix: 'cleanup', page_bytes: 128, big_bytes: 32, memtable_bytes: 4096, fan_in: 2, max_runs: 2 };
const key = at => `k${String(at).padStart(4, '0')}`;
const value = (at, version) => ({ at, version, text: version.repeat(100) });
const rows = (host, query, ...params) => [...host.sql.exec(query, ...params)];
const count = (host, table) => rows(host, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;

function overlappingRuns(total = 48) {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, { transaction: host.transaction, ...settings });
  let space = open();
  for (let at = 0; at < total; at += 1) space.put(key(at), value(at, 'old'));
  space.flush();
  for (let at = 0; at < total; at += 1) space.put(key(at), value(at, 'new'));
  space.flush();
  assert.equal(count(host, 'cleanup_big'), total * 2);
  return { host, open, total, space };
}

function publishMerge({ host, open, total }) {
  let space;
  for (let turns = 0; turns < 200; turns += 1) {
    space = open();
    if (space.meta.get('merge') === undefined && count(host, 'cleanup_runs') === 1) return space;
    space.step({ max_pages: 1 });
    for (const at of [0, Math.floor(total / 2), total - 1]) assert.deepEqual(space.get(key(at)), value(at, 'new'));
  }
  assert.fail('the merge did not publish');
}

test('obsolete large values retire in bounded cleanup turns after a cold merge publish', () => {
  const fixture = overlappingRuns();
  const { host, open, total } = fixture;
  let space = publishMerge(fixture);
  assert.equal(count(host, 'cleanup_big_drops'), total, 'every older reference is queued');
  assert.equal(count(host, 'cleanup_big'), total * 2, 'publication never deletes a value before the old runs disappear');
  assert.equal(space.meta.get('big_drop_mode'), 'retire');

  let turns = 0;
  while (space.mergeDue()) {
    assert.ok(turns++ < 20, 'cleanup must finish');
    space = open();
    const before = count(host, 'cleanup_big');
    const result = space.step({ max_pages: 1 });
    assert.equal(result.pages, 0, 'cleanup writes no merge pages');
    const removed = before - count(host, 'cleanup_big');
    assert.ok(removed > 0 && removed <= 16, `deleted ${removed} large-value parts in one turn`);
    for (const at of [0, Math.floor(total / 2), total - 1]) assert.deepEqual(space.get(key(at)), value(at, 'new'));
  }
  assert.ok(turns > 1, 'cleanup ran across cold restarts');
  assert.equal(count(host, 'cleanup_big_drops'), 0);
  assert.equal(count(host, 'cleanup_big'), total);
  assert.equal(space.meta.get('big_drop_mode'), undefined);
  for (let at = 0; at < total; at += 1) assert.deepEqual(space.get(key(at)), value(at, 'new'));
});

test('a failed cleanup deletion rolls back its parts and queue, then resumes after restart', () => {
  const fixture = overlappingRuns();
  const { host, open, total } = fixture;
  publishMerge(fixture);
  const before = {
    merge: rows(host, 'SELECT value FROM cleanup_meta WHERE key = ?', 'merge'),
    runs: rows(host, 'SELECT run, pages, keys FROM cleanup_runs ORDER BY run'),
    parts: rows(host, 'SELECT ref, part FROM cleanup_big ORDER BY ref, part'),
    drops: rows(host, 'SELECT ref FROM cleanup_big_drops ORDER BY ref'),
  };
  const exec = host.sql.exec.bind(host.sql);
  let deletes = 0;
  host.sql.exec = (query, ...params) => {
    if (query.startsWith('DELETE FROM cleanup_big WHERE ref = ? AND part = ?') && ++deletes === 2) throw new Error('injected large-value delete failure');
    return exec(query, ...params);
  };
  assert.throws(() => open().step({ max_pages: 1 }), /injected large-value delete failure/);
  host.sql.exec = exec;
  assert.deepEqual(rows(host, 'SELECT value FROM cleanup_meta WHERE key = ?', 'merge'), before.merge);
  assert.deepEqual(rows(host, 'SELECT run, pages, keys FROM cleanup_runs ORDER BY run'), before.runs);
  assert.deepEqual(rows(host, 'SELECT ref, part FROM cleanup_big ORDER BY ref, part'), before.parts);
  assert.deepEqual(rows(host, 'SELECT ref FROM cleanup_big_drops ORDER BY ref'), before.drops);
  let space = open();
  for (let turns = 0; space.mergeDue(); turns += 1) {
    assert.ok(turns < 20);
    space.step({ max_pages: 1 });
    space = open();
  }
  assert.equal(count(host, 'cleanup_big'), total);
  for (let at = 0; at < total; at += 1) assert.deepEqual(space.get(key(at)), value(at, 'new'));
});

test('an abandoned merge forgets queued references without deleting a surviving run\'s values', () => {
  const { host, open, total } = overlappingRuns();
  let space = open();
  space.step({ max_pages: 1 });
  assert.ok(count(host, 'cleanup_big_drops') > 0, 'the partial merge queued obsolete references');
  const inputs = space.meta.get('merge').inputs;
  const before = count(host, 'cleanup_big');
  // Another instance removed the newer input from the catalog before this instance resumed.
  host.sql.exec('DELETE FROM cleanup_runs WHERE run = ?', inputs[0]);
  space = open();
  space.step({ max_pages: 1 });
  assert.equal(space.meta.get('big_drop_mode'), 'forget');
  for (let turns = 0; space.mergeDue(); turns += 1) {
    assert.ok(turns < 20);
    space = open();
    space.step({ max_pages: 1 });
  }
  assert.equal(count(host, 'cleanup_big_drops'), 0);
  assert.equal(count(host, 'cleanup_big'), before, 'no surviving large-value part was deleted');
  for (const at of [0, Math.floor(total / 2), total - 1]) assert.deepEqual(space.get(key(at)), value(at, 'old'));
});

test('a cold merge with an old dropped-reference array carries those values into bounded cleanup', () => {
  const { host, open, total } = overlappingRuns();
  let space = open();
  space.step({ max_pages: 2 });
  const refs = rows(host, 'SELECT ref FROM cleanup_big_drops ORDER BY ref').map(row => row.ref);
  assert.ok(refs.length > 0);
  const oldMarker = { ...space.meta.get('merge'), dropped: refs };
  host.transaction(() => {
    host.sql.exec('DELETE FROM cleanup_big_drops');
    space.meta.set('merge', oldMarker);
  });
  space = open();
  assert.equal(space.step({ max_pages: 2 }).pages, 0, 'the old marker migrates before its cursor advances');
  assert.ok(count(host, 'cleanup_big_drops') > 0);
  assert.ok((space.meta.get('merge').dropped?.length ?? 0) < refs.length);
  for (let turns = 0; space.mergeDue(); turns += 1) {
    assert.ok(turns < 100);
    space = open();
    space.step({ max_pages: 2 });
  }
  assert.equal(count(host, 'cleanup_big'), total);
  assert.equal(count(host, 'cleanup_big_drops'), 0);
  for (let at = 0; at < total; at += 1) assert.deepEqual(space.get(key(at)), value(at, 'new'));
});


test('failed forget-mode recovery rolls its queue back and resumes without retiring reachable values', t => {
  const { host, open } = overlappingRuns();
  t.after(() => host.db.close());
  let space = open();
  space.step({ max_pages: 4 });
  assert.deepEqual(space.releaseDerivedSpace(), { freed: true, more: true });
  assert.equal(space.meta.get('big_drop_mode'), 'forget');
  const drops = rows(host, 'SELECT ref FROM cleanup_big_drops ORDER BY ref');
  assert.ok(drops.length > 1);
  const parts = rows(host, 'SELECT * FROM cleanup_big ORDER BY ref, part');
  const exec = host.sql.exec.bind(host.sql);
  let deletes = 0;
  host.sql.exec = (query, ...params) => {
    if (query === 'DELETE FROM cleanup_big_drops WHERE ref = ?' && ++deletes === 2) throw new Error('injected forget failure');
    return exec(query, ...params);
  };
  assert.throws(() => open().releaseDerivedSpace(), /injected forget failure/);
  host.sql.exec = exec;
  assert.deepEqual(rows(host, 'SELECT ref FROM cleanup_big_drops ORDER BY ref'), drops);
  assert.deepEqual(rows(host, 'SELECT * FROM cleanup_big ORDER BY ref, part'), parts);
  for (let turns = 0; ; turns++) {
    assert.ok(turns < 20);
    space = open();
    if (!space.releaseDerivedSpace().more) break;
  }
  assert.deepEqual(rows(host, 'SELECT * FROM cleanup_big ORDER BY ref, part'), parts);
  assert.deepEqual(space.get(key(0)), value(0, 'new'));
});
