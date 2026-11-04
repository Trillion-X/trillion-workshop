// test/kept-runs-merge-space.test.mjs
//
// A merge writes its whole output before its inputs go, so it needs about their size again in free space
// (parts/record-log/do-work/kept-runs.mjs nextMerge). On the owner's store on 2026-10-10 a complete fold over a 2.2 GB
// run ran the database into its 10 GiB limit, where every write fails, the merge's own included. This holds that where
// the host reports the database's size, a merge that would not fit waits while the merges that do fit still run, that
// pages on the free list count as room, that nothing is due while only a merge that does not fit is left (no wake spins
// on it), that every answer stays right, and that the waiting merge runs once the room is there.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

const key = at => `k${String(at).padStart(5, '0')}`;

test('a merge that would not fit the room left waits, cheaper merges still run, and it runs once there is room', () => {
  const host = sqliteHost(':memory:');
  let size = 0;
  let freePages = 0;
  const sql = {
    exec(query, ...params) {
      return host.sql.exec(query, ...params);
    },
    get databaseSize() { return size; },
    get databaseFreeBytes() { return freePages * 4096; },
  };
  const settings = { prefix: 'room', page_bytes: 256, memtable_bytes: 1 << 30, fan_in: 4, max_runs: 4, database_limit_bytes: 1_000_000, space_share: 1, space_factor: 1, compaction_debt_min_bytes: 1 };
  const open = () => keptRuns(sql, { transaction: host.transaction, ...settings });
  let space = open();
  // One large run, then its values overwritten in part (so a complete fold is due), then a backlog of small runs.
  for (let at = 0; at < 3000; at += 1) space.put(key(at), { at, text: 'x'.repeat(40) });
  space.flush();
  for (let at = 0; at < 3000; at += 2) space.put(key(at), { at, text: 'y'.repeat(40) }, undefined, 100);
  space.flush();
  for (let run = 0; run < 9; run += 1) { space.put(`s${run}`, { run }); space.flush(); }
  const large = space.held().runs.reduce((sum, run) => sum + run.bytes, 0);
  const expect = s => {
    for (let at = 0; at < 3000; at += 97) assert.deepEqual(s.get(key(at)), { at, text: (at % 2 ? 'x' : 'y').repeat(40) });
    for (let run = 0; run < 9; run += 1) assert.deepEqual(s.get(`s${run}`), { run });
  };

  // Room for small merges only: the two large runs never join a merge, and nothing is due once only they are left.
  size = settings.database_limit_bytes - Math.floor(large / 4);
  const largeRuns = space.held().runs.filter(run => run.bytes > large / 8).map(run => run.run);
  assert.equal(largeRuns.length, 2);
  for (let turns = 0; space.mergeDue(); turns += 1) {
    assert.ok(turns < 50, 'merging stops once only merges that do not fit are left');
    space = open();
    space.step({ max_pages: 64 });
    assert.ok(largeRuns.every(run => space.held().runs.some(held => held.run === run)), 'a large run was merged without room');
    expect(space);
  }
  assert.ok(space.held().runs.length <= settings.max_runs + 2, `the small runs merged (${space.held().runs.length} runs)`);
  assert.equal(space.meta.get('merge'), undefined);

  // Pages freed by deletes count as room: with enough on the free list, the fold that was waiting runs.
  freePages = Math.ceil((large * 2) / 4096);
  assert.equal(space.mergeDue(), true);
  for (let turns = 0; space.mergeDue(); turns += 1) {
    assert.ok(turns < 500, 'the waiting merge finishes');
    space = open();
    space.step({ max_pages: 64 });
  }
  assert.ok(largeRuns.every(run => !space.held().runs.some(held => held.run === run)), 'the large runs merged once there was room');
  expect(space);
  expect(open());
});

test('a host that reports no size merges as before', () => {
  const host = sqliteHost(':memory:');
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'nosize', page_bytes: 256, fan_in: 2, max_runs: 2, database_limit_bytes: 1 });
  for (let run = 0; run < 6; run += 1) { for (let at = 0; at < 50; at += 1) space.put(key(run * 50 + at), { run }); space.flush(); }
  for (let turns = 0; space.mergeDue(); turns += 1) { assert.ok(turns < 200); space.step({ max_pages: 64 }); }
  assert.ok(space.held().runs.length <= 2);
});

