import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { setRecordEngine } from '../src/record-engine.mjs';
import { decisionStore } from '../src/decision-store.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { scheduledHandoffOf } from '../../shared-code/src/agents.mjs';
const handed = '2026-10-11T10:00:00.000Z';
const job = (id, history) => ({ handoff_id: id, handed_at: handed, state: 'taken', to_agent: null, taken_by: 'ai:a', generation: 7,
  priority: 3, hold_until: '2026-10-11T11:00:00.000Z', input: { arrived: { source_id: 'fixture', depth: 1, from_person: false } },
  corrections: Array.from({ length: history }, (_, n) => ({ report_id: 'report-' + n, text: 'x'.repeat(4096) })) });
for (const engine of ['record-log', 'eeaf']) {
  test(`${engine}: held scheduling selects exact scalar schedule despite adversarial history, with legacy fallback`, () => {
    const host = sqliteHost(':memory:');
    try {
      setRecordEngine(host.sql, engine);
      const records = decisionStore(host.sql, { transaction: host.transaction }).eeaf;
      assert.equal(records.engine(), engine);
      const owner = agentRecordStore({ records, transaction: host.transaction });
      const small = job('small', 32), large = job('large', 128), legacy = job('legacy', 2);
      owner.transaction(() => { for (const item of [small, large, legacy]) owner.putHandoff(item); });
      const stored = records.read('agent-handoff:legacy'); delete stored.schedule;
      records.write([{ id: 'agent-handoff:legacy', type: 'agent-handoff', value: stored }]);
      records.checkpoint();
      const fresh = decisionStore(host.sql, { transaction: host.transaction }).eeaf;
      const bodies = [];
      const guarded = { ...fresh, read(id) { if (id.startsWith('agent-handoff:')) { bodies.push(id); assert.equal(id, 'agent-handoff:legacy', 'current scheduling must not hydrate full handoff body'); } return fresh.read(id); } };
      const reopened = agentRecordStore({ records: guarded, transaction: host.transaction });
      const expected = [small, large, legacy].map(item => scheduledHandoffOf(item));
      const actual = reopened.scheduledWake.held('ai:a');
      assert.deepEqual(new Map(actual.map(item => [item.handoff_id, item])), new Map(expected.map(item => [item.handoff_id, item])));
      assert.deepEqual(bodies, ['agent-handoff:legacy']);
      owner.putHandoff({ ...large, state: 'finished' });
      const after = agentRecordStore({ records: decisionStore(host.sql, { transaction: host.transaction }).eeaf, transaction: host.transaction }).scheduledWake.held('ai:a');
      assert.ok(!after.some(item => item.handoff_id === 'large'));
      owner.putHandoff({ ...small, generation: 8, taken_by: 'ai:b' });
      const moved = agentRecordStore({ records: decisionStore(host.sql, { transaction: host.transaction }).eeaf, transaction: host.transaction });
      assert.ok(!moved.scheduledWake.held('ai:a').some(item => item.handoff_id === 'small'));
      assert.equal(moved.scheduledWake.held('ai:b')[0].generation, 8);
    } finally { host.db.close(); }
  });
}
