// Ported from old trillion test/notification-legacy-upgrade.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The first test is the old one: the legacy bridge (agent-legacy-rows.mjs here) under the
// notification reader (tools/show-the-person-one-list-of-what-happened-for-them) while the table mover
// (move-the-rows-a-persons-store-kept-in-tables) moves the old agent table. The other two ran methods cut out of old
// src/person-store.mjs (its agent-table maintenance and its notifications and agentRecordStore methods); that file went with
// the Worker and no running code composes those owners so (searched agentTablesMove, notifications() over agentRecordStore
// in trillion-workshop tools/, trillion-apps web/, trillion-rust src/), so they are left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { agentRecordStore, AGENT_RECORD_TABLES } from '../agent-records.mjs';
import { agentLegacyRows } from '../agent-legacy-rows.mjs';
import { tablesIntoRecords } from '../../move-the-rows-a-persons-store-kept-in-tables/src/tables-into-records.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { readPersonNotifications } from '../../show-the-person-one-list-of-what-happened-for-them/src/person-notifications.mjs';

const now = new Date('2026-10-07T23:30:00.000Z');
const result = { handoff_id: 'legacy-kept', job: 'A checked result', said: 'A checked result', state: 'finished', handed_at: '2026-10-01T00:00:00.000Z', finished_at: '2026-10-07T23:20:00.000Z', from_agent: 'trillion-workflow', summary: 'Checked outcome' };
const projection = (sql, agents) => readPersonNotifications(sql, { requests: async () => [], spaces: async () => [], work: async options => agents.notificationWork(options) }, { now });
function oldSqlFixture(count = 1) {
  const host = sqliteHost(':memory:');
  host.sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  for (let n = 0; n < count; n++) {
    const job = n ? { ...result, handoff_id: `old-internal-${n}`, from_agent: 'trillion-workshop' } : result;
    host.sql.exec('INSERT INTO agent_handoffs VALUES (?, 0, NULL, ?, ?)', job.handoff_id, job.handed_at, JSON.stringify(job));
  }
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  const move = tablesIntoRecords({ sql: host.sql, records, transaction: host.transaction, tables: AGENT_RECORD_TABLES, batch: 8 });
  move.start();
  const current = agentRecordStore({ records, transaction: host.transaction, heldSummaryReady: () => move.firstDone('agent_handoffs'), cardsMoving: () => !move.firstDone('agent_cards') });
  for (let n = 0; n < 60; n++) current.putHandoff({ ...result, handoff_id: `new-internal-${n}`, from_agent: 'trillion-workshop' });
  const bridge = agentLegacyRows({ sql: host.sql, records, current, placeOf: move.placeOf });
  return { host, records, move, current, bridge, agents: makeAgents({ store: bridge, now: () => now }) };
}

test('ready record indexes cannot hide SQL-only history through the actual legacy bridge', async () => {
  const f = oldSqlFixture(18);
  while (!f.move.firstReady()) f.move.step();
  assert.equal(f.records.indexReady('agent-handoff', 'notice_finished'), true);
  assert.equal(f.move.firstDone('agent_handoffs'), true, 'first pass covers open work, not finished history');
  assert.equal(f.records.typeOf('agent-handoff:legacy-kept'), null);
  assert.ok(f.bridge.finishedHandoffs({ limit: 100 }).some(item => item.handoff_id === result.handoff_id));
  let historyReads = 0;
  const exec = f.host.sql.exec;
  f.host.sql.exec = (query, ...args) => { if (/SELECT.*(?:value|\*) .*FROM agent_handoffs/i.test(query)) historyReads++; return exec(query, ...args); };
  await assert.rejects(projection(f.host.sql, f.agents), error => error.notification_index_building === true);
  assert.equal(historyReads, 0, 'readiness does not sort or hydrate the unmoved SQL history');
  for (let n = 0; f.move.placeOf('agent_handoffs').moved !== true; n++) { assert.ok(n < 20); f.move.step(); }
  assert.deepEqual((await projection(f.host.sql, f.agents)).items.map(row => row.id), ['handoff:legacy-kept:finished'], 'the same cached bridge delegates once all history is moved');
});
