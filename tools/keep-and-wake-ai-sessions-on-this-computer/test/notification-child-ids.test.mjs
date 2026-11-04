// Notifications count activity for the complete set of direct children. Their instructions and results are not
// needed to find that set. Both engines and the legacy bridge must preserve membership, shadows and ordering.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords, setRecordEngine } from '../src/record-engine.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { agentLegacyRows } from '../../hand-work-to-ais/agent-legacy-rows.mjs';
import { activityCount, activityCounts, keepActivity } from '../../see-what-my-ais-did/activity.mjs';
// This file writes made-up record types to test how a changed type shadows an earlier one, not shapes the product
// writes, so the deploy guard's strict model (src/record-engine.mjs RECORD_MODEL_STRICT) is off here.
process.env.RECORD_MODEL_STRICT = '';

const at = n => new Date(Date.UTC(2026, 9, 10) + n * 1000).toISOString();
const job = (id, parent, n, extra = {}) => ({ handoff_id: id, parent_handoff_id: parent,
  handed_at: at(n), state: 'finished', job: 'Instructions', result: { detail: 'x'.repeat(1024) }, ...extra });
function opened(engine = 'log') {
  const host = sqliteHost(':memory:');
  if (engine === 'eeaf') setRecordEngine(host.sql, 'eeaf');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  return { host, records, current: agentRecordStore({ records, transaction: host.transaction }) };
}
function withoutBodies(records, fn) {
  const read = records.read, readMany = records.readMany;
  records.read = id => {
    assert.ok(!id.startsWith('agent-handoff:'), 'child identities must not hydrate handoff bodies');
    return read(id);
  };
  records.readMany = ids => {
    assert.ok(!ids.some(id => id.startsWith('agent-handoff:')), 'child identities must not batch-hydrate handoff bodies');
    return readMany(ids);
  };
  try { return fn(); } finally { records.read = read; records.readMany = readMany; }
}

for (const engine of ['log', 'eeaf']) test(`child IDs retain the complete current parent set without bodies (${engine})`, () => {
  const { host, records, current } = opened(engine);
  try {
    current.transaction(() => {
      for (let n = 256; n >= 0; n--) current.putHandoff(job(`child-${String(n).padStart(3, '0')}`, 'parent-a', 1));
      current.putHandoff(job('finished-b', 'parent-b', 2));
      current.putHandoff(job('unrelated', 'other', 0));
    });
    const ids = ['parent-b', 'parent-a', 'parent-b', 'missing'];
    const found = withoutBodies(records, () => current.handedOnIdsFromMany(ids));
    assert.deepEqual([...found.keys()], ['parent-b', 'parent-a', 'missing']);
    assert.deepEqual(found.get('parent-a'), Array.from({ length: 257 }, (_, n) => `child-${String(n).padStart(3, '0')}`));
    assert.deepEqual(found.get('parent-b'), ['finished-b']);
    assert.deepEqual(found.get('missing'), []);
    for (const parent of new Set(ids)) assert.deepEqual(found.get(parent), current.handedOnFrom(parent).map(item => item.handoff_id));
    assert.deepEqual([...withoutBodies(records, () => current.handedOnIdsFromMany([]))], []);
  } finally { host.db.close(); }
});

for (const engine of ['log', 'eeaf']) test(`reparenting, removal and rollback never leak stale child IDs (${engine})`, () => {
  const { host, records, current } = opened(engine);
  try {
    current.putHandoff(job('moving', 'parent-a', 1));
    current.putHandoff(job('removed', 'parent-a', 2));
    current.putHandoff(job('kept', 'parent-a', 3));
    current.putHandoff(job('moving', 'parent-b', 1));
    records.write([{ id: 'agent-handoff:removed', type: 'agent-handoff', value: null }]);
    let found = withoutBodies(records, () => current.handedOnIdsFromMany(['parent-a', 'parent-b']));
    assert.deepEqual(found.get('parent-a'), ['kept']);
    assert.deepEqual(found.get('parent-b'), ['moving']);
    assert.throws(() => current.transaction(() => {
      current.putHandoff(job('rollback', 'parent-a', 0));
      assert.deepEqual(withoutBodies(records, () => current.handedOnIdsFromMany(['parent-a'])).get('parent-a'), ['rollback', 'kept']);
      throw new Error('abort child write');
    }), /abort child write/);
    records.forgetCached();
    found = withoutBodies(records, () => current.handedOnIdsFromMany(['parent-a', 'parent-b']));
    assert.deepEqual(found.get('parent-a'), ['kept']);
    assert.deepEqual(found.get('parent-b'), ['moving']);
    if (engine === 'log') {
      records.checkpoint();
      const reopened = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
      const fresh = agentRecordStore({ records: reopened, transaction: host.transaction });
      assert.deepEqual(withoutBodies(reopened, () => fresh.handedOnIdsFromMany(['parent-a'])).get('parent-a'), ['kept']);
    }
  } finally { host.db.close(); }
});

