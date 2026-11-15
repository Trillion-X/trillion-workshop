import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { keepActivity, traceActivity } from 'trillion-workshop/tools/see-what-my-ais-did/activity.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const sql = { exec(query, ...binds) {
    const statement = db.prepare(query);
    const rows = /^\s*(select|explain)/i.test(query) ? statement.all(...binds) : (statement.run(...binds), []);
    calls.push({ query, binds, returned: rows.length });
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  return { sql, calls, close: () => db.close() };
}
const row = (item, uses = [], goals = []) => ({ at: '2026-10-11T00:00:00Z', app: 'Fixture', item, uses, for: goals, ok: true, label: 'Fixture operation' });

test('a hot target reads a bounded indexed candidate page at N and 4N history, then only those exact rows', () => {
  const measure = n => {
    const f = fixture();
    for (let i = 0; i < n; i += 1) keepActivity(f.sql, row('record:hot', [], [`goal:${i}`]));
    f.calls.length = 0;
    const answer = traceActivity(f.sql, { item: 'record:hot' });
    const calls = [...f.calls];
    assert.equal(answer.steps.length, 200);
    assert.equal(answer.coverage.limit_reached, true);
    assert.ok(answer.coverage.candidates_examined <= 201);
    assert.ok(calls.reduce((sum, call) => sum + call.returned, 0) <= 401);
    for (const call of calls.filter(call => call.query.includes('activity_links_g'))) {
      const plan = f.sql.exec(`EXPLAIN QUERY PLAN ${call.query}`, ...call.binds).toArray();
      assert.ok(plan.some(part => part.detail.includes('USING INDEX activity_links_g')));
      assert.ok(plan.every(part => !part.detail.includes('TEMP B-TREE')), 'raw link limits must use the key range, not sort all history');
    }
    f.close();
    return calls.reduce((sum, call) => sum + call.returned, 0);
  };
  assert.equal(measure(1000), measure(4000));
});

test('a wide source wave has a query budget even when none of the sources has a recorded maker', () => {
  const f = fixture();
  for (let i = 0; i < 30; i += 1) keepActivity(f.sql, row('record:wide', Array.from({ length: 20 }, (_, j) => `source:${i}:${j}`)));
  const answer = traceActivity(f.sql, { item: 'record:wide', depth: 8 });
  assert.equal(answer.steps.length, 30);
  assert.equal(answer.coverage.limit_reached, true);
  assert.ok(answer.coverage.reference_queries <= 200);
  assert.ok(answer.coverage.candidates_examined <= 201);
  f.close();
});

test('bounded traversal preserves small-chain roles, order, depth, successors, cycles and generation retention', () => {
  const f = fixture();
  keepActivity(f.sql, row('output', ['source']));
  keepActivity(f.sql, row('source', ['output']));
  keepActivity(f.sql, row('later', ['output']));
  const answer = traceActivity(f.sql, { item: 'output' });
  assert.deepEqual(answer.steps.map(step => [step.item, step.link, step.depth]), [['output', 'made', 0], ['source', 'made', 1], ['later', 'used', 1]]);
  assert.equal(answer.coverage.limit_reached, false);
  assert.equal(traceActivity(f.sql, { item: 'output', depth: 0 }).coverage.limit_reached, true);
  f.close();
  const rollover = fixture();
  for (let i = 0; i < 5; i += 1) keepActivity(rollover.sql, row(`output:${i}`), 1);
  assert.deepEqual(traceActivity(rollover.sql, { item: 'output:0' }).steps, []);
  assert.equal(traceActivity(rollover.sql, { item: 'output:4' }).steps.length, 1);
  rollover.close();
});
