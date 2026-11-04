import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords, setRecordEngine } from '../src/record-engine.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import indexData from '../src/record-indexes.json' with { type: 'json' };
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { agentLegacyRows } from '../../hand-work-to-ais/agent-legacy-rows.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { handoffProjection, projectHandoff } from '../../shared-code/src/handoff-projection.mjs';
const projection = { fields: ['finished_at'], presence: [['result', 'withdrawn_by']] };
const at = n => new Date(Date.UTC(2026, 9, 10) + n * 1000).toISOString();
const job = (n, extra = {}) => ({ handoff_id: 'h' + String(n).padStart(3, '0'), state: 'finished', handed_at: at(n), finished_at: at(n), job: 'Do work', from_agent: 'asker', to_agent: 'target', taken_by: 'holder', preferred_agent: 'preferred', in_the_way_by: 'blocker', ...extra });
function fixture(shared = false, engine = 'log') {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, hash: text => text, ...(shared ? { contentId: (type, value) => 'shared:' + createHash('sha256').update(type + JSON.stringify(value)).digest('hex') } : {}) };
  if (engine === 'eeaf') setRecordEngine(host.sql, 'eeaf');
  const records = engine === 'log' ? recordLogStore(host.sql, { ...options, indexes: indexData.indexes }) : openRecords(host.sql, options);
  if (engine === 'eeaf') assert.equal(records.engine(), 'eeaf', 'the fallback witness uses the actual decomposed engine');
  const store = agentRecordStore({ records, transaction: host.transaction });
  for (const id of ['asker', 'target', 'holder', 'preferred', 'blocker']) store.putCard({ agent_id: id, name: id });
  return { host, options, records, store, owner: makeAgents({ store }) };
}
for (const engine of ['log', 'eeaf']) for (const shared of [false, true]) test(`finished projection preserves every withdrawal shape and default on ${engine}, shared=${shared}`, () => {
  const f = fixture(shared, engine);
  try {
    const markers = [null, false, 0, '', {}, [], { large: 'x'.repeat(20000) }];
    markers.forEach((marker, n) => f.store.putHandoff(job(n, { result: { withdrawn_by: marker, response: { text: 'unrelated'.repeat(8000) } }, input: { instructions: 'x'.repeat(40000) }, attempts: [{ input: 'y'.repeat(40000) }] })));
    f.store.putHandoff(job(8, { result: null })); f.store.putHandoff(job(9, { result: { ordinary: true } }));
    f.records.checkpoint(); f.records.forgetCached();
    const full = f.owner.recentWork({ limit: 200, states: ['finished'] });
    const projected = f.owner.recentWork({ limit: 200, states: ['finished'], projection });
    const normalized = handoffProjection(projection);
    assert.deepEqual(projected.work, full.work.map(row => projectHandoff(row, normalized)));
    assert.deepEqual(projected.agents, full.agents);
    assert.deepEqual(new Set(projected.agents.map(row => row.agent_id)), new Set(['asker', 'target', 'holder', 'preferred', 'blocker']));
    assert.equal(projected.work.filter(row => row.field_presence[0]).length, markers.length);
    assert.ok(projected.work.every(row => row.input === undefined && row.result === undefined && row.attempts === undefined && row.job === undefined && row.said === undefined));
    assert.ok(full.work.some(row => row.input?.instructions));
    const read = f.records.read;
    if (engine === 'log') f.records.read = id => { if (id.startsWith('agent-handoff:')) throw Error('Unrequested complete job hydration'); return read(id); };
    assert.deepEqual(f.owner.recentWork({ states: ['finished'], projection }), projected);
  } finally { f.host.db.close(); }
});
test('selection remains newest 200 before exclusion and presence does not refill the page', () => {
  const f = fixture();
  try {
    for (let n = 0; n < 205; n++) f.store.putHandoff(job(n, { from_agent: n >= 5 ? 'trillion-workshop' : 'asker' }));
    assert.deepEqual(f.owner.recentWork({ limit: 200, states: ['finished'], projection }).work, []);
    f.store.putHandoff(job(205)); f.store.putHandoff(job(206));
    assert.deepEqual(f.owner.recentWork({ limit: 1, states: ['finished'], projection }).work.map(row => row.handoff_id), ['h206']);
    assert.deepEqual(f.store.finishedHandoffs({ before: 'h206', limit: 1, projection }).map(row => row.handoff_id), ['h205']);
  } finally { f.host.db.close(); }
});
test('presence follows correction, removal, recreate, reopen and transaction rollback', () => {
  const f = fixture(true), id = 'agent-handoff:h001';
  try {
    const presence = () => f.records.fields.presenceOf('agent-handoff', [id], [['result', 'withdrawn_by']]);
    f.store.putHandoff(job(1, { result: { withdrawn_by: null } })); assert.deepEqual(presence().get(id), [true]);
    f.store.putHandoff(job(1, { result: { normal: true } })); assert.deepEqual(presence().get(id), [false]);
    f.records.write([{ id, value: null }]); assert.equal(presence().has(id), false);
    f.store.putHandoff(job(1, { result: { withdrawn_by: [] } })); assert.deepEqual(presence().get(id), [true]);
    f.records.checkpoint(); const reopened = recordLogStore(f.host.sql, { ...f.options, indexes: indexData.indexes });
    assert.deepEqual(reopened.fields.presenceOf('agent-handoff', [id], [['result', 'withdrawn_by']]).get(id), [true]);
    assert.throws(() => f.host.transaction(() => { reopened.write([{ id, type: 'agent-handoff', value: job(1, { result: {} }) }]); throw Error('rollback witness'); }), /rollback witness/);
    reopened.forgetCached();
    assert.deepEqual(reopened.fields.presenceOf('agent-handoff', [id], [['result', 'withdrawn_by']]).get(id), [true]);
    assert.throws(() => presence() && reopened.fields.presenceOf('agent-handoff', [id], [[]]), /field paths/);
  } finally { f.host.db.close(); }
});
test('legacy shadows and default reads survive projected finished selection', () => {
  const f = fixture();
  try {
    f.host.sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER, parent TEXT, handed_at TEXT, value TEXT)');
    for (const row of [job(3), job(2), job(1)]) f.host.sql.exec('INSERT INTO agent_handoffs VALUES (?, 0, NULL, ?, ?)', row.handoff_id, row.handed_at, JSON.stringify(row));
    f.store.putHandoff(job(2, { state: 'open' }));
    f.records.write([{ id: 'agent-handoff:h003', value: null }]);
    f.records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { after: 1 } }]);
    const bridge = agentLegacyRows({ sql: f.host.sql, records: f.records, current: f.store });
    const full = bridge.finishedHandoffs({ limit: 10 });
    assert.deepEqual(full.map(row => row.handoff_id), ['h001']);
    assert.deepEqual(bridge.finishedHandoffs({ limit: 10, projection }), full.map(row => projectHandoff(row, handoffProjection(projection))));
  } finally { f.host.db.close(); }
});

test('requested object fields keep their values without unrequested body hydration', () => {
  const f = fixture(true);
  try {
    f.store.putHandoff(job(1, { result: { nested: { value: 'exact' } }, input: { unused: 'large'.repeat(5000) } }));
    f.records.checkpoint(); f.records.forgetCached();
    const request = { fields: ['result'], presence: [['result', 'nested', 'value']] };
    const full = f.owner.recentWork({ states: ['finished'] });
    assert.deepEqual(f.owner.recentWork({ states: ['finished'], projection: request }).work, full.work.map(item => projectHandoff(item, handoffProjection(request))));
  } finally { f.host.db.close(); }
});
