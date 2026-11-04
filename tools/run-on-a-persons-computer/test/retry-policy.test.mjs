// test/retry-policy.test.mjs
//
// Which failures are asked again, as DATA (src/retry-policy.json), and the one switch that turns every retry off while
// still telling a passing failure from a final one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mayRetry, retriable, retriesOn } from '../retry-policy.mjs';

const status = (code, message = 'x') => Object.assign(new Error(message), { status: code });

test('a busy or broken account is asked again; an explicit client refusal is final even when its words say busy', () => {
  for (const code of [408, 429, 500, 503, 599]) assert.equal(retriable(status(code)), true, String(code));
  for (const code of [400, 401, 403, 404, 409, 422]) assert.equal(retriable(status(code, 'busy')), false, String(code));
  assert.equal(retriable(new Error('fetch failed')), true);
  assert.equal(retriable(new Error('Network connection lost.')), true);
  assert.equal(retriable(new Error('nothing to do with it')), false);
  assert.equal(retriable(Object.assign(status(503), { native_output_refusal: true })), false);
});

test('rows may also name a code and a method, so a new class is a row and not code', () => {
  const rules = { enabled: true, retriable: [{ code: 'E_AGAIN', method: 'StreamChat' }] };
  assert.equal(retriable(Object.assign(new Error('x'), { code: 'E_AGAIN' }), { method: 'StreamChat' }, rules), true);
  assert.equal(retriable(Object.assign(new Error('x'), { code: 'E_AGAIN' }), { method: 'Other' }, rules), false);
  assert.equal(retriable(new Error('x'), {}, { enabled: true, retriable: 'not rows' }), false);
});

test('the switch turns every retry off at once, by the file or the environment, and changes no classification', () => {
  const policy = JSON.parse(readFileSync(new URL('../retry-policy.json', import.meta.url), 'utf8'));
  const error = status(503);
  assert.equal(retriesOn(policy, {}), true);
  assert.equal(mayRetry(error, {}, policy, {}), true);
  assert.equal(mayRetry(error, {}, policy, { [policy.off_by_environment]: '1' }), false);
  assert.equal(mayRetry(error, {}, { ...policy, enabled: false }, {}), false);
  assert.equal(retriable(error, {}, { ...policy, enabled: false }), true, 'still classified as passing');
  console.log('readback switch:', JSON.stringify({ env: policy.off_by_environment, on: mayRetry(error, {}, policy, {}), off: mayRetry(error, {}, policy, { [policy.off_by_environment]: '1' }) }));
});
