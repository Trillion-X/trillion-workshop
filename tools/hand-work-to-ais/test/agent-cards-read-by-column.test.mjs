// Ported from old trillion test/agent-cards-read-by-column.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old test opened the retired PersonStore over the cards; here makeAgents
// (tools/shared-code/src/agents.mjs) runs over this tool's agentRecordStore on a counting SQLite handle, and the cards
// kept in the old table are brought into records by tools/move-the-rows-a-persons-store-kept-in-tables tablesIntoRecords,
// as the store's opening did. Left out: the run of `person.activity({})` (the PersonStore's activity screen), which no
// running code serves over agent cards (searched the three repos for "activity(" beside agent cards: none).
//
// What handing work out, taking it, publishing, reviewing open work and greeting a connecting AI may read of the
// account's agent cards. A card is kept for every chat that ever published (322 on Sam Example's store on 2026-10-02), and
// each of these calls read every card whole (store.cards()) to answer a question about one reader, one chat or
// whether anyone takes work. The cards are seeded the way a store from before the card columns kept them, so opening
// the store also proves it fills the columns, and every statement is counted.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { tablesIntoRecords } from '../../move-the-rows-a-persons-store-kept-in-tables/src/tables-into-records.mjs';
import { agentRecordStore, AGENT_RECORD_TABLES } from '../agent-records.mjs';

const CARDS = 600;
// The most card rows one statement may hand back: the few cards that answer the question, never the account's cards.
const FEW = 5;
const at = i => new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString();

// A SQLite handle that counts the rows each statement hands back (old test/person-store-reads-for-tests.mjs countingHost).
function countingHost() {
  const host = sqliteHost(':memory:');
  const reads = [];
  const sql = { exec(query, ...params) {
    const cursor = host.sql.exec(query, ...params);
    const rows = cursor.toArray();
    reads.push({ query, params, rows: rows.length });
    return cursor;
  } };
  return { host, sql, take: () => reads.splice(0) };
}

async function seededStore() {
  const store = countingHost();
  const sql = store.host.sql;
  sql.exec('CREATE TABLE agent_cards (agent_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  store.host.transaction(() => {
    for (let i = 0; i < CARDS; i += 1) {
      const card = { agent_id: `old-${i}`, name: `Chat ${i}`, description: 'A chat that published once', skills: [], harness: 'codex', model: null, takes_work: true, source_id: `chat-${i}`, reader: `key:${i % 50}`, capacity_claim: null, published_at: at(i), finished: 0, delivery: null, last_seen_at: null };
      sql.exec('INSERT INTO agent_cards (agent_id, value) VALUES (?, ?)', card.agent_id, JSON.stringify(card));
    }
  });
  const records = openRecords(store.sql, { transaction: store.host.transaction, hash: text => text });
  // Opening the store brings the earlier table's cards into records.
  const move = tablesIntoRecords({ sql: store.sql, records, transaction: store.host.transaction, tables: AGENT_RECORD_TABLES });
  move.start();
  for (let steps = 0; move.nextAt() !== null; steps += 1) { assert.ok(steps < 50); move.step(); }
  let saved = null;
  const agentStore = { ...agentRecordStore({ records, transaction: store.host.transaction }),
    savedInstructions: () => structuredClone(saved), putSavedInstructions: list => { saved = structuredClone(list); } };
  return { store, agents: makeAgents({ store: agentStore }) };
}

test('hand-offs, takes, publishes, reviews and greetings read the cards that answer them, never every card', { timeout: 600000 }, async () => {
  const { store, agents } = await seededStore();
  const heavy = {};
  const run = (name, call) => {
    store.take();
    const answer = call();
    const reads = store.take().filter(read => /agent_cards/.test(read.query) && read.rows > FEW);
    if (reads.length) heavy[name] = reads.map(read => `${read.rows} rows: ${read.query.replace(/\s+/g, ' ').slice(0, 120)}`);
    return answer;
  };
  run('publish_agent for a chat', () => agents.publish({ agent_id: 'mine', name: 'Mine', description: 'This chat', takes_work: true, source_id: 'chat-new', capacity: { max_concurrent: 5 } }, { reader: 'key:new' }));
  run('publish_agent anyone may hand to', () => agents.publish({ agent_id: 'any', name: 'Any', description: 'Takes any work', takes_work: true, capacity: { max_concurrent: 5 } }, { reader: 'key:any' }));
  const fromChat = run('hand_off from a chat', () => agents.handOff({ request_key: 'from-chat', job: 'Answer the message', input: { arrived: { source_id: 'chat-new' } } })).handoff;
  assert.equal(fromChat.to_agent, 'mine', 'work from a chat goes to the one card publishing for that chat');
  const unaddressed = run('hand_off to anyone', () => agents.handOff({ request_key: 'to-anyone', job: 'Any AI may do this' })).handoff;
  assert.equal(unaddressed.to_agent, null);
  assert.equal(run('take_work', () => agents.take({ agent_id: 'mine' })).handoff.handoff_id, fromChat.handoff_id);
  assert.equal(run('take_work for anyone', () => agents.take({ agent_id: 'any' })).handoff.handoff_id, unaddressed.handoff_id);
  assert.deepEqual(run('the cards of a reader', () => agents.cardsOfReader('key:new')), ['mine']);
  run('work waiting for a connecting AI', () => agents.pendingForReader('key:any'));
  const described = run('describe one agent', () => agents.find({ agent_id: 'mine', all: true }));
  run('the reconciler', () => agents.reconcile());
  assert.deepEqual(heavy, {}, 'calls that read every agent card');
  assert.deepEqual(described.agents.map(agent => agent.agent_id), ['mine'], 'describing one agent gives that agent');
  // A card a store kept in its table before is found by the same facts once it is a record.
  assert.deepEqual(agents.cardsOfReader('key:7').filter(id => id.startsWith('old-')).sort(), ['old-107', 'old-157', 'old-207', 'old-257', 'old-307', 'old-357', 'old-407', 'old-457', 'old-507', 'old-557', 'old-57', 'old-7']);
});