test('legacy child metadata merges by time, honoring changed parents, type shadows and retained removals', () => {
  const { host, records, current } = opened();
  const sql = host.sql;
  try {
    sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
    sql.exec('CREATE INDEX agent_handoffs_parent ON agent_handoffs(parent)');
    const older = item => sql.exec('INSERT INTO agent_handoffs VALUES (?, ?, ?, ?, ?)', item.handoff_id, item.state === 'finished' ? 0 : 1, item.parent_handoff_id, item.handed_at, JSON.stringify(item));
    older(job('older', 'parent-a', 3));
    older(job('reparented', 'parent-b', 2));
    older(job('removed', 'parent-a', 0));
    older(job('different-type', 'parent-a', 0));
    current.putHandoff(job('reparented', 'parent-a', 2));
    current.putHandoff(job('removed', 'parent-a', 0));
    records.write([{ id: 'agent-handoff:removed', type: 'agent-handoff', value: null },
      { id: 'agent-handoff:different-type', type: 'replacement-record', value: { changed: true } }]);
    current.putHandoff(job('current', 'parent-a', 1));
    current.putHandoff(job('other-parent', 'parent-b', 1));
    const queries = [];
    const traced = { exec(query, ...args) { queries.push(query); return sql.exec(query, ...args); } };
    const places = new Map();
    const bridge = agentLegacyRows({ sql: traced, records, current, placeOf: table => places.get(table) ?? {} });
    queries.length = 0;
    const ids = ['parent-b', 'parent-a', 'parent-b', 'missing'];
    const found = withoutBodies(records, () => bridge.handedOnIdsFromMany(ids));
    assert.deepEqual([...found.keys()], ['parent-b', 'parent-a', 'missing']);
    assert.deepEqual(found.get('parent-a'), ['current', 'reparented', 'older']);
    assert.deepEqual(found.get('parent-b'), ['other-parent']);
    assert.deepEqual(found.get('missing'), []);
    assert.ok(queries.some(query => /^SELECT handoff_id, parent, handed_at FROM agent_handoffs/.test(query)));
    assert.ok(!queries.some(query => /SELECT\s+(?:\*|(?:handoff_id,\s*)?value)\s+FROM\s+agent_handoffs/i.test(query)), 'bridge never selects old child bodies');
    records.checkpoint();
    const reopened = openRecords(sql, { transaction: host.transaction, hash: text => text });
    assert.equal(reopened.typeOf('agent-handoff:removed'), null);
    assert.equal(reopened.hasState('agent-handoff:removed'), true, 'retained removal survives checkpoint and reopen');
    const restarted = agentLegacyRows({ sql: traced, records: reopened,
      current: agentRecordStore({ records: reopened, transaction: host.transaction }),
      placeOf: table => places.get(table) ?? {} });
    assert.deepEqual(withoutBodies(reopened, () => restarted.handedOnIdsFromMany(['parent-a'])).get('parent-a'),
      ['current', 'reparented', 'older'], 'old SQL child stays hidden after the record cache is gone');
    // A copied prefix is not queried again, even if its old rows are still present while the table drains.
    places.set('agent_handoffs', { after: 1 });
    assert.deepEqual(withoutBodies(records, () => bridge.handedOnIdsFromMany(['parent-a'])).get('parent-a'), ['current', 'reparented']);
    queries.length = 0;
    assert.deepEqual([...bridge.handedOnIdsFromMany([])], []);
    assert.equal(queries.length, 0);
    places.set('agent_handoffs', { moved: true });
    sql.exec('DROP TABLE agent_handoffs');
    queries.length = 0;
    assert.deepEqual(withoutBodies(records, () => bridge.handedOnIdsFromMany(['parent-a'])).get('parent-a'), ['current', 'reparented']);
    assert.equal(queries.length, 0, 'moved table is not read or probed again');
  } finally { host.db.close(); }
});

test('all direct children contribute to exact distinct activity progress', () => {
  const { host, records, current } = opened();
  try {
    current.putHandoff(job('child-a', 'parent', 1));
    current.putHandoff(job('child-b', 'parent', 2));
    current.putHandoff(job('unrelated', 'other-parent', 3));
    const call = ids => keepActivity(host.sql, { at: at(5), app: 'Trillion', item: null, uses: [], for: ids, ok: true }, 100);
    call(['parent', 'child-a']);
    call(['child-a', 'child-b']);
    call(['child-b']);
    call(['unrelated']);
    const children = withoutBodies(records, () => current.handedOnIdsFromMany(['parent'])).get('parent');
    const related = ['parent', ...children];
    assert.equal(activityCounts(host.sql, [{ id: 'parent', related }]).get('parent'), 3);
    assert.equal(activityCount(host.sql, related), 3, 'shared calls count once and unrelated children do not contribute');
  } finally { host.db.close(); }
});
