// Ported from old trillion test/held-work-reads-walk-an-index.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. Held-work and pending-work reads walk the who-holds and who-is-addressed indexes of the
// agents' records (agent-records.mjs here), and the read-only bridge over the earlier agent tables (agent-legacy-rows.mjs
// here) seeks bounded pages. The old test built the whole old person store (src/person-store.mjs through esbuild and
// test/workers-stand-in-for-tests.mjs) and read its records and agent store; here the store is the record engine of
// keep-and-wake-ai-sessions-on-this-computer with agentRecordStore over it, which is what the person store handed these
// reads. Those three tests are the old ones. The other fourteen were activity capture and payment history through that
// person store (old src/payment.mjs accessFrom, ownerGrantEffect, readsHistory and the store's activity and capture
// routes); src/payment.mjs and the person store run nowhere (searched paymentAccessFoldLimits, ownerGrantEffect, PersonStore
// in trillion-workshop tools/, trillion-apps web/, trillion-rust src/), so they are left out.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { JOB_COLUMNS, jobColumnsOf } from '../../shared-code/src/agents.mjs';
import { agentRecordStore } from '../agent-records.mjs';
import { agentLegacyRows } from '../agent-legacy-rows.mjs';

// The store these reads ran over: its records, and the agent store kept on them.
async function personStore() {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction });
  const store = { records, transaction: host.transaction, agentStore: agentRecordStore({ records, transaction: host.transaction }) };
  return { store, sql: host.sql };
}

// The agent tables an earlier version of the store kept, with the indexes it kept them by, read through the store's
// read-only bridge (src/agent-legacy-rows.mjs) as a store does until they have moved into records.
function earlierAgentTables({ records, transaction }, sql) {
  sql.exec(`CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL, ${JOB_COLUMNS.join(', ')})`);
  sql.exec('CREATE INDEX agent_handoffs_unfilled ON agent_handoffs (open) WHERE state IS NULL');
  sql.exec('CREATE INDEX agent_handoffs_addressed ON agent_handoffs (open, to_agent, handed_at, handoff_id)');
  sql.exec("CREATE INDEX agent_handoffs_pending ON agent_handoffs (open, state, to_agent, priority DESC, handed_at, handoff_id) WHERE open = 1 AND state = 'open'");
  sql.exec('CREATE INDEX agent_handoffs_queue ON agent_handoffs (open, priority DESC, handed_at, handoff_id, to_agent, prefer_until)');
  sql.exec('CREATE TABLE agent_deliveries (event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, subject_id TEXT NOT NULL, state TEXT NOT NULL, next_at TEXT, value TEXT NOT NULL)');
  sql.exec('CREATE INDEX agent_deliveries_agent ON agent_deliveries (agent_id, state)');
  return agentLegacyRows({ sql, records, current: agentRecordStore({ records, transaction }), placeOf: () => ({}) });
}

// 25 cards taken as one reader and 1200 open jobs addressed to them, twelve of them held, each with a 4 KB input.
async function busyAccount() {
  const made = await personStore();
  const reader = 'key:proof';
  const now = Date.now();
  const store = made.store.agentStore;
  const note = 'x'.repeat(4000);
  store.transaction(() => {
    for (let a = 0; a < 25; a++) store.putCard({ agent_id: `n${a}`, name: `N${a}`, description: 'proof', reader, takes_work: true });
    for (let i = 0; i < 1200; i++) {
      const held = i % 100 === 0;
      store.putHandoff({ handoff_id: `h_${i}`, job: `Job ${i}`, state: held ? 'taken' : 'open', to_agent: `n${i % 25}`, taken_by: held ? `n${i % 25}` : null, taken_at: held ? new Date(now).toISOString() : null, hold_until: held ? new Date(now + 3_600_000).toISOString() : null, handed_at: new Date(now - (1200 - i) * 1000).toISOString(), input: { note, ...(i % 300 === 1 ? { arrived: { source_id: 's' } } : {}) }, ...(i % 300 === 1 ? { to_agent: null } : {}) });
    }
  });
  return { ...made, reader };
}

