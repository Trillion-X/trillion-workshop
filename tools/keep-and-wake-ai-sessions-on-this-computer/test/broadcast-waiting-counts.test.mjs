import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords, setRecordEngine } from '../src/record-engine.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { agentLegacyRows } from '../../hand-work-to-ais/agent-legacy-rows.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { MAX_WAITING } from '../../shared-code/src/agent-delivery.mjs';
const now = '2026-10-11T09:00:00.000Z';
const delivery = (agent, n, state = 'waiting') => ({ event_id: `${agent}:${state}:${n}`, agent_id: agent, state,
  created_at: now, next_at: null, attempts: 0, event: { subject_id: 'fixture' } });
for (const engine of ['record-log', 'eeaf']) {
  test(`${engine}: selected waiting counts match scalar owner through limits, tombstones and replacements`, () => {
    const host = sqliteHost(':memory:');
    try {
      setRecordEngine(host.sql, engine);
      const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
      assert.equal(records.engine(), engine);
      const owner = agentRecordStore({ records, transaction: host.transaction });
      for (let n = 0; n < 10; n++) owner.putDelivery(delivery('a', n));
      for (let n = 0; n < 5; n++) owner.putDelivery(delivery('b', n));
      for (let n = 0; n < 20; n++) owner.putDelivery(delivery('a', n, 'dead'));
      owner.putDelivery({ ...delivery('a', 0), state: 'delivered' });
      records.write([{ id: 'agent-delivery:b:waiting:0', type: 'agent-delivery', value: null }]);
      records.checkpoint();
      for (const limit of [0, 1, 5, MAX_WAITING, Infinity]) {
        const expected = new Map(['a', 'b', 'none'].map(id => [id, owner.waitingFor(id, limit)]));
        assert.deepEqual(owner.waitingForMany(['b', 'a', 'none', 'a'], limit), new Map(['b', 'a', 'none'].map(id => [id, expected.get(id)])));
      }
      assert.deepEqual(owner.waitingForMany([], 200), new Map());
      assert.deepEqual(records.scanSelectedValues('agent-delivery', 'agent', { values: ['b', 'a'], suffix: ['waiting'], limit: 3 }),
        ['b', 'a'].flatMap(id => records.scan('agent-delivery', 'agent', { equal: [id, 'waiting'], limit: 3 }))
          .sort((a,b) => JSON.stringify(a.values) < JSON.stringify(b.values) ? -1 : JSON.stringify(a.values) > JSON.stringify(b.values) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      assert.throws(() => records.scanSelectedValues('agent-delivery', 'agent', { values: ['a'], suffix: ['waiting', '', 'too far'], limit: 1 }), /suffix/);
    } finally { host.db.close(); }
  });
}

test('broadcast callers use one selected snapshot and keep cap, placement, sender and event idempotence', () => {
  const cards = [{ agent_id: 'sender', delivery: { stream: true }, runs: ['run'] }, { agent_id: 'available', delivery: { stream: true }, runs: ['run'] },
    { agent_id: 'full', delivery: { stream: true }, runs: ['run'] }, { agent_id: 'other', delivery: { stream: true }, runs: [] }];
  const events = new Map(); const questions = [];
  const store = { card: id => cards.find(row => row.agent_id === id), reachableCards: () => cards,
    waitingForMany: (ids, limit) => { questions.push({ ids, limit }); return new Map(ids.map(id => [id, id === 'full' ? MAX_WAITING : 0])); },
    waitingFor: () => assert.fail('packed owner must be selected once'),
    delivery: id => events.get(id) ?? null, putDelivery: value => events.set(value.event_id, value) };
  const owner = makeAgents({ store, now: () => new Date(now) });
  const said = { type: 'fixture.ready', key: 'same-result', from_agent: 'sender', subject_id: 'fixture', refs: {}, next_call: null };
  assert.deepEqual(owner.tellEveryone(said), { told: 2 });
  assert.equal(events.size, 2);
  assert.deepEqual(questions[0], { ids: ['available', 'full', 'other'], limit: MAX_WAITING });
  assert.deepEqual(owner.tellEveryone(said), { told: 2 }); assert.equal(events.size, 2);
  const runner = owner.tellRunners({ ...said, placement: 'run', key: 'runner-result' });
  assert.equal(runner.told, 2, 'runner road keeps its original inclusion of sender');
  assert.deepEqual(questions.at(-1).ids, ['sender', 'available', 'full']);
  const scalarQuestions = [];
  const scalar = makeAgents({ store: { ...store, waitingForMany: undefined, waitingFor: id => { scalarQuestions.push(id); return id === 'full' ? MAX_WAITING : 0; } }, now: () => new Date(now) });
  assert.deepEqual(scalar.tellEveryone(said), { told: 2 });
  assert.deepEqual(scalarQuestions, ['available', 'full', 'other']);
});

test('legacy bridge keeps its scalar capped shadow-aware owner instead of silently selecting current-only counts', () => {
  const host = sqliteHost(':memory:');
  try {
    const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
    const current = agentRecordStore({ records, transaction: host.transaction });
    host.sql.exec('CREATE TABLE agent_deliveries (event_id TEXT PRIMARY KEY, agent_id TEXT, state TEXT, next_at TEXT, value TEXT)');
    host.sql.exec('CREATE INDEX agent_deliveries_agent ON agent_deliveries(agent_id,state)');
    for (const row of [delivery('old', 0), delivery('old', 1)]) host.sql.exec('INSERT INTO agent_deliveries VALUES (?,?,?,?,?)', row.event_id, row.agent_id, row.state, row.next_at, JSON.stringify(row));
    current.putDelivery({ ...delivery('old', 0), state: 'dead' });
    const legacy = agentLegacyRows({ sql: host.sql, records, current, placeOf: () => ({ first_after: 0, first_done: false, after: 0 }) });
    assert.equal(legacy.waitingForMany, undefined, 'no current-only batch leaks across legacy shadow owner');
    assert.equal(legacy.waitingFor('old', 200), 1);
    assert.equal(legacy.waitingFor('old', 0), 0);
  } finally { host.db.close(); }
});
