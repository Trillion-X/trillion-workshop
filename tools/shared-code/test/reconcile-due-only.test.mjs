// Ported from old trillion test/reconcile-due-only.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The reconciler is src/agents.mjs here over the agents store tests use, and over records with
// tools/hand-work-to-ais agent-records.mjs and agent-legacy-rows.mjs. The five store-level tests are the old ones. The first
// counted the SQL of one wake of a whole booted old person store (test/fault/simulated-person.mjs bootPerson over
// src/person-store.mjs and its `agent-work-reviews` scheduler source); that store went with the Worker and no running code
// makes that source (searched bootPerson, agent-work-reviews in trillion-workshop tools/, trillion-apps web/, trillion-rust
// src/: only keep-and-wake-ai-sessions-on-this-computer/src/scheduler.json keeps its time budget), so it is left out.
// test/reconcile-due-only.test.mjs
// The reconciler (src/agents.mjs reconcile, the person store's `agent-work-reviews` scheduler source) reads, on each
// wake, only the open work whose review is due (store.dueReviews, from the review index each store keeps beside its
// handoffs) and one bounded slice of the whole open list continuing from a mark kept between wakes (store.reviewMark),
// wrapping to the start. On 2026-10-07 it read every open job on every wake: on the busiest account (3,646 open jobs) it
// ran 821 times in 6 hours at 3,892 SQL statements a run. These tests prove a wake stays bounded however much is open,
// due work remains scheduled until settled, and the slice still reaches every open job, including a held job its AI said
// something is in the way of, whose review the index never names (src/agents.mjs reviewOf gives it none).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../src/agents.mjs';
import { agentStoreForTests } from './agent-store-for-tests.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { agentLegacyRows } from '../../hand-work-to-ais/agent-legacy-rows.mjs';

// The slice the reconciler reads a wake (src/agents.mjs RECONCILE_PAGE).
const PAGE = 25;
const OPEN = 2000;
const DUE = 3;
const iso = ms => new Date(ms).toISOString();
const id = n => `job-${String(n).padStart(5, '0')}`;

// OPEN open jobs any AI may take, each next reviewed an hour from now; DUE more whose review fell due a minute ago; and
// one held job, in the middle of the open list, whose hold ran out while its AI said something is in the way.
function fill(store, now) {
  store.transaction(() => {
    for (let n = 0; n < OPEN; n += 1) {
      store.putHandoff({ handoff_id: id(n), job: `Job ${n}`, state: 'open', handed_at: iso(now - (OPEN - n) * 1000), review_at: iso(now + 3_600_000), wakes: 5, revision: 1 });
    }
    for (let n = 0; n < DUE; n += 1) {
      store.putHandoff({ handoff_id: `due-${n}`, job: `Due ${n}`, state: 'open', handed_at: iso(now - 5_000_000 + n), review_at: iso(now - 60_000), wakes: 0, revision: 1 });
    }
    store.putHandoff({ handoff_id: 'held-in-the-way', job: 'Held', state: 'taken', taken_by: 'a', taken_at: iso(now - 7_200_000), hold_until: iso(now - 3_600_000),
      handed_at: iso(now - (OPEN / 2) * 1000 + 500), generation: 1, attempts: [{ generation: 1, agent_id: 'a', taken_at: iso(now - 7_200_000) }],
      in_the_way: 'Waiting for a sign-in', in_the_way_by: 'a', in_the_way_at: iso(now - 7_000_000), revision: 2 });
  });
}

