// tools/notice-when-something-shows-up/tests/tell-the-engine.test.mjs
//
// The noticer's engine carrier: the clock waiter's ticks reach the door as wake:arrive facts of the waiter's own kind,
// each a few text fields with an event id unique per tick, and a refused fact is said on standard output.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { engineCarrier, factOf, operateOverDoor, refusedFact, waitersWithTheirCredentials, EACH_WAITER_FD } from '../do-work/tell-the-engine.mjs';
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

test('a fact whose own key is longer than the door takes is told under a fixed-length name of that key, the same each time', async () => {
  const keys = [];
  const fetchImpl = async (url, { body }) => {
    keys.push(JSON.parse(body).params.arguments.request_key);
    return new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 });
  };
  const carrier = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'run-capability' }, waiters: [], fetchImpl, say: () => {} });
  // A due time's occurrence key names its schedule, zone and four times: 283 bytes for a daily schedule of one workflow.
  const long = `timed-action.recurring-window::${encodeURIComponent(JSON.stringify(['schedule:workflow:grow-the-one-tree:daily', '1', '1', 'UTC',
    '2026-11-19', '14:00', '2026-11-19', '14:01', '2026-11-19', '14:00', '2026-11-19', '14:01', 'earlier']))}`;
  await carrier.writeRecord({ addressLabel: 'due', payload: { kind: 'due-time' }, eventKey: long });
  await carrier.writeRecord({ addressLabel: 'due', payload: { kind: 'due-time' }, eventKey: long });
  await carrier.writeRecord({ addressLabel: 'tick', payload: { kind: 'clock-tick' }, eventKey: '1' });
  assert.ok(Buffer.byteLength(`fact:${long}`) > 255);
  assert.ok(keys.every(key => Buffer.byteLength(key) <= 255), keys.join('\n'));
  assert.equal(keys[0], keys[1], 'the same fact keeps one key, so a retry is answered as the first call was');
  assert.equal(keys[2], 'fact:tick@1', 'a key within the bound is sent as it is');
});

test('a JSON-RPC error from the door is a refusal, so the fact stays untold', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Addressed resource arguments are incomplete: request_key is 283 bytes.' } }), { status: 200 });
  const lines = [];
  const carrier = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'run-capability' }, waiters: [], fetchImpl, say: line => lines.push(line) });
  await assert.rejects(carrier.writeRecord({ addressLabel: 'due', payload: { kind: 'due-time' }, eventKey: 'x' }), /request_key is 283 bytes/);
  assert.equal(carrier.answer.told.length, 0);
  assert.match(lines[0], /"refused":"due-time"/);
});

test('one run watches many places, each waiter reading with its own credential on the descriptor the engine mounts it on', async () => {
  // The engine's rule for the row's `waiters[].credential_name` mount: the first descriptor plus the waiter's place.
  const mount = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload.invoke.credential_mounts
    .find(item => item.secret_name_from_input === 'waiters[].credential_name');
  assert.equal(mount.fd, EACH_WAITER_FD);
  const place = (id, credential_name) => ({ ...clock, id, ...(credential_name ? { credential_name } : {}),
    mechanism_leaf: 'reads-its-credential.mjs', emitted_record: { ...clock.emitted_record, change_kind: 'something-changed', address_label: 'where::something-changed', payload_fields: ['where', 'read'] } });
  const waiters = waitersWithTheirCredentials([place('waiter:my-database', 'my-database'), place('waiter:a-clock'), place('waiter:my-bookings', 'my-booking-service')]);
  assert.deepEqual(waiters.map(waiter => waiter.credential_fd ?? null), [5, null, 7]);
  const { told, fetchImpl } = door();
  const controller = new AbortController();
  const carrier = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'run-capability' }, waiters, fetchImpl, say: () => {} });
  // Each waiter's mechanism reads the descriptor it is handed, as row-changes, service-lists and signed-service-calls do.
  const loadModule = async () => ({ describeMechanism: () => ({ mechanism_ref: clock.mechanism_capability_ref }), async watchForTransitions(settings, handlers) {
    await handlers.onTransition({ condition: 'became-reachable', observed_identity: {}, detail: { read: String(handlers.credentialFd) } });
  } });
  await runResidentEmitter({ carrier, signal: controller.signal, loadModule, connection: 'the-runs-one-credential' });
  assert.deepEqual(told.map(fact => [fact.payload.where, fact.payload.read]).sort(),
    [['my-booking-service', '7'], ['my-database', '5'], ['the-runs-one-credential', 'null']]);
});

test('a door that never answers is given up after its time limit and refused door_timeout, so the fact is told again', { timeout: 10_000 }, async () => {
  // wake-engine, Nov 22 2026, 3:2x AM CST: fetch with no signal held a waiter's pass for ever when the door did not answer.
  let calls = 0;
  const fetchImpl = (url, { signal }) => {
    calls += 1;
    if (calls === 1) {
      // The first call hangs until its signal ends it, as a door that never answers does.
      return new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return Promise.resolve(new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 }));
  };
  const door = { url: 'http://door.test/mcp', capability: 'run-capability' };
  const started = Date.now();
  const gaveUp = await operateOverDoor(door, 'wake:arrive', { kind: 'due-time' }, 'fact:x', { fetchImpl, timeoutMs: 50 });
  assert.ok(Date.now() - started < 5000, 'given up near its limit, not held');
  assert.equal(gaveUp.response.ok, false);
  assert.equal(gaveUp.result.isError, true);
  assert.equal(gaveUp.result.structuredContent.code, 'door_timeout');
  const lines = [];
  const carrier = engineCarrier({ door, waiters: [], fetchImpl, say: line => lines.push(line), doorTimeoutMs: 50 });
  calls = 0;
  const refused = await carrier.writeRecord({ addressLabel: 'due', payload: { kind: 'due-time' }, eventKey: 'x' }).catch(error => error);
  assert.equal(refused.tellAgain, true, 'a door that did not answer is told again, never counted as a broken fact');
  assert.equal(refused.roomFull, false);
  assert.equal(carrier.answer.told.length, 0, 'nothing is kept as told');
  await carrier.writeRecord({ addressLabel: 'due', payload: { kind: 'due-time' }, eventKey: 'x' });
  assert.equal(carrier.answer.told.length, 1, 'told again, it is taken');
  assert.equal(refusedFact('no room', 'owed_full').tellAgain, true);
  assert.equal(refusedFact('bad', 'not_this_kind').tellAgain, false);
});
