import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore, maintenanceTurn, maintainInTurns, maintenancePacing, MAINTENANCE_ALARM_GAP_MS, MAINTENANCE_ALARM_MS, MAINTENANCE_TURN_MS, MAINTENANCE_TURN_PAGES, MAINTENANCE_TURN_INPUT_PAGES } from '../parts/record-log/do-work/record-log-store.mjs';

const PAGE_BYTES = 1024;
const runs = { page_bytes: PAGE_BYTES, memtable_bytes: 1 << 20, big_bytes: 8192, cache_bytes: 8192, max_runs: 4, fan_in: 2, tail_rows: Infinity, compaction_debt_min_bytes: 1, compaction_debt_ratio: 0.01 };
const row = (n, generation) => ({ id: 'note:' + String(n).padStart(5, '0'), type: 'note', value: { generation, words: 'w'.repeat(200) } });

// A store with a large compaction debt: many write-outs that each overwrite the same keys, so most bytes are dead.
function indebted({ keys = 400, generations = 12 } = {}) {
  const host = sqliteHost(':memory:');
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, runs });
  const store = open();
  for (let generation = 0; generation < generations; generation += 1) {
    store.write(Array.from({ length: keys }, (_, n) => row(n, generation)));
    store.checkpoint();
  }
  return { host, open, store, keys, generations };
}

// A clock that moves one millisecond per statement, so a turn's time is a count of statements, not the machine's speed.
function statementClock(host) {
  const exec = host.sql.exec.bind(host.sql);
  const seen = { statements: 0, runBytes: 0, runReads: 0 };
  host.sql.exec = (query, ...params) => {
    seen.statements += 1;
    const cursor = exec(query, ...params);
    if (/^\s*SELECT/i.test(query) && /record_keys_run_\d+/.test(query)) {
      const rows = cursor.toArray();
      seen.runReads += rows.length;
      for (const found of rows) if (typeof found.body === 'string') seen.runBytes += found.body.length;
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator](), next: () => ({ done: true }) };
    }
    return cursor;
  };
  return { seen, clock: () => seen.statements };
}

const debt = host => {
  const found = host.sql.exec("SELECT value FROM record_keys_meta WHERE key = 'compaction_debt'").toArray()[0];
  return found ? JSON.parse(found.value) : 0;
};
const runCount = host => host.sql.exec('SELECT COUNT(*) AS n FROM record_keys_runs').toArray()[0].n;

test('a large compaction debt is worked off in bounded turns, each within its page and statement budget', () => {
  const { host, store, keys, generations } = indebted();
  try {
    const before = { runs: runCount(host), debt: debt(host) };
    assert.ok(before.runs > 4 || before.debt > 0, 'the fixture carries merge work');
    const { seen, clock } = statementClock(host);
    let turns = 0, mostStatements = 0, mostPages = 0;
    for (;;) {
      const startedAt = seen.statements;
      const turn = maintenanceTurn({ ms: MAINTENANCE_TURN_MS, clock });
      const step = store.maintain(turn);
      turns += 1;
      mostStatements = Math.max(mostStatements, seen.statements - startedAt);
      mostPages = Math.max(mostPages, step.diagnostics.pages);
      assert.ok(turns < 5000, 'catch-up finishes');
      if (!store.mergeDue?.() && !step.more) break;
      if (!step.merged && step.pages === 0 && !step.more) break;
    }
    assert.ok(turns > 3, 'the debt took several turns, not one long wake: ' + turns);
    assert.ok(mostPages <= MAINTENANCE_TURN_PAGES, 'pages written in a turn: ' + mostPages);
    assert.ok(mostStatements <= MAINTENANCE_TURN_MS * 4, 'statements in a turn (one per millisecond of the fake clock): ' + mostStatements);
    assert.ok(runCount(host) <= 4, 'runs fell to the cap: ' + runCount(host));
    assert.ok(debt(host) < before.debt || before.debt === 0, 'debt fell');
    for (let n = 0; n < keys; n += 1) assert.equal(store.read(row(n, 0).id).generation, generations - 1);
  } finally { host.db.close(); }
});

test('a read issued between compaction turns answers correctly within a statement bound', () => {
  const { host, open, store, keys, generations } = indebted();
  try {
    const { seen, clock } = statementClock(host);
    let reads = 0, midMerge = 0;
    for (let turn = 0; turn < 400; turn += 1) {
      const step = store.maintain(maintenanceTurn({ ms: 10, clock }));
      if (store.held().keys.merge) midMerge += 1;
      const at = seen.statements;
      const n = (turn * 37) % keys;
      assert.equal(store.read(row(n, 0).id).generation, generations - 1, 'a read while a merge is part-way sees the newest value');
      const cost = seen.statements - at;
      assert.ok(cost <= 20 * runCount(host) + 20, 'a read costs a bounded number of statements: ' + cost);
      reads += 1;
      if (!step.more) break;
    }
    assert.ok(midMerge > 1, 'reads were issued while a merge was part-way: ' + midMerge);
    assert.ok(reads > 1);
    const reopened = open();
    assert.equal(reopened.read(row(7, 0).id).generation, generations - 1, 'a cold reopen mid-way answers too');
  } finally { host.db.close(); }
});