test('every open job is visited within ceil(open / slice) wakes, and a held job its AI walled whose hold ran out goes back to waiting', () => {
  const store = agentStoreForTests();
  const now = Date.parse('2026-10-07T07:00:00.000Z');
  const visited = new Set();
  let perWake = [];
  const seen = list => { perWake.push(...list.map(item => item.handoff_id)); for (const item of list) visited.add(item.handoff_id); return list; };
  const watched = {
    ...store,
    dueReviews: (...args) => seen(store.dueReviews(...args)),
    openHandoffs: query => seen(store.openHandoffs(query)),
  };
  const agents = makeAgents({ store: watched, now: () => new Date(now) });
  agents.publish({ agent_id: 'a', name: 'A', description: 'takes any work' });
  fill(store, now);
  const open = OPEN + DUE + 1;
  const wakes = Math.ceil(open / PAGE);
  let reopenedAt = null;
  for (let wake = 1; wake <= wakes; wake += 1) {
    perWake = [];
    const done = agents.reconcile();
    assert.ok(perWake.length <= PAGE + DUE, `wake ${wake} read ${perWake.length} handoffs`);
    // A due job the slice also reaches is settled once: settling it twice would announce it twice.
    if (wake === 1) assert.deepEqual([...done.woken].sort(), ['due-0', 'due-1', 'due-2']);
    if (done.reopened.includes('held-in-the-way')) reopenedAt = wake;
    // The last wake reaches the end of the open list and wraps to its start (the due work, handed out first).
    if (wake === wakes) assert.ok(perWake.includes(id(OPEN - 1)) && perWake.includes('due-0'), 'the slice wrapped to the start of the open list');
  }
  assert.ok(reopenedAt !== null, 'the walled held job whose hold ran out is reopened by the slice');
  const reopened = store.handoff('held-in-the-way');
  assert.equal(reopened.taken_by, null);
  assert.equal(reopened.hold_until, null);
  assert.equal(visited.size, open, `every open job was visited within ${wakes} wakes`);
});

test('a small account reads all of its open work on every wake, as before', () => {
  const store = agentStoreForTests();
  const agents = makeAgents({ store });
  agents.publish({ agent_id: 'a', name: 'A', description: 'takes any work' });
  for (let n = 0; n < 20; n += 1) agents.handOff({ job: `Job ${n}`, request_key: `k${n}` });
  let read = 0;
  const counted = makeAgents({ store: { ...store, openHandoffs: query => { const page = store.openHandoffs(query); read += page.length; return page; } } });
  counted.reconcile();
  assert.equal(read, 20);
  assert.equal(store.reviewMark(), null, 'nothing is kept between wakes when one slice holds all the open work');
});

test('due reviews beyond one slice stay due until every one is settled', () => {
  const store = agentStoreForTests();
  const now = Date.parse('2026-10-07T07:00:00.000Z');
  const agents = makeAgents({ store, now: () => new Date(now) });
  agents.publish({ agent_id: 'a', name: 'A', description: 'takes any work' });
  for (let n = 0; n < 60; n += 1) store.putHandoff({
    handoff_id: id(n), job: `Job ${n}`, state: 'open', handed_at: iso(now - 60_000 - n),
    review_at: iso(now - 1_000), wakes: 0, revision: 1,
  });
  const woken = new Set();
  const marks = new Set();
  for (let wake = 0; wake < 4 && woken.size < 60; wake += 1) {
    assert.ok(agents.nextReviewAt() <= now, 'remaining due reviews arm another wake');
    const done = agents.reconcile();
    assert.ok(done.woken.length <= PAGE, 'one wake settles no more than its bounded handoff slice');
    for (const handoffId of done.woken) woken.add(handoffId);
    marks.add(store.reviewMark());
  }
  assert.equal(woken.size, 60, 'every due review was settled once');
  assert.ok(marks.size >= 3 && !marks.has(null), 'the open-list cursor advances while reviews remain due');
});

