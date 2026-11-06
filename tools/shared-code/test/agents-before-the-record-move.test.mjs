// Ported from old trillion test/agents-before-the-record-move.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. A store still on the decomposed record tables opens its agents as records, never making
// an agent table: work it kept in the earlier agent tables is read as it is, a change to such a job is a record that hides the
// old row, and once the store is on the log engine the earlier tables move into records and are dropped. The old test booted
// a whole person store (test/fault/simulated-person.mjs bootPerson over src/person-store.mjs), which went with the Worker.
// What that store composed runs here, and personOver below composes it as old src/person-store.mjs did (agentRecordStore,
// agentRecordsBeforeMove and agentTablesMove, its lines 6464-6493 at the tag): the record engine and record move of
// keep-and-wake-ai-sessions-on-this-computer, tools/hand-work-to-ais agent-records.mjs and agent-legacy-rows.mjs, the table
// mover of move-the-rows-a-persons-store-kept-in-tables and src/agents.mjs here. Every assertion is the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { LOG_ENGINE, openRecords, setRecordEngine } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { makeRecordMove } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-move.mjs';
import { agentRecordStore, AGENT_RECORD_TABLES } from '../../hand-work-to-ais/agent-records.mjs';
import { agentLegacyRows } from '../../hand-work-to-ais/agent-legacy-rows.mjs';
import { tablesIntoRecords } from '../../move-the-rows-a-persons-store-kept-in-tables/src/tables-into-records.mjs';
import { CARD_COLUMNS, cardColumnsOf, JOB_COLUMNS, jobColumnsOf, makeAgents } from '../src/agents.mjs';

