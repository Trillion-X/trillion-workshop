import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkFailure, failureOf } from '../../shared-code/src/failure.mjs';
import { onceMore, passing } from '../src/cut-off.mjs';

test('a typed failure keeps its stable policy even when its words resemble a platform reset', () => {
  const failure = new WorkFailure('unexpected', 'Durable Object reset is the text in a person record');
  assert.equal(failure.code, 'unexpected');
  assert.equal(failure.retryable, false);
  assert.equal(failure.fatal, true);
  assert.deepEqual(failureOf(failure), {
    code: 'unexpected', retryable: false, fatal: true, retry_after_seconds: null,
    fresh_handle_retry: false, remediation: 'Use the error reference to investigate the failure.', tries_again_later: false, domain: 'unknown',
  });
  assert.equal(passing(failure), false);
});

test('a platform memory limit never triggers an immediate retry even if Cloudflare marks it retryable', async () => {
  const exhausted = Object.assign(new Error('Worker exceeded its memory limit'), { retryable: true });
  assert.equal(failureOf(exhausted).code, 'resource-exhausted');
  assert.equal(passing(exhausted), false);
  let calls = 0;
  await assert.rejects(onceMore(() => { calls += 1; throw exhausted; }, {}, () => ({})), error => error === exhausted);
  assert.equal(calls, 1);
});

test('an overloaded store asks the sender to wait, while an interrupted call tries one fresh handle', async () => {
  const busy = Object.assign(new Error('Durable Object is overloaded'), { retryable: true, overloaded: true });
  assert.equal(failureOf(busy).code, 'service-busy');
  assert.equal(failureOf(busy).fresh_handle_retry, false);
  let calls = 0;
  await assert.rejects(onceMore(() => { calls += 1; throw busy; }, {}, () => ({})), error => error === busy);
  assert.equal(calls, 1);

  const first = {};
  const second = {};
  const interrupted = Object.assign(new Error('Network connection lost'), { retryable: true });
  const seen = [];
  const result = await onceMore(handle => {
    seen.push(handle);
    if (handle === first) throw interrupted;
    return 'answered';
  }, first, () => second);
  assert.equal(result, 'answered');
  assert.deepEqual(seen, [first, second]);
});

test('a call through a handle from before an update is an interruption a later try gets past', () => {
  const failure = failureOf(new Error('TypeError: The RPC receiver does not implement the method "call".'));
  assert.equal(failure.code, 'service-interrupted');
  assert.equal(failure.tries_again_later, true);
  assert.equal(failureOf(new Error('Worker exceeded its memory limit')).tries_again_later, true, 'a memory reset is not retried at once, but a later try may pass');
  assert.equal(failureOf(new Error('Nobody here answers "x"')).tries_again_later, false);
});

test('a storage timeout asks for a later retry before the platform retryable flag is considered', () => {
  for (const retryable of [false, true]) {
    const failure = failureOf(Object.assign(new Error('Durable Object storage operation exceeded timeout which caused object to be reset.'), { retryable }));
    assert.equal(failure.code, 'service-busy');
    assert.equal(failure.retryable, true);
    assert.equal(failure.fresh_handle_retry, false);
    assert.equal(failure.retry_after_seconds, 5);
    assert.equal(failure.tries_again_later, true);
  }
});

test('serialized account policy races ask for a later retry without weakening other admission refusals', () => {
  for (const message of [
    'Account rights are changing. Retry after they settle.',
    'Account rights are changing. Retry shortly.',
    'Account rights changed during admission. Retry.',
    'Account rights changed during meter carry. Retry.',
    'Account rights changed during quota initialization. Retry.',
  ]) {
    const held = failureOf(new Error(message));
    assert.equal(held.code, 'service-busy');
    assert.equal(held.retryable, true);
    assert.equal(held.fatal, false);
    assert.equal(held.tries_again_later, true);
    assert.equal(held.fresh_handle_retry, false);
    assert.equal(held.retry_after_seconds, 5);
    assert.equal(failureOf(new WorkFailure('unexpected', message)).code, 'unexpected');
  }
  for (const message of ['Wrong resource admission gate.', 'Resource gate identity changed.', 'Account rights changed during admission.']) {
    assert.equal(failureOf(new Error(message)).code, 'unexpected');
  }
});

test('an owner refusing the request with its own words is the caller to correct, not an unexpected failure', () => {
  for (const reply_status of [400, 404, 413, 422]) {
    const refused = Object.assign(new Error('A list needs a label: the name people see, like "Trillion CRM".'), { reply_status });
    const failure = failureOf(refused);
    assert.equal(failure.code, 'request-refused', `reply ${reply_status}`);
    assert.equal(failure.fatal, false);
    assert.match(failure.remediation, /correct the request/);
  }
  for (const reply_status of [401, 402, 403, 409, 500, 503]) {
    assert.notEqual(failureOf(Object.assign(new Error('An answer with its own meaning'), { reply_status })).code, 'request-refused', `reply ${reply_status}`);
  }
  assert.equal(failureOf(new Error('No status at all')).code, 'unexpected');
  assert.equal(failureOf(Object.assign(new Error('Durable Object is overloaded'), { retryable: true, overloaded: true, reply_status: 400 })).code, 'service-busy', 'a platform row listed before keeps its code');
});
