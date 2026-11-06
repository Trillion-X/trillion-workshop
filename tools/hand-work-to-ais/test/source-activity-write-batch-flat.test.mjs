// Ported from old trillion test/source-activity-write-batch-flat.test.mjs (tag old-trillion-before-worker-retire,
// b6ae0ebf81), deleted by Trillion-X/trillion #243. The old test posted /inbound to the retired PersonStore, which handed
// the arrival's source heartbeat to agents.sourceActive, over test/store-cost-for-tests.mjs costingHost. Here
// agents.sourceActive (tools/shared-code/src/agents.mjs) is called with the arrival's conversation and time, over this
// tool's agentRecordStore on keep-and-wake's record-log store, and a small counter below stands in for costingHost:
// statements, rows each hands back, and rows SQLite says were changed (total_changes()).
// Left out: the owner grant (src/payment.mjs ownerGrantEffect, only so the retired /inbound route would accept) and the two
// assertions on the access and scope projections (person_access_inputs, scope_links), which the retired PersonStore
// kept on each write: searched the three repos for person_access_inputs and scope_links; only a table name in trillion-rust
// src/storage/record_store_resources.json, a comment in decide-with-a-method and the record-scope.json about text, no
// running code keeps either table on a write.
// Source heartbeats update each affected job's timing and queue indexes in one record-owner batch. Access and scope
// projections must ask about that batch once in bounded exact-key pages, rather than repeat a query for every job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { RECORD_INDEXES } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentRecordStore } from '../agent-records.mjs';

// What one call costs the store: statements, rows handed back, rows changed (old test/store-cost-for-tests.mjs).
function costingHost() {
  const host = sqliteHost(':memory:');
  let counting = null;
  const changes = () => host.db.prepare('SELECT total_changes() AS n').get().n;
  const sql = { exec(query, ...params) {
    const cursor = host.sql.exec(query, ...params);
    if (!counting) return cursor;
    const rows = cursor.toArray();
    counting.statements += 1;
    counting.read += rows.length;
    return cursor;
  } };
  const measure = async work => {
    counting = { statements: 0, read: 0 };
    const before = changes();
    try { await work(); } finally { counting.written = changes() - before; }
    const cost = counting;
    counting = null;
    return cost;
  };
  return { host, sql, measure };
}

const SOURCE = 'source-activity-flat-chat';
const BASE = Date.now() - 10 * 60_000;
const arrival = (row, minutes) => ({ source_id: SOURCE, at: new Date(BASE + minutes * 60_000).toISOString() });
// The heartbeat an arrival in the conversation gives (the old /inbound's call): its own time, never the clock's.
const heartbeat = (agents, row, minutes) => agents.sourceActive({ source_id: SOURCE, active_at: arrival(row, minutes).at });
async function seeded(n) {
  const host = costingHost();
  const records = recordLogStore(host.sql, { transaction: host.host.transaction, indexes: RECORD_INDEXES });
  let saved = null;
  const store = { ...agentRecordStore({ records, transaction: host.host.transaction }),
    savedInstructions: () => structuredClone(saved), putSavedInstructions: list => { saved = structuredClone(list); } };
  const agents = makeAgents({ store });
  agents.publish({ agent_id: 'source-chat', name: 'Source chat', description: 'Its own transcript', source_id: SOURCE });
  for (let i = 0; i < n; i++) {
    const handed = agents.handOff({ job: `Check queued launch work ${i}`, request_key: `source-flat-${i}`,
      input: { arrived: { source_id: SOURCE, chat_silence_minutes: i % 2 ? 30 : 60 } } }).handoff;
    const old = store.handoff(handed.handoff_id);
    store.putHandoff({ ...old, handed_at: new Date(BASE - 60_000).toISOString(), source_active_at: new Date(BASE).toISOString() });
  }
  heartbeat(agents, 'warm', 1);
  return { host, agents, store };
}

test('actual inbound with N and 4N same-conversation jobs batches projection lookups while extending every deadline', async () => {
  const costOf = async n => {
    const { host, agents, store } = await seeded(n);
    const cost = await host.measure(async () => { heartbeat(agents, 'measured', 2); });
    const jobs = store.openForSource(SOURCE);
    assert.ok(jobs.length >= n);
    assert.ok(jobs.every(job => job.source_active_at >= arrival('measured', 2).at), 'all source-linked jobs extend at the same authored time');
    return cost;
  };
  const a = await costOf(25), b = await costOf(100);
  console.log(`same-source inbound: 25 -> ${a.statements} statements ${a.read} read ${a.written} written; 100 -> ${b.statements} ${b.read} ${b.written}`);
  assert.ok(b.statements <= a.statements * 1.5 + 2, `source heartbeat statements grew ${a.statements} -> ${b.statements}`);
  assert.ok(b.read <= a.read * 1.5 + 2, `rows read grew ${a.read} -> ${b.read}`);
  assert.ok(b.written <= a.written * 1.5 + 2, `rows written grew ${a.written} -> ${b.written}`);
});
