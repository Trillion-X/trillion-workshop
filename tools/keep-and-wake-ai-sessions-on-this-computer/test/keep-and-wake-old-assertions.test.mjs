// The old hook suite's assertions, ported onto the current scripts (the old harness repository at its last commit
// before the Worker retirement, b6ae0ebf81; the old engine route's tests.rs at engine commit 5fbc2ff4b):
//   - "the prompt hook says the decisions since the session last looked" (old tests.rs 469): the notices answer's
//     words are printed under the heading, one line each, to the reader of this session.
//   - "the command prints nothing and succeeds when the account cannot be reached" (old tests.rs 592).
//   - "a session id that is not one, or a harness with no row, registers nothing" (old tests.rs 560).
// The notices answer is stubbed here; whether the live account serves its route is checked separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionsSince, settings as notices, unseenDecisions } from '../harness/decisions-since.mjs';
import { registerSession, settings as sessionRules } from '../harness/wake-sessions.mjs';

const EVENT = { session_id: 'session-0001-abcd', hook_event_name: 'UserPromptSubmit' };

test('the prompt hook says the decisions since the session last looked, under its heading', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return { ok: true, json: async () => ({ notices: [{ said: 'Use the new intake door.' }, { said: 7 }] }) };
  };
  const rules = { ...notices, origin: 'https://account.example.test' };
  const lines = await unseenDecisions(EVENT, { rules, key: () => 'key-value', fetchImpl });
  assert.equal(lines, `${notices.heading}\n- Use the new intake door.`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `https://account.example.test${notices.unseen_path}`);
  assert.equal(JSON.parse(seen[0].options.body).reader, 'session:session-0001-abcd');
});

test('the prompt hook prints nothing and succeeds when the account cannot be reached', async () => {
  const closed = { ...notices, origin: 'http://127.0.0.1:9' };
  assert.equal(await decisionsSince(EVENT, { rules: closed, key: () => 'key-value' }), '');
});

test('a session id that is not one, or a harness with no row, registers nothing', () => {
  const [harness] = Object.keys(sessionRules.harnesses);
  assert.throws(() => registerSession({ harness: 'no-such-harness', session_id: 'session-0001-abcd' }, sessionRules), /No harness/);
  assert.throws(() => registerSession({ harness, session_id: 'not a session id!' }, sessionRules), /session_id/);
});
