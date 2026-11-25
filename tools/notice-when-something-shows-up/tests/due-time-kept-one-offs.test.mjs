// Kept one-off watches: the real from_rows query reads PostgreSQL rows, and the due-time leaf resumes from the state
// kept after an accepted tell. These are replay proofs of persistence and timing, not a live workflow-dispatch proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { keptWakes, rowsSource, watchForTransitions } from '../do-work/mechanisms/due-time.mjs';

const wake = (id, due_at, extra = {}) => ({
  id,
  switched_on: true,
  input: { start_at: 'measure', release: 'release-a', baseline: 'before-a' },
  on: { fact: { kind: 'due-time', from: ['run'], match: { record_id: id, operation: 'measure' }, watch: {
    time_windows: [{ record_id: id, due_at }],
    actions: [{ record_id: id, action_id: 'measure', dispatch: { name: 'workflow:example', input: { start_at: 'measure' } } }],
  } } },
  ...extra,
});

async function store(t, wakes) {
  const db = new PGlite();
  t.after(async () => { await db.close(); });
  await db.exec('CREATE TABLE workflow_recipes (recipe text PRIMARY KEY, wakes jsonb); CREATE TABLE waiter_state (id text PRIMARY KEY, state jsonb NOT NULL)');
  await db.query('INSERT INTO workflow_recipes (recipe,wakes) VALUES ($1,$2::jsonb)', ['workflow:example', JSON.stringify(wakes)]);
  return db;
}

async function watch(db, { start, jumps = [], answers = [], change = async () => {} }) {
  let now = Date.parse(start);
  const told = [];
  const said = [];
  const controller = new AbortController();
  const state = (await db.query('SELECT state FROM waiter_state WHERE id=$1', ['clock'])).rows[0]?.state ?? null;
  const keep = value => db.query('INSERT INTO waiter_state (id,state) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state', ['clock', JSON.stringify(value)]);
  await watchForTransitions({ from_rows: {}, look_again_seconds: 60, retry_seconds: 1 }, {
    signal: controller.signal,
    state,
    nowMs: () => now,
    connection: 'postgres://replay',
    connect: async () => ({ query: (sql, params) => db.query(sql, params), end: async () => {} }),
    keepState: keep,
    say: line => said.push(line),
    sleep: async () => {
      if (jumps.length === 0) controller.abort();
      else {
        now = Date.parse(jumps.shift());
        await change(now);
      }
    },
    onTransition: async transition => {
      told.push(transition);
      const accepted = answers.length ? answers.shift() : true;
      if (accepted) await keep(transition.state);
      return accepted;
    },
  });
  return { told, said, state: (await db.query('SELECT state FROM waiter_state WHERE id=$1', ['clock'])).rows[0].state };
}

const pairs = told => told.map(({ detail }) => [detail.record_id, detail.operation, detail.start]);

test('two kept one-off wakes survive a row read and fire only at their own times, including a restart', async t => {
  const firstAt = '2026-12-08T10:00:00Z';
  const secondAt = '2026-12-22T10:00:00Z';
  const wakes = [wake('release-a-14', firstAt), wake('release-a-28', secondAt)];
  const db = await store(t, wakes);
  assert.deepEqual(await keptWakes(db, rowsSource({})), wakes, 'registration is read from PostgreSQL, not a returned plan');
  const before = await watch(db, { start: '2026-11-24T10:00:00Z', jumps: ['2026-12-08T09:59:59Z'] });
  assert.deepEqual(before.told, []);
  const first = await watch(db, { start: firstAt, jumps: [firstAt] });
  assert.deepEqual(pairs(first.told), [['release-a-14', 'measure', '2026-12-08T10:00:00Z']]);
  const second = await watch(db, { start: secondAt, jumps: [secondAt] });
  assert.deepEqual(pairs(second.told), [['release-a-28', 'measure', '2026-12-22T10:00:00Z']]);
  const again = await watch(db, { start: '2026-12-23T10:00:00Z' });
  assert.deepEqual(again.told, []);
  assert.equal(again.state.receipts.length, 2, 'both accepted tells persist across restarts');
});

test('a repeated kept registration watches a one-off once; a refused tell keeps the same event due', async t => {
  const due = wake('release-a-14', '2026-12-08T10:00:00Z');
  const db = await store(t, [due, { ...due, id: 'another-listener' }]);
  const result = await watch(db, { start: '2026-12-08T10:00:00Z', jumps: ['2026-12-08T10:00:01Z'], answers: [false, true] });
  assert.deepEqual(result.told.map(row => row.event_key), ['release-a-14#measure', 'release-a-14#measure']);
  assert.equal(result.state.receipts.length, 1, 'only the accepted tell is kept');
  assert.deepEqual((await watch(db, { start: '2026-12-08T10:00:02Z' })).told, []);
});

test('the real kept-row query excludes switched-off wakes and malformed containers', async t => {
  const active = wake('on', '2026-12-08T10:00:00Z');
  const db = await store(t, [null, 'not-a-wake', wake('off', '2026-12-08T10:00:00Z', { switched_on: false }), active]);
  await db.query('INSERT INTO workflow_recipes (recipe,wakes) VALUES ($1,$2::jsonb),($3,$4::jsonb)', ['workflow:null', 'null', 'workflow:object', '{}']);
  assert.deepEqual(await keptWakes(db, rowsSource({})), [active]);
  assert.deepEqual(pairs((await watch(db, { start: '2026-12-08T10:00:00Z' })).told), [['on', 'measure', '2026-12-08T10:00:00Z']]);
});

test('taking a kept one-off away before its time cancels the watch without telling it', async t => {
  const db = await store(t, [wake('removed', '2026-12-08T10:00:00Z')]);
  const result = await watch(db, { start: '2026-12-08T09:59:00Z', jumps: ['2026-12-08T09:59:30Z', '2026-12-08T10:00:00Z'],
    change: async now => {
      if (now === Date.parse('2026-12-08T09:59:30Z')) await db.query('UPDATE workflow_recipes SET wakes=$1::jsonb WHERE recipe=$2', ['[]', 'workflow:example']);
    },
  });
  assert.deepEqual(result.told, []);
  assert.deepEqual(result.said, []);
});
