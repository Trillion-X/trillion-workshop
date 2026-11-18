// tools/notice-when-something-shows-up/tests/tell-the-engine.test.mjs
//
// The noticer's engine carrier: the clock waiter's ticks reach the door as wake:arrive facts of the waiter's own kind,
// each a few text fields with an event id unique per tick, and a refused fact is said on standard output.
import assert from 'node:assert/strict';
import test from 'node:test';
import { engineCarrier, factOf } from '../do-work/tell-the-engine.mjs';
import { runResidentEmitter } from '../do-work/emit-arrival-fact.mjs';

const clock = { kind: 'notice-when-something-shows-up.waiter-descriptor', id: 'waiter:elapsed-time', is_active: true,
  mechanism_capability_ref: 'package::notice-when-something-shows-up::mechanism::elapsed-time', mechanism_leaf: 'elapsed-time.mjs',
  mechanism_settings: { interval_seconds: 0.05, every: 'interval' },
  emitted_record: { change_kind: 'clock-tick', address_label: 'clock::tick', path_labels: ['current-item', 'clock-tick'],
    payload_fields: ['iso_time', 'epoch_ms', 'counter', 'every'] } };

/** A door that keeps each wake:arrive it is sent, and refuses one kind. */
function door(refuse = null) {
  const told = [];
  const fetchImpl = async (url, { body, headers }) => {
    const call = JSON.parse(body).params.arguments;
    assert.equal(headers.authorization, 'Bearer run-capability');
    assert.equal(call.method, 'wake:arrive');
    if (call.input.kind === refuse) return new Response(JSON.stringify({ result: { isError: true, structuredContent: { detail: 'not this kind' } } }), { status: 200 });
    told.push(call.input);
    return new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 });
  };
  return { told, fetchImpl };
}

test('each clock tick is told as one fact of the waiter kind, with text fields and its own event id', async () => {
  const { told, fetchImpl } = door();
  const controller = new AbortController();
  const lines = [];
  const carrier = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'run-capability' }, waiters: [clock], fetchImpl, say: line => lines.push(line) });
  const running = runResidentEmitter({ carrier, signal: controller.signal });
  await new Promise(done => setTimeout(done, 400));
  controller.abort();
  await running;
  assert.ok(told.length >= 3, `ticks told: ${told.length}`);
  assert.ok(told.every(fact => fact.kind === 'clock-tick'));
  assert.equal(new Set(told.map(fact => fact.event_id)).size, told.length, 'every tick has its own event id');
  assert.ok(told.every(fact => Object.values(fact.payload).every(value => typeof value === 'string')), 'every field is text');
  assert.ok(told.every(fact => Object.keys(fact.payload).length <= 8));
  assert.equal(lines.length, told.length);
});

test('a fact the door refuses is said, with the door words', async () => {
  const { fetchImpl } = door('clock-tick');
  const lines = [];
  const carrier = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'run-capability' }, waiters: [], fetchImpl, say: line => lines.push(line) });
  await assert.rejects(carrier.writeRecord({ addressLabel: 'clock::tick', payload: { kind: 'clock-tick', sequence: 0 } }));
  assert.match(lines[0], /not this kind/);
});

test('a record becomes a fact of at most eight text fields, nested lists left out', () => {
  const fact = factOf({ addressLabel: 'a', payload: { kind: 'k', sequence: 2, observed_at: 't', matched_source_refs: ['x'],
    observed_identity: { volume: 'Drive', a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } } }, 'a#1#2');
  assert.equal(fact.kind, 'k');
  assert.equal(fact.event_id, 'a#1#2');
  assert.equal(Object.keys(fact.payload).length, 8);
  assert.equal(fact.payload.matched_source_refs, undefined);
});
