// tools/notice-when-something-shows-up/tests/source-rows.test.mjs
//
// The source-rows leaf over a table of lists held in memory and a stand-in service: one waiter reads 1,000 lists each at
// its due time, tells only what changed, keeps each list's place in its own row across a restart, reads no more than its
// reads a minute, and stops reading for the day at the cap (the budget row, else what the service says is left).
import assert from 'node:assert/strict';
import test from 'node:test';
import { watchForTransitions, readSettings, pgStore } from '../do-work/mechanisms/source-rows.mjs';

/** A table of lists in memory, as pgStore answers it. */
function memoryStore(rows, { budget = null } = {}) {
  const table = new Map(rows.map((row) => [row.id, { cost: null, seen: null, read_at: null, due_at: null, is_active: true, last_said: null, ...row }]));
  return {
    table,
    async due(limit, nowMs) {
      return [...table.values()].filter((row) => row.is_active && (row.due_at === null || row.due_at <= nowMs))
        .sort((a, b) => (a.due_at ?? -Infinity) - (b.due_at ?? -Infinity) || a.id.localeCompare(b.id)).slice(0, limit)
        .map((row) => ({ id: row.id, settings: row.settings, cost: row.cost, seen: row.seen === null ? null : JSON.parse(JSON.stringify(row.seen)), read_at: row.read_at }));
    },
    async save(id, { seen, read_at, due_at, last_said }) {
      Object.assign(table.get(id), { seen: seen === undefined ? null : seen, read_at, due_at, last_said: last_said ?? null });
    },
    async nextDue() {
      const dues = [...table.values()].filter((row) => row.is_active).map((row) => row.due_at ?? 0);
      return dues.length ? Math.min(...dues) : null;
    },
    async budget() { return budget; },
  };
}

const listSettings = (n) => ({ where: 'treg-api-key', request: { url: `https://service.test/channels/${n}/posts`, headers: { Authorization: 'Bearer {credential}' } },
  shape: { items: 'data', place: { value: 'post' }, key: 'id' }, look_again_seconds: 300 });

/** A clock that moves only when the leaf sleeps, a service whose answers the test sets, and a run that stops at `until`. */
function world({ until, lists, balance = null }) {
  let clock = Date.parse('2026-11-22T00:00:00Z');
  const controller = new AbortController();
  const reads = [];
  const told = [];
  return {
    reads, told, controller,
    now: () => clock,
    async sleep(ms) {
      clock += Math.max(ms, 1);
      if (clock >= until(clock0)) controller.abort();
    },
    async fetch(url, { headers }) {
      if (url === 'https://service.test/balance') return { ok: true, json: async () => ({ balance: { amount: balance } }) };
      assert.equal(headers.Authorization, 'Bearer the-key');
      const n = Number(url.split('/')[4]);
      reads.push({ n, at: clock });
      return { ok: true, json: async () => ({ data: lists(n, clock) }) };
    },
    onTransition(transition) { told.push(transition); return true; },
  };
}
const clock0 = Date.parse('2026-11-22T00:00:00Z');

test('one waiter reads 1,000 lists each at its due time and tells only what changed', async () => {
  const store = memoryStore(Array.from({ length: 1000 }, (_, n) => ({ id: `channel-${n}`, settings: listSettings(n) })));
  const lists = (n, at) => (n === 7 && at >= clock0 + 600_000 ? [{ id: 'a' }, { id: 'new-post' }] : [{ id: 'a' }]);
  const w = world({ until: (start) => start + 1_000_000, lists });
  await watchForTransitions({ table: 'watched_lists', most_reads_per_minute: 100_000, most_per_pass: 1000 },
    { store, credential: 'the-key', fetch: w.fetch, now: w.now, sleep: w.sleep, signal: w.controller.signal, onTransition: w.onTransition });
  for (let n = 0; n < 1000; n += 1) {
    const mine = w.reads.filter((read) => read.n === n).map((read) => read.at);
    assert.ok(mine.length >= 3, `channel-${n} was read ${mine.length} times`);
    for (let i = 1; i < mine.length; i += 1) assert.ok(mine[i] - mine[i - 1] >= 300_000, `channel-${n} was read before it was due`);
  }
  assert.equal(w.told.length, 1, 'only the one new post is told');
  assert.equal(w.told[0].detail.key, 'new-post');
  assert.equal(w.told[0].detail.change, 'added');
  assert.deepEqual(Object.keys(store.table.get('channel-7').seen).sort(), ['a', 'new-post'], 'its row keeps its place');
});

test('a restart reads each list from its own row: nothing told again, and a change made while it was down is told once', async () => {
  const store = memoryStore([{ id: 'channel-1', settings: listSettings(1) }, { id: 'channel-2', settings: listSettings(2) }]);
  let posts = [{ id: 'a' }];
  const first = world({ until: (start) => start + 100_000, lists: () => posts });
  await watchForTransitions({ table: 'watched_lists' }, { store, credential: 'the-key', fetch: first.fetch, now: first.now, sleep: first.sleep, signal: first.controller.signal, onTransition: first.onTransition });
  assert.equal(first.told.length, 0, 'the first read tells nothing');
  posts = [{ id: 'a' }, { id: 'b' }];
  for (const row of store.table.values()) row.due_at = 0;
  const second = world({ until: (start) => start + 100_000, lists: () => posts });
  await watchForTransitions({ table: 'watched_lists' }, { store, credential: 'the-key', fetch: second.fetch, now: second.now, sleep: second.sleep, signal: second.controller.signal, onTransition: second.onTransition });
  assert.deepEqual(second.told.map((t) => `${t.detail.key}:${t.detail.change}`), ['b:added', 'b:added'], 'each list tells its new post once');
});