test('backlog admission selects the cheapest page group that fits, despite different packed byte sizes', () => {
  const host = sqliteHost(':memory:');
  let size = 0;
  const sql = {
    exec(query, ...params) {
      return host.sql.exec(query, ...params);
    },
    get databaseSize() { return size; },
  };
  const settings = { prefix: 'packed_room', page_bytes: 1024, memtable_bytes: 1 << 30,
    fan_in: 2, max_runs: 2, database_limit_bytes: 1_000_000, space_share: 1, space_factor: 1 };
  const open = () => keptRuns(sql, { transaction: host.transaction, ...settings });
  let space = open();
  const expected = new Map();
  try {
    // The first pair packs four distinct values into one page per run. The
    // second pair has more pages, but uniform page values use fewer bytes.
    for (let run = 0; run < 4; run += 1) {
      for (let row = 0; row < (run < 2 ? 4 : 8); row += 1) {
        const id = `k${run}-${row}`;
        const value = { text: String.fromCharCode(65 + (run < 2 ? run * 4 + row : run)).repeat(200) };
        expected.set(id, value);
        space.put(id, value);
      }
      space.flush();
    }
    const byAge = space.held().runs.slice().sort((a, b) => a.age - b.age);
    const oldest = byAge.slice(0, 2), youngest = byAge.slice(2);
    const sum = (runs, field) => runs.reduce((total, run) => total + run[field], 0);
    assert.ok(sum(oldest, 'pages') < sum(youngest, 'pages'), 'page-cheapest pair is the older pair');
    assert.ok(sum(oldest, 'bytes') > sum(youngest, 'bytes'), 'the higher-page pair needs less scratch space');
    const left = sum(youngest, 'bytes');
    size = settings.database_limit_bytes - left;
    space = open();
    assert.equal(space.mergeDue(), true, 'an admissible adjacent backlog group remains due');
    space.step({ max_pages: 1 });
    const selected = space.meta.get('merge');
    if (selected) assert.deepEqual(selected.inputs.slice().sort((a, b) => a - b), youngest.map(run => run.run).sort((a, b) => a - b));
    else assert.ok(youngest.every(run => !space.held().runs.some(current => current.run === run.run)), 'the admissible pair already finished');
    assert.ok(oldest.every(run => space.held().runs.some(current => current.run === run.run)), 'the pair that does not fit never starts');
    for (const [id, value] of expected) assert.deepEqual(space.get(id), value);
    for (let turn = 0; space.meta.get('merge'); turn += 1) {
      assert.ok(turn < 20);
      space = open();
      space.step({ max_pages: 1 });
    }
    assert.ok(youngest.every(run => !space.held().runs.some(current => current.run === run.run)));
    const restarted = open();
    for (const [id, value] of expected) assert.deepEqual(restarted.get(id), value, 'restart retains every exact value');
  } finally { host.db.close(); }
});

// A store past space_share still merges its backlog's cheapest small groups under the hard limit, less
// backlog_reserve_bytes: on the founder's store (10.4 GB of 10 GiB, about 1,700 runs, 2026-10-16) no merge could start
// and every read probed every run. A complete fold still waits for the space_share room.
test('past space_share a backlog keeps merging its small groups under the hard limit; a fold still waits', () => {
  const host = sqliteHost(':memory:');
  let size = 0;
  const sql = {
    exec(query, ...params) {
      return host.sql.exec(query, ...params);
    },
    get databaseSize() { return size; },
  };
  const settings = { prefix: 'hard', page_bytes: 256, memtable_bytes: 1 << 30, fan_in: 4, max_runs: 4, database_limit_bytes: 1_000_000,
    space_share: 0.9, space_factor: 1.5, backlog_reserve_bytes: 50_000, compaction_debt_min_bytes: 1 };
  const open = () => keptRuns(sql, { transaction: host.transaction, ...settings });
  let space = open();
  for (let at = 0; at < 3000; at += 1) space.put(key(at), { at, text: 'x'.repeat(40) });
  space.flush();
  for (let at = 0; at < 3000; at += 2) space.put(key(at), { at, text: 'y'.repeat(40) }, undefined, 100);
  space.flush();
  for (let run = 0; run < 12; run += 1) { space.put(`s${run}`, { run }); space.flush(); }
  const runsBefore = space.held().runs.length;
  // Past space_share (900,000) but 60,000 bytes under the hard limit: room for small groups, not for a fold.
  size = 940_000;
  for (let turns = 0; space.mergeDue(); turns += 1) {
    assert.ok(turns < 60, 'merging stops once only merges that do not fit are left');
    space = open();
    space.step({ max_pages: 64 });
  }
  assert.ok(space.held().runs.length < runsBefore, `the backlog merged under the hard limit (${runsBefore} -> ${space.held().runs.length} runs)`);
  assert.equal(space.held().runs.filter(run => run.bytes > 20_000).length, 2, 'the two large runs were not folded without space_share room');
  for (let at = 0; at < 3000; at += 97) assert.deepEqual(space.get(key(at)), { at, text: (at % 2 ? 'x' : 'y').repeat(40) });
  for (let run = 0; run < 12; run += 1) assert.deepEqual(space.get(`s${run}`), { run });
  // Within the reserve nothing starts.
  size = 1_000_000 - 40_000;
  for (let run = 12; run < 20; run += 1) { space.put(`s${run}`, { run }); space.flush(); }
  space = open();
  assert.equal(space.mergeDue(), false, 'inside the reserve no merge is due');
  host.db.close();
});
