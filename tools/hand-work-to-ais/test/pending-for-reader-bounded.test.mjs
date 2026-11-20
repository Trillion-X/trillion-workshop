// Ported from old trillion test/pending-for-reader-bounded.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old test took agents from the retired PersonStore over the
// test/person-store-reads-for-tests.mjs countingHost; here makeAgents (tools/shared-code/src/agents.mjs) runs over this
// tool's agentRecordStore (agent-records.mjs, old src/agent-records.mjs) on keep-and-wake's record-log store, over the
// countingHost rebuilt below, and the cold start builds those three again on the same SQLite. Every assertion is the old one.
// Fails today (2026-11-06): the rows bound, 58 rows at N and about 150 at 4N; the 4N store holds four sorted runs where
// N holds one, and the greeting probes each (record_keys_run_*), so what it reads grows with the store's history.
// test/pending-for-reader-bounded.test.mjs
//
// What greeting a connecting AI may read (agents pendingForReader, which the account's own records answer as
// claims:pendingForReader on every MCP initialize, src/standalone-resource-behavior.mjs). On Avery's store
// it took 66k rows and 3,600 statements a call: a reader that published a card for every chat it was ever in
// (hundreds), each card with open work. The greeting needs a few titles, so what it reads must not grow with the
// reader's cards or with the open work addressed to them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { RECORD_INDEXES } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentRecordStore } from '../../shared-code/src/agent-records.mjs';

// What each statement hands back, counted (old test/person-store-reads-for-tests.mjs countingHost).
function countingHost() {
  const host = sqliteHost(':memory:');
  const reads = [];
  // A new handle each time it is asked: nothing an owner keeps beside its SQLite handle carries into a fresh start.
  const handle = () => ({ exec(query, ...params) {
    const cursor = host.sql.exec(query, ...params);
    const rows = cursor.toArray();
    reads.push({ query, params, rows: rows.length });
    return cursor;
  } });
  return { host, handle, take: () => reads.splice(0) };
}
// One clock that moves a millisecond each time it is read, so no two handoffs are handed at the same instant: with the
// wall clock, jobs handed within one millisecond tie on "the oldest" and come back in the order of their ids.
let clock = Date.parse('2026-11-06T12:00:00.000Z');
const nextInstant = () => new Date(clock += 1);
// The person's agents over the counted SQLite, as a fresh start builds them (old personStoreOver).
function agentsOver(counted, indexes = RECORD_INDEXES) {
  const records = recordLogStore(counted.handle(), { transaction: counted.host.transaction, indexes });
  let saved = null;
  const store = { ...agentRecordStore({ records, transaction: counted.host.transaction, cardsMoving: () => false }),
    savedInstructions: () => structuredClone(saved), putSavedInstructions: list => { saved = structuredClone(list); } };
  return Object.assign(makeAgents({ store, now: nextInstant }), { records });
}

const N = 100;
const ROWS_FLOOR = 40;
const STATEMENTS_FLOOR = 60;

async function greetingReads(cards) {
  const store = countingHost();
  const agents = agentsOver(store);
  for (let i = 0; i < cards; i += 1) {
    agents.publish({ agent_id: `chat-${i}`, name: `Chat ${i}`, description: 'A chat', takes_work: true, source_id: `source-${i}`, capacity: { max_concurrent: 5 } }, { reader: 'key:Avery' });
    for (let j = 0; j < 3; j += 1) agents.handOff({ request_key: `k-${i}-${j}`, job: `Job ${i}.${j}`, to_agent: `chat-${i}`, priority: j });
  }
  for (let i = 0; i < cards; i += 1) agents.publish({ agent_id: `other-${i}`, name: `Other ${i}`, description: 'Someone else', takes_work: true, capacity: { max_concurrent: 5 } }, { reader: `key:other-${i}` });
  // Work kept before the reader facts existed gets them a step at a time, as each greeting passes; measure once it has.
  for (let step = 0; step < 400; step += 1) {
    store.take();
    agents.pendingForReader('key:Avery');
    if (!store.take().some(read => /INSERT INTO record_log/.test(read.query))) break;
  }
  // The store answers a greeting from a fresh start, as it does after each of the resets it has: nothing is warm. The
  // log is sealed into its sorted runs first (records.checkpoint), as a kept store's is: a log still unsealed is loaded
  // whole when a store opens, which would leave the greeting at N reading nothing at all.
  agents.records.checkpoint();
  const cold = agentsOver(store);
  store.take();
  const pending = cold.pendingForReader('key:Avery');
  const reads = store.take();
  if (process.env.SHOW_READS) for (const read of reads) console.log(read.rows, read.query.replace(/\s+/g, ' ').slice(0, 140));
  return { pending, statements: reads.length, rows: reads.reduce((sum, read) => sum + read.rows, 0) };
}