test('a refused tell leaves the list where it was and reads it again soon', async () => {
  const store = memoryStore([{ id: 'channel-1', settings: listSettings(1), seen: {} }]);
  const w = world({ until: (start) => start + 20_000, lists: () => [{ id: 'a' }] });
  await watchForTransitions({ table: 'watched_lists', again_after_refusal_seconds: 30 },
    { store, credential: 'the-key', fetch: w.fetch, now: w.now, sleep: w.sleep, signal: w.controller.signal, onTransition: () => false });
  const row = store.table.get('channel-1');
  assert.deepEqual(row.seen, {}, 'its place did not move past what was not told');
  assert.equal(row.due_at - row.read_at, 30_000);
  assert.match(row.last_said, /told again/);
});

test('reads stay within most_reads_per_minute', async () => {
  const store = memoryStore(Array.from({ length: 30 }, (_, n) => ({ id: `channel-${n}`, settings: listSettings(n) })));
  const w = world({ until: (start) => start + 200_000, lists: () => [] });
  await watchForTransitions({ table: 'watched_lists', most_reads_per_minute: 10 },
    { store, credential: 'the-key', fetch: w.fetch, now: w.now, sleep: w.sleep, signal: w.controller.signal, onTransition: w.onTransition });
  const times = w.reads.map((read) => read.at);
  assert.equal(times.length, 30);
  for (let i = 10; i < times.length; i += 1) assert.ok(times[i] - times[i - 10] >= 60_000, `read ${i} came within a minute of read ${i - 10}`);
});

test('reads stop for the day at the cap: what the service says is left, or the budget row when there is one', async () => {
  const rows = () => Array.from({ length: 10 }, (_, n) => ({ id: `channel-${n}`, settings: listSettings(n) }));
  const cost = { per_read: 1, balance_request: { url: 'https://service.test/balance', headers: { Authorization: 'Bearer {credential}' } }, balance_path: 'balance.amount' };
  const byBalance = world({ until: (start) => start + 100_000, lists: () => [], balance: 3 });
  await watchForTransitions({ table: 'watched_lists', cost }, { store: memoryStore(rows()), credential: 'the-key', fetch: byBalance.fetch, now: byBalance.now, sleep: byBalance.sleep, signal: byBalance.controller.signal, onTransition: byBalance.onTransition });
  assert.equal(byBalance.reads.length, 3, 'three reads cost what the service says is left');
  const byBudget = world({ until: (start) => start + 100_000, lists: () => [], balance: 3 });
  await watchForTransitions({ table: 'watched_lists', cost: { ...cost, budget_table: 'budgets', budget_id: 'treg' } }, { store: memoryStore(rows(), { budget: 5 }), credential: 'the-key', fetch: byBudget.fetch, now: byBudget.now, sleep: byBudget.sleep, signal: byBudget.controller.signal, onTransition: byBudget.onTransition });
  assert.equal(byBudget.reads.length, 5, 'the budget row is the cap when there is one');
  const noCap = world({ until: (start) => start + 100_000, lists: () => [] });
  await watchForTransitions({ table: 'watched_lists', cost: { per_read: 1 } }, { store: memoryStore(rows()), credential: 'the-key', fetch: noCap.fetch, now: noCap.now, sleep: noCap.sleep, signal: noCap.controller.signal, onTransition: noCap.onTransition });
  assert.equal(noCap.reads.length, 0, 'with no budget row and no balance, nothing that costs is read');
});

test('a waiter with no table is refused, and settings fall back to their defaults', () => {
  assert.equal(readSettings({}).table, null);
  assert.equal(readSettings({ table: 'bad name' }).table, null);
  assert.equal(readSettings({ table: 'watched_lists' }).most_reads_per_minute, 60);
});

test('the table is read by its own columns, only the waiter\'s list_group, and written back only in its kept columns', async () => {
  const asked = [];
  const client = { async query(sql, params) { asked.push({ sql, params }); return { rows: [] }; } };
  const store = pgStore(client, readSettings({ table: 'watched_lists', list_group: 'treg' }));
  await store.due(5, clock0);
  await store.nextDue();
  await store.save('channel-1', { seen: { a: 'x' }, read_at: clock0, due_at: clock0 + 1, last_said: null });
  assert.match(asked[0].sql, /FROM watched_lists[\s\S]*list_group = \$3/);
  assert.deepEqual(asked[0].params.slice(1), [5, 'treg']);
  assert.deepEqual(asked[1].params, ['treg']);
  assert.match(asked[2].sql, /^UPDATE watched_lists SET seen = \$2, read_at = \$3, due_at = \$4, last_said = \$5 WHERE id = \$1$/);
});
