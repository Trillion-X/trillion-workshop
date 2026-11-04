// The store's event reads (src/events.mjs pollDue) cost what one read costs, not what the account listens to, and a read
// stops at its scheduler stage budget with the rest of its page kept pending in the poll row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventRules } from '../src/events.mjs';

const T0 = Date.parse('2026-10-08T10:00:00.000Z');

// An account listening to `count` sources, the first of which is due with an unread page waiting; counts what is read.
function account(count, { pending = [] } = {}) {
  const rows = new Map();
  const sources = Array.from({ length: count }, (_, index) => ({ id: `events:s${index}`, label: `S${index}`, poll: { every_minutes: 5 }, events: [] }));
  sources.forEach((source, index) => {
    rows.set(`event-listen:${source.id}`, { source_id: source.id, stopped: false });
    rows.set(`event-poll:${source.id}`, { source_id: source.id, cursor: 'c', next_at: index === 0 ? T0 : T0 + 3_600_000, ...(index === 0 ? { pending: { events: pending, cursor: 'c2' } } : {}) });
  });
  const cost = { statements: 0, rows: 0 };
  const facts = {
    read: async entity => { cost.statements += 1; cost.rows += rows.has(entity) ? 1 : 0; return structuredClone(rows.get(entity) ?? null); },
    list: async prefix => { cost.statements += 1; const found = [...rows].filter(([name]) => name.startsWith(prefix)).map(([, value]) => structuredClone(value)); cost.rows += found.length; return found; },
    write: async (entity, value) => { rows.set(entity, structuredClone(value)); },
  };
  const received = [];
  const events = makeEventRules({
    workshop: { run: async () => ({}) }, facts, routes: { add: async () => {}, remove: async () => {} }, now: () => new Date(T0 + 1000),
    sources: async () => sources, rearm: async () => {},
  });
  return { events, rows, cost, received };
}

test('an event read costs the same facts however many sources the account listens to (N vs 4N)', async () => {
  const measure = async count => {
    const a = account(count);
    await a.events.nextPoll();
    a.cost.statements = 0; a.cost.rows = 0;
    const done = await a.events.pollDue({ left: () => 2000 });
    assert.equal(done.length, 1);
    return { ...a.cost };
  };
  const small = await measure(10);
  const large = await measure(40);
  assert.ok(large.statements <= small.statements * 1.5, `${large.statements} statements against ${small.statements}`);
  assert.ok(large.rows <= small.rows * 1.5, `${large.rows} rows against ${small.rows}`);
});

test('a source that is not due is not read, and nothing due costs no read of any listener', async () => {
  const a = account(5);
  a.rows.set('event-poll:events:s0', { ...a.rows.get('event-poll:events:s0'), next_at: T0 + 3_600_000 });
  await a.events.nextPoll();
  a.cost.statements = 0;
  assert.deepEqual(await a.events.pollDue({ left: () => 2000 }), []);
  assert.equal(a.cost.statements, 0, 'the kept order says nothing is due');
});