test('while older rows are still moving, the due work of both sides is read, each dependency resolved across the move', () => {
  const host = sqliteHost(':memory:');
  const { sql } = host;
  const records = openRecords(sql, { transaction: host.transaction, hash: text => text });
  for (const table of ['agent_cards (agent_id TEXT PRIMARY KEY, value TEXT NOT NULL)', 'agent_delivery_secrets (agent_id TEXT PRIMARY KEY, secret TEXT NOT NULL)',
    'agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)',
    'agent_deliveries (event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, subject_id TEXT NOT NULL, state TEXT NOT NULL, next_at TEXT, value TEXT NOT NULL)']) sql.exec(`CREATE TABLE ${table}`);
  const at = n => iso(Date.UTC(2026, 9, 7) + n * 1000);
  const job = (name, n, extra = {}) => ({ handoff_id: name, state: 'open', handed_at: at(n), review_at: at(n + 100), ...extra });
  const older = value => sql.exec('INSERT INTO agent_handoffs (handoff_id, open, parent, handed_at, value) VALUES (?, ?, NULL, ?, ?)', value.handoff_id, value.state === 'finished' ? 0 : 1, value.handed_at, JSON.stringify(value));
  const current = agentRecordStore({ records, transaction: host.transaction });
  const bridge = agentLegacyRows({ sql, records, current });
  older(job('old-due', 1, { review_at: at(5) }));
  older(job('old-later', 2, { review_at: at(500) }));
  older(job('old-hidden', 3, { review_at: at(5) }));
  older(job('old-dependency', 4, { state: 'finished' }));
  current.putHandoff(job('old-hidden', 3, { review_at: at(900) }));
  current.putHandoff(job('new-now', 10, { review_at: '' }));
  current.putHandoff(job('new-due', 11, { review_at: at(6) }));
  current.putHandoff(job('new-waits', 12, { review_at: at(6), depends_on: ['old-dependency'] }));
  current.putHandoff(job('new-blocked', 13, { review_at: at(6), depends_on: ['nowhere'] }));
  current.putHandoff(job('new-later', 14, { review_at: at(400) }));
  assert.deepEqual(bridge.dueReviews(at(50), 10).map(item => item.handoff_id), ['new-now', 'old-due', 'new-due', 'new-waits'],
    'due on either side, a newer record hiding its older row, a dependency finished in the older table counts');
  assert.deepEqual(bridge.dueReviews(at(50), 2).map(item => item.handoff_id), ['new-now', 'old-due'], 'at most the limit');
  assert.equal(bridge.reviewMark(), null);
  bridge.putReviewMark('new-due');
  assert.equal(current.reviewMark(), 'new-due', 'the mark is kept by the record store');
});

test('a store on records reads its due work from the review index and keeps the mark as one of its facts', () => {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  const tables = agentRecordStore({ records, transaction: host.transaction });
  const at = n => iso(Date.UTC(2026, 9, 7) + n * 1000);
  const job = (name, n, extra = {}) => ({ handoff_id: name, state: 'open', handed_at: at(n), review_at: at(n + 100), ...extra });
  tables.putHandoff(job('dependency', 1, { state: 'finished' }));
  tables.putHandoff(job('now', 2, { review_at: '' }));
  tables.putHandoff(job('due', 3, { review_at: at(5) }));
  tables.putHandoff(job('waits-on-finished', 4, { review_at: at(5), depends_on: ['dependency'] }));
  tables.putHandoff(job('waits-on-open', 5, { review_at: at(5), depends_on: ['later'] }));
  tables.putHandoff(job('later', 6, { review_at: at(500) }));
  tables.putHandoff(job('walled', 7, { in_the_way: 'Waiting for a sign-in', in_the_way_by: 'a', review_at: at(5) }));
  assert.deepEqual(tables.dueReviews(at(50), 10).map(item => item.handoff_id), ['now', 'due', 'waits-on-finished']);
  assert.deepEqual(tables.dueReviews(at(50), 1).map(item => item.handoff_id), ['now']);
  assert.equal(tables.reviewMark(), null);
  tables.putReviewMark('due');
  assert.equal(tables.reviewMark(), 'due');
  tables.putReviewMark(null);
  assert.equal(tables.reviewMark(), null);
});