// The person store's records, record move and agents, composed as old src/person-store.mjs composed them.
function personOver({ sql, transaction }) {
  const hash = text => text; // the set identities' hash, as test/agent-store-for-tests.mjs gives it
  const eeaf = openRecords(sql, { transaction, hash });
  let tablesMove = null, recordMove = null;
  const person = {
    store: { eeaf },
    agentTablesMove: () => (tablesMove ??= tablesIntoRecords({ sql, records: eeaf, transaction, tables: AGENT_RECORD_TABLES })),
    recordMove: () => (recordMove ??= makeRecordMove({ sql, records: eeaf, transaction, hash })),
    agentRecordStore() {
      if (eeaf.engine() !== LOG_ENGINE) {
        const earlier = new Set(sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${AGENT_RECORD_TABLES.map(() => '?').join(', ')})`,
          ...AGENT_RECORD_TABLES.map(owner => owner.table)).toArray().map(row => row.name));
        const current = agentRecordStore({ records: eeaf, transaction, heldSummaryReady: () => !earlier.has('agent_handoffs'), cardsMoving: () => earlier.has('agent_cards') });
        return earlier.size ? agentLegacyRows({ sql, records: eeaf, current, placeOf: () => ({}) }) : current;
      }
      const move = person.agentTablesMove();
      move.start();
      const current = agentRecordStore({ records: eeaf, transaction, heldSummaryReady: () => move.firstDone('agent_handoffs'), cardsMoving: () => !move.firstDone('agent_cards') });
      return move.nextAt() === null ? current : agentLegacyRows({ sql, records: eeaf, current, placeOf: move.placeOf });
    },
    agents() {
      person.agentStore = person.agentRecordStore();
      return makeAgents({ store: person.agentStore });
    },
  };
  return person;
}

const at = n => new Date(Date.UTC(2026, 9, 5) + n * 1000).toISOString();
const job = (n, extra = {}) => ({ handoff_id: `h_${n}`, job: `job ${n}`, state: 'open', handed_at: at(n), to_agent: null, taken_by: null, priority: 0, hold_minutes: 60, generation: 0, revision: 1, ...extra });
const agentTables = sql => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent\\_%' ESCAPE '\\' ORDER BY name").toArray().map(row => row.name);

// The agent tables as an earlier version of the store kept them: a column for each fact a question asks.
function earlierAgentTables(sql) {
  sql.exec(`CREATE TABLE agent_cards (agent_id TEXT PRIMARY KEY, value TEXT NOT NULL, ${CARD_COLUMNS.join(', ')})`);
  sql.exec(`CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL, ${JOB_COLUMNS.join(', ')})`);
  sql.exec('CREATE INDEX agent_handoffs_unfilled ON agent_handoffs (open) WHERE state IS NULL');
  const card = { agent_id: 'mac', name: 'Mac', takes_work: true, reader: null, published_at: at(0) };
  const cardColumns = cardColumnsOf(card);
  sql.exec(`INSERT INTO agent_cards (agent_id, value, ${CARD_COLUMNS.join(', ')}) VALUES (?, ?, ${CARD_COLUMNS.map(() => '?').join(', ')})`, 'mac', JSON.stringify(card), ...CARD_COLUMNS.map(name => cardColumns[name]));
  for (const item of [job(1, { state: 'finished', result: 'done long ago' }), job(2)]) {
    const columns = jobColumnsOf(item);
    sql.exec(`INSERT INTO agent_handoffs (handoff_id, open, parent, handed_at, value, ${JOB_COLUMNS.join(', ')}) VALUES (?, ?, NULL, ?, ?, ${JOB_COLUMNS.map(() => '?').join(', ')})`,
      item.handoff_id, item.state === 'finished' ? 0 : 1, item.handed_at, JSON.stringify(item), ...JOB_COLUMNS.map(name => columns[name]));
  }
}

test('agents open as records before the record move, read earlier tables once, and those tables go after the switch', async () => {
  const database = sqliteHost(':memory:');
  setRecordEngine(database.sql, 'eeaf');
  earlierAgentTables(database.sql);
  const before = agentTables(database.sql);
  const person = personOver(database);
  assert.notEqual(person.store.eeaf.engine(), LOG_ENGINE, 'the store is still on the decomposed tables');
  const agents = person.agents();
  assert.equal(agents.read({ handoff_id: 'h_2' }).handoff.state, 'open', 'an open job kept in the earlier table is read');
  assert.equal(agents.read({ handoff_id: 'h_1' }).handoff.state, 'finished');

  // Taking the job that exists only as an earlier row writes a record that hides it.
  assert.equal(agents.take({ agent_id: 'mac', handoff_id: 'h_2' }).handoff.handoff_id, 'h_2');
  assert.equal(person.store.eeaf.read('agent-handoff:h_2')?.state, 'taken', 'the change is a record');
  assert.equal(JSON.parse(database.sql.exec("SELECT value FROM agent_handoffs WHERE handoff_id = 'h_2'").toArray()[0].value).state, 'open', 'the earlier row is left as it was');
  assert.equal(agents.read({ handoff_id: 'h_2' }).handoff.state, 'taken', 'the newer state is read, never the earlier row');
  const open = person.agentStore.openHandoffs({ limit: 50 }).filter(item => item.handoff_id === 'h_2');
  assert.equal(open.length, 1, 'the job is read once');
  assert.equal(open[0].state, 'taken');
  agents.finish({ handoff_id: 'h_2', agent_id: 'mac', result: 'done before the move' });
  assert.equal(agents.read({ handoff_id: 'h_2' }).handoff.state, 'finished');
  assert.deepEqual(agentTables(database.sql), before, 'no agent table was made');

  // The store moves to the log engine; its earlier agent tables then move into records and are dropped.
  for (let steps = 0; person.store.eeaf.engine() !== LOG_ENGINE; steps += 1) { assert.ok(steps < 50, 'the record move switches'); person.recordMove().step(); }
  const moved = person.agents();
  for (let steps = 0; person.agentTablesMove().nextAt() !== null; steps += 1) { assert.ok(steps < 50, 'the agent tables move'); person.agentTablesMove().step(); }
  assert.deepEqual(agentTables(database.sql).filter(name => before.includes(name)), [], 'the earlier agent tables are gone');
  assert.equal(moved.read({ handoff_id: 'h_2' }).handoff.state, 'finished', 'the job reads back the same from records alone');
  assert.equal(moved.read({ handoff_id: 'h_2' }).handoff.result, 'done before the move');
  assert.equal(moved.read({ handoff_id: 'h_1' }).handoff.state, 'finished', 'work finished long before moves in too');
  assert.equal(moved.cardOf('mac')?.name, 'Mac');
});
