// Ported from old trillion test/events-read-by-trillion.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The event owner is tools/keep-and-wake-ai-sessions-on-this-computer
// src/events.mjs makeEventRules, run here as test/events-continuity.test.mjs runs it: in-memory facts and a stand-in
// Workshop over a made-up source that is read by polling (the old test read GitHub's row from the shared Workshop rows;
// those rows, scripts/workshop-rows.mjs and its tool-event-source records, are gone). Its second test is the old one,
// its assertions unchanged. Left out: the six tests over the shipped Gmail, GitHub, Calendar, Notion, Resend, Stripe and
// X source rows, the service-connection descriptor and the shipped event rules (src/starting-rules.mjs,
// src/shipped-defaults.mjs, src/service-values.mjs): no running code ships those sources (searched the three repos for
// "tool-event-source", "events:github", "events:gmail" and starting-rules.mjs: the names appear only in this owner's
// code, its instruction words and tests; no source row of kind tool-event-source is shipped anywhere).
//
// Events from services that keep no address to send to (src/events.mjs `poll`): the account's own connection reads
// what is new since a cursor, on the store's alarm, and each new item is an event exactly as a delivery's would be.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventRules } from '../../keep-and-wake-ai-sessions-on-this-computer/src/events.mjs';

// A made-up service read by polling, standing where the old test read GitHub's row: who the account is, then what is new.
const source = {
  id: 'events:github', label: 'A polled inbox',
  events: [{ name: 'message', each: [{ field: 'messages', as: 'm' }], fields: { message_id: ['m', 'id'], text: ['m', 'body'] }, required: ['message_id'] }],
  route_key: 'account', event_id: 'message_id',
  route_key_proof: { tool_id: 'tool:identify', output_selector: '$.account' },
  poll: { tool_id: 'tool:read', every_minutes: 1, cursor: { input_field: 'after', start: { tool_id: 'tool:identify', output_selector: '$.cursor' }, next: { output_selector: '$.cursor' } } },
};

// One account over in-memory facts; the clock is ours to move, and every list of a fact prefix is counted.
function account() {
  const kept = new Map();
  const lists = new Map();
  let clock = Date.parse('2026-09-29T10:00:00.000Z');
  const facts = {
    read: async key => structuredClone(kept.get(key) ?? null),
    list: async (prefix, options) => {
      lists.set(prefix, (lists.get(prefix) ?? 0) + 1);
      const values = [...kept].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value));
      if (!options?.next) return values;
      const { scopes, routes, pending, from_due } = options.next;
      const open = values.filter(value => prefix === 'event-attempt:' ? !value.done : value.pending)
        .filter(value => !scopes || scopes.includes(value.source_id)).filter(value => !routes || routes.includes(value.event_payload?.route_key));
      const times = open.map(value => prefix === 'event-attempt:' ? Date.parse(value.due_at) + 60_000 : value.retry_at)
        .filter(at => Number.isFinite(at) && (from_due === undefined || at >= from_due));
      return [{ at: pending || !times.length ? null : Math.min(...times), pending: Boolean(pending && open.length) }];
    },
    write: async (key, value) => { kept.set(key, structuredClone(value)); },
  };
  const workshop = {
    data: async () => ({ tools: [] }),
    run: async ({ tool_id }) => {
      if (tool_id === 'tool:identify') return { state: 'completed', output: { account: 'someone', cursor: 'start' } };
      if (tool_id === 'tool:read') return { state: 'completed', output: { cursor: 'next', messages: [] } };
      throw new Error(`unexpected tool ${tool_id}`);
    },
  };
  const workflows = { recipeOf: async () => ({}), start: async () => ({ run_id: 'run_1', state: 'running' }) };
  const rules = makeEventRules({ workshop, workflows, facts, sources: async () => [source], now: () => new Date(clock),
    routes: { add: async () => {}, remove: async () => {} }, rearm: async () => {} });
  return { rules, listCount: prefix => lists.get(prefix) ?? 0, advance: minutes => { clock += minutes * 60000; } };
}

test('unrelated scheduler wakes reuse the event poll cursor until listening or a poll changes it', async () => {
  const a = account();
  await a.rules.listen({ source_id: 'events:github' });
  const first = await a.rules.nextPoll();
  const read = [a.listCount('event-listen:'), a.listCount('event-poll:')];
  for (let i = 0; i < 100; i += 1) assert.equal(await a.rules.nextPoll(), first);
  assert.deepEqual([a.listCount('event-listen:'), a.listCount('event-poll:')], read);

  a.advance(999);
  await a.rules.pollDue();
  assert.ok(await a.rules.nextPoll() > first, 'the completed poll changes its next time');
  assert.deepEqual([a.listCount('event-listen:'), a.listCount('event-poll:')], [read[0] + 1, read[1] + 1], 'a poll reads the kept order, then lists once more only for the next time it changed');
  await a.rules.listen({ source_id: 'events:github', stop: true });
  assert.equal(await a.rules.nextPoll(), null, 'stopping the source invalidates the cached time');
});