test('legacy table greeting seeks a bounded ordered page for each recipient', async () => {
  const { store, sql } = await personStore();
  const agents = earlierAgentTables(store, sql);
  const jobs = [];
  const insert = `INSERT INTO agent_handoffs (handoff_id, open, parent, handed_at, value, ${JOB_COLUMNS.join(', ')}) VALUES (?, ?, NULL, ?, ?, ${JOB_COLUMNS.map(() => '?').join(', ')})`;
  sql.exec('BEGIN');
  for (let n = 0; n < 500; n += 1) {
    const item = { handoff_id: `h_${String(n).padStart(4, '0')}`, state: n % 17 === 0 ? 'taken' : 'open',
      to_agent: `n${n % 5}`, priority: (n * 7) % 10, handed_at: new Date(Date.UTC(2026, 9, 5) + Math.floor(n / 3) * 1000).toISOString(),
      job: `Job ${n}`, input: { note: 'x'.repeat(2048) } };
    jobs.push(item);
    const columns = jobColumnsOf(item);
    sql.exec(insert, item.handoff_id, 1, item.handed_at, JSON.stringify(item), ...JOB_COLUMNS.map(name => columns[name]));
  }
  sql.exec('COMMIT');
  const plan = sql.exec(`EXPLAIN QUERY PLAN SELECT handoff_id, priority, handed_at FROM agent_handoffs INDEXED BY agent_handoffs_pending
    WHERE open = 1 AND state = 'open' AND to_agent = ? ORDER BY priority DESC, handed_at, handoff_id LIMIT ?`, 'n1', 20).toArray().map(row => row.detail).join(' ');
  assert.match(plan, /COVERING INDEX agent_handoffs_pending/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  const ids = ['n1', 'n2', 'n3'];
  const expected = jobs.filter(item => item.state === 'open' && ids.includes(item.to_agent))
    .sort((a, b) => b.priority - a.priority || a.handed_at.localeCompare(b.handed_at) || a.handoff_id.localeCompare(b.handoff_id))
    .slice(0, 20).map(item => item.handoff_id);
  assert.deepEqual(agents.pendingAddressedTo(ids, 20).map(item => item.handoff_id), expected);
  assert.deepEqual(agents.pendingAddressedTo(ids, 0), []);
});

test('legacy table delivery admission stops counting at its caller limit', async () => {
  const { store, sql } = await personStore();
  const agents = earlierAgentTables(store, sql);
  sql.exec('BEGIN');
  for (let n = 0; n < 250; n += 1) {
    sql.exec("INSERT INTO agent_deliveries (event_id, agent_id, subject_id, state, next_at, value) VALUES (?, 'mac', 'proof', 'waiting', NULL, '{}')", `event-${n}`);
  }
  sql.exec('COMMIT');
  assert.equal(agents.waitingFor('mac', 200), 200);
  assert.equal(agents.waitingFor('mac'), 250);
});

test('reads of one AI\'s held and addressed work walk an index instead of every open job', async () => {
  const { store } = await busyAccount();
  const agents = store.agentStore;
  const reads = {
    held: () => agents.heldBy('n0').map(item => item.handoff_id),
    addressed: () => agents.openAddressedTo('n1').length,
    pending: () => agents.pendingAddressedTo(['n1', 'n2'], 20).map(item => item.handoff_id),
    unaddressed: () => agents.unaddressedForSource('s').map(item => item.handoff_id),
  };
  assert.deepEqual(reads.held(), ['h_0', 'h_100', 'h_200', 'h_300', 'h_400', 'h_500', 'h_600', 'h_700', 'h_800', 'h_900', 'h_1000', 'h_1100'].filter(id => Number(id.slice(2)) % 25 === 0));
  assert.equal(reads.addressed(), 48 - [1, 301, 601, 901].filter(i => i % 25 === 1).length);
  assert.equal(reads.pending().length, 20);
  assert.deepEqual(reads.unaddressed(), ['h_1', 'h_301', 'h_601', 'h_901']);
  // Timed against walking the jobs on the same machine at the same moment, never against a fixed number of
  // milliseconds: the deploy guard runs on a shared build machine, where a clock moves with its load and moves both
  // sides alike. Walking means opening each of the 1,200 open jobs' JSON once, the cost these reads used to pay.
  const bodies = Array.from({ length: 1200 }, (_, i) => JSON.stringify({ handoff_id: `h_${i}`, input: { note: 'x'.repeat(4000) } }));
  // The fastest of many tries on each side: one garbage collection or a neighbour's burst on the build machine lands in
  // a sub-millisecond read far more often than in the walk, and with 7 tries it failed builds at 3.6x (2026-10-09).
  const fastest = fn => Math.min(...Array.from({ length: 31 }, () => { const started = performance.now(); fn(); return performance.now() - started; }));
  for (const [name, read] of Object.entries(reads)) {
    const walk = fastest(() => { for (const body of bodies) JSON.parse(body); });
    const each = fastest(read);
    assert.ok(each < walk / 4, `${name} took ${each.toFixed(2)} ms; walking the open jobs took ${walk.toFixed(2)} ms`);
  }
});