test('the bytes of run pages read in a turn stay under the turn byte budget', () => {
  const { host, store } = indebted({ keys: 600, generations: 16 });
  try {
    const { seen, clock } = statementClock(host);
    const pageChars = 4 * PAGE_BYTES;
    const budget = (MAINTENANCE_TURN_INPUT_PAGES + MAINTENANCE_TURN_PAGES) * pageChars;
    let most = 0, turns = 0;
    for (; turns < 5000; turns += 1) {
      const startedAt = seen.runBytes;
      const step = store.maintain(maintenanceTurn({ ms: MAINTENANCE_TURN_MS, clock }));
      most = Math.max(most, seen.runBytes - startedAt);
      if (!step.more) break;
    }
    assert.ok(turns > 3);
    assert.ok(most > 0, 'the counter saw run pages');
    assert.ok(most <= budget, `a turn read ${most} bytes of run pages; the budget is ${budget}`);
  } finally { host.db.close(); }
});

test('a wake given no turn bound is the old unbounded one: it merges more pages than a turn allows', () => {
  const { host, store } = indebted({ keys: 600, generations: 16 });
  try {
    const step = store.maintain({ max_pages: 512 });
    assert.ok(step.diagnostics.pages > MAINTENANCE_TURN_PAGES, 'the unbounded wake wrote ' + step.diagnostics.pages + ' pages');
  } finally { host.db.close(); }
});

test('a large debt drains in a bounded number of alarm wakes, and a read issued mid-alarm answers between turns', async () => {
  const { host, store, keys, generations } = indebted({ keys: 600, generations: 16 });
  try {
    const { seen, clock } = statementClock(host);
    // One alarm: turns of 50 statements back to back, yielding between them, until 400 statements of alarm time have gone.
    const alarmMs = 400;
    let wakes = 0, turns = 0, readsDuringAlarm = 0;
    const yieldTurn = async () => {
      await Promise.resolve();
      const n = (readsDuringAlarm * 53) % keys;
      assert.equal(store.read(row(n, 0).id).generation, generations - 1, 'a read between turns of one alarm answers the newest value');
      readsDuringAlarm += 1;
    };
    for (; wakes < 200; wakes += 1) {
      const result = await maintainInTurns(store, { alarmMs, turnMs: MAINTENANCE_TURN_MS, clock, yieldTurn, now: () => Date.now() });
      turns += result.turns;
      assert.ok(result.turns <= 1 + Math.ceil(alarmMs / 1), 'a wake runs a bounded number of turns');
      if (!result.more) break;
    }
    assert.ok(wakes < 200, 'the debt drained: ' + wakes + ' wakes');
    assert.ok(turns > wakes + 1, 'a wake ran several turns (' + turns + ' turns in ' + (wakes + 1) + ' wakes)');
    assert.ok(readsDuringAlarm > wakes, 'reads were answered inside alarms: ' + readsDuringAlarm);
    assert.ok(runCount(host) <= 4);
    assert.ok(seen.statements > 0);
  } finally { host.db.close(); }
});

test('maintenance pacing: the next wake is no sooner than the gap after the last turn, and a cold start is due at once', () => {
  let now = 10_000;
  const pacing = maintenancePacing(MAINTENANCE_ALARM_GAP_MS, () => now);
  assert.equal(pacing.nextAt(null), null);
  assert.equal(pacing.nextAt(now), now, 'before any turn it is due as the store says');
  pacing.ran();
  assert.equal(pacing.nextAt(now), now + MAINTENANCE_ALARM_GAP_MS);
  now += MAINTENANCE_ALARM_GAP_MS + 1;
  assert.equal(pacing.nextAt(now), now, 'once the gap has gone it is due');
  assert.equal(pacing.nextAt(null), null, 'a store with no due work rests');
});

test('a wake reports its turns, its time and what its slowest turn spent it on', async () => {
  const { host, store } = indebted({ keys: 300, generations: 8 });
  try {
    const { clock } = statementClock(host);
    const reports = [];
    await maintainInTurns(store, { alarmMs: 300, clock, yieldTurn: async () => {}, report: wake => reports.push(wake) });
    assert.equal(reports.length, 1);
    assert.ok(reports[0].turns >= 1 && reports[0].wake_ms >= 0 && reports[0].slowest_turn_ms >= 0);
    assert.equal(typeof reports[0].slowest_turn.merged_ms, 'number', 'the slowest turn carries the record log\'s own time split');
    const kept = reports[0].slowest_turn.kept;
    assert.ok(kept.runs >= 1 && kept.run_bytes > 0 && typeof kept.compaction_debt === 'number' && typeof kept.compaction_due === 'boolean', 'and the runs, their bytes, the debt and whether a fold is due');
  } finally { host.db.close(); }
});

test('as shipped (alarm_ms 0) one alarm runs one turn, however much debt is left', async () => {
  const { host, store } = indebted({ keys: 600, generations: 16 });
  try {
    const { clock } = statementClock(host);
    const result = await maintainInTurns(store, { clock });
    assert.equal(result.turns, 1);
    assert.equal(result.more, true, 'the debt is not worked off in one turn');
    assert.equal(MAINTENANCE_ALARM_MS, 0);
  } finally { host.db.close(); }
});
