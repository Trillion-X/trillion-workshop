import assert from 'node:assert/strict';
import test from 'node:test';
import { failureOf } from '../../shared-code/src/failure.mjs';

test('Cloudflare R2 code 10001 can be retried after waiting, without broad internal-error matching', () => {
  const known = failureOf(new Error('get: We encountered an internal error. Please try again. (10001)'));
  assert.equal(known.code, 'service-busy');
  assert.equal(known.retryable, true);
  assert.equal(known.retry_after_seconds, 5);
  assert.equal(known.fresh_handle_retry, false);

  assert.equal(failureOf(new Error('get: We encountered an internal error. Please try again.')).code, 'unexpected');
  assert.equal(failureOf(new Error('get: Access denied (10003)')).code, 'unexpected');
});

test('native current-rights fences preserve retry policy and do not soften conflicts', () => {
 for(const message of ['Account rights are changing. Retry after they settle.','Account rights are changing. Retry shortly.']){
  const result=failureOf(Object.assign(new Error(message),{status:409}));
  assert.equal(result.code,'service-busy');assert.equal(result.retryable,true);assert.equal(result.fatal,false);assert.equal(result.fresh_handle_retry,false);
 }
 const conflict=failureOf(Object.assign(new Error('This request conflicts with current state.'),{status:409}));assert.equal(conflict.code,'unexpected');assert.equal(conflict.retryable,false);
 assert.equal(failureOf(new Error('Account rights are changing. Invalid arbitrary text.')).code,'unexpected');
});