test('greeting a connecting AI reads the same however many cards and open jobs the reader has', { timeout: 600000 }, async () => {
  const small = await greetingReads(N);
  const large = await greetingReads(4 * N);
  console.log(`greeting: ${small.statements} statements ${small.rows} rows for N, ${large.statements} ${large.rows} for 4N`);
  assert.ok(small.pending.length > 0, 'the reader has work waiting');
  assert.deepEqual(small.pending.map(item => item.title), Array.from({ length: 20 }, (_, i) => `Job ${i}.2`), 'the most urgent, then the oldest');
  assert.deepEqual(large.pending.map(item => item.title), Array.from({ length: 20 }, (_, i) => `Job ${i}.2`));
  assert.deepEqual(large.pending.map(item => item.handoff_id).length, small.pending.length, 'the same page of titles');
  // 4N may read at most 1.5x what N reads, with the floor of one page of titles and a probe of each sorted run the record
  // log holds (more runs hold the longer history, not the reader's cards): main reads 214 rows for N and 5,643 for 4N.
  assert.ok(large.rows <= Math.max(small.rows * 1.5, ROWS_FLOOR), `rows ${small.rows} -> ${large.rows}`);
  assert.ok(large.statements <= Math.max(small.statements * 1.5, STATEMENTS_FLOOR), `statements ${small.statements} -> ${large.statements}`);
});

test('moving legacy cards refuse the reader index and retain the existing fallback greeting', () => {
  const counted = countingHost();
  const records = recordLogStore(counted.handle(), { transaction: counted.host.transaction, indexes: RECORD_INDEXES });
  const legacy = { agent_id: 'legacy-chat', reader: 'key:legacy', takes_work: true, name: 'Legacy synthetic card' };
  let legacyReads = 0;
  const store = agentRecordStore({ records, transaction: counted.host.transaction, cardsMoving: () => true,
    firstRows: table => { if (table !== 'agent_cards') return []; legacyReads += 1; return [{ value: legacy }]; } });
  store.putHandoff({ handoff_id: 'synthetic-legacy-job', state: 'open', to_agent: legacy.agent_id, priority: 2,
    handed_at: '2026-11-06T12:00:00Z', job: 'Keep the legacy job visible', from_agent: 'synthetic-sender' });
  assert.equal(store.pendingForReader(legacy.reader, 20), null, 'migration cannot certify the optimized reader view');
  assert.deepEqual(makeAgents({ store }).pendingForReader(legacy.reader), [{
    handoff_id: 'synthetic-legacy-job', title: 'Keep the legacy job visible', from: 'synthetic-sender', created_at: '2026-11-06T12:00:00Z',
  }]);
  assert.ok(legacyReads > 0, 'the fallback actually reads the supplied legacy card owner');
});

test('old index entries use authoritative roots until maintained carried metadata is available', () => {
  const counted = countingHost();
  const oldIndexes = RECORD_INDEXES.map(index => {
    if (index.type !== 'agent-handoff' || index.name !== 'pending_reader') return index;
    const { carry, carry_presence, backfill, ...old } = index;
    return old;
  });
  const before = agentsOver(counted, oldIndexes);
  before.publish({ agent_id: 'old-index-chat', name: 'Synthetic card', description: 'Synthetic', takes_work: true, capacity: { max_concurrent: 5 } }, { reader: 'key:old-index' });
  before.handOff({ request_key: 'old-index-job', job: 'The authoritative old title', to_agent: 'old-index-chat', priority: 3, from_agent: 'synthetic-sender' });
  before.pendingForReader('key:old-index');
  before.records.checkpoint();
  const after = agentsOver(counted);
  const readMany = after.records.readMany;
  const opened = [];
  after.records.readMany = (ids, ...args) => { opened.push(...ids); return readMany(ids, ...args); };
  const pending = after.pendingForReader('key:old-index');
  assert.equal(pending[0].title, 'The authoritative old title');
  assert.equal(pending[0].from, 'synthetic-sender');
  assert.equal(opened.filter(id => id.startsWith('agent-handoff:')).length, 1, 'an unattested index entry never invents a title');
  for (let step = 0; step < 100 && !after.records.indexReady('agent-handoff', 'pending_reader'); step += 1) after.records.maintain();
  assert.equal(after.records.indexReady('agent-handoff', 'pending_reader'), true);
  opened.length = 0;
  assert.deepEqual(after.pendingForReader('key:old-index'), pending, 'backfill preserves the actual greeting');
  assert.deepEqual(opened, [], 'maintained metadata no longer opens the job body');
});
