// What the computer's programs write to their log is decided by one DATA table, and secrets never reach it (computer/log-policy.mjs, used by computer/mac-tools.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { callerOf, macTools } from '../mac-tools.mjs';
import { eventOf, policedLog, redact } from '../log-policy.mjs';

const policy = {
  default_mode: 'always',
  modes: { always: { drop: false, compare: null }, never: { drop: true, compare: null }, on_change: { drop: false, compare: 'last' }, first_only: { drop: false, compare: 'seen' } },
  events: { loud: 'never', failing: 'on_change', hello: 'first_only', every: 'always' },
  ignore_when_comparing: ['again_in_ms'],
  most_remembered_events: 3,
  unlisted_event_words: 'log_policy_unlisted',
  redact: { replacement: '[redacted]', key_patterns: ['(^|_)(key|token)s?($|_)'], key_flags: 'i', text_patterns: ['bearer\\s+[A-Za-z0-9._~+/=-]{12,}'], text_flags: 'gi' },
};

test('each event is logged as its row says: always, never, only on change, only the first time', () => {
  const written = [];
  const log = policedLog(line => written.push(line), { policy });
  for (const entry of [{ loud: 1 }, { every: 1 }, { every: 1 }, { failing: 'a', again_in_ms: 10 }, { failing: 'a', again_in_ms: 20 }, { failing: 'b' }, { failing: 'a' }, { hello: 1 }, { hello: 2 }]) log(entry);
  assert.deepEqual(written, [{ every: 1 }, { every: 1 }, { failing: 'a', again_in_ms: 10 }, { failing: 'b' }, { failing: 'a' }, { hello: 1 }]);
  assert.equal(eventOf({ event: 'x', y: 1 }), 'x');
  assert.equal(eventOf({ y: 1 }), 'y');
});

test('an event with no row is logged under the default and reported once by name; what is remembered stays bounded', () => {
  const written = [];
  const log = policedLog(line => written.push(line), { policy });
  log({ mystery: 1 });
  log({ mystery: 2 });
  assert.deepEqual(written, [{ log_policy_unlisted: 'mystery' }, { mystery: 1 }, { mystery: 2 }]);
  for (const name of ['f1', 'f2', 'f3', 'f4']) log({ failing: name });
  assert.ok(log.remembered() <= 3);
});

test('keys that name a secret and text shaped like a bearer header are replaced at any depth, in every mode', () => {
  const written = [];
  const log = policedLog(line => written.push(line), { policy });
  log({ every: 1, token: 'abc', deep: { api_key: 'k', note: 'sent Authorization: Bearer abcdefghijklmnop123 ok' }, list: ['Bearer zzzzzzzzzzzzzzzzzz'] });
  assert.deepEqual(written, [{ every: 1, token: '[redacted]', deep: { api_key: '[redacted]', note: 'sent Authorization: [redacted] ok' }, list: ['[redacted]'] }]);
  const input = { token: 't' };
  redact(input, policy.redact);
  assert.equal(input.token, 't', 'the line given is not changed');
});

test('the Mac tool host logs a repeated identical failure once and never writes the secret in it', async () => {
  const logs = [];
  let offered = 0;
  const call = callerOf('https://native-fixture.test', 'fixture-key', async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/handoffs/take')) { offered += 1; return Response.json({ handoff: offered <= 3 ? { handoff_id: `h_${offered}`, input: { tool_id: 'tool:fixture' } } : null, generation: 1 }); }
    if (path.endsWith('/handoffs/finish')) return Response.json({ error: 'Refused for Bearer abcdefghijklmnop123' }, { status: 403 });
    return Response.json({});
  });
  const host = macTools({
    settings: { agent: { agent_id: 'computer-tools' }, tools: {}, capacity: { max_concurrent: 4 }, take_gap_ms: 0, renew_minutes: 30, live_retry_ms: [1] },
    call, log: row => logs.push(row), connect: () => ({ addEventListener() {} }), execute: async () => ({ ok: true }),
    timers: { setTimeout: (run) => queueMicrotask(run), setInterval: () => {} },
  });
  try {
    await host.takeAll();
    await host.takeAll();
  } finally { await host.stop(); }
  const failures = logs.filter(row => row.mac_tools_take_failed);
  assert.equal(failures.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /abcdefghijklmnop123/);
});
