// An http invoke names its connection in one of two ways: a fixed `connection_id` (every row before this change, unchanged)
// or `connection: { vendor, from_input }`, which takes the handle the caller passes in input. Both name the same held key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvocation, connectionFieldName } from '../do-work/http-invocation.mjs';

const stripe = { vendor: 'stripe', from_input: 'connection' };
const read = { url: 'https://api.stripe.com/v1/balance_transactions?limit=100', method: 'GET', connection: stripe,
  credential_injections: [{ field_id: 'secret_key', placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' }, hosts: ['api.stripe.com'] }] };
const account = 'service_connection:stripe:main-account';

test('a fixed connection_id names the same held key it always did', async () => {
  const fixed = { ...read, connection: undefined, connection_id: 'service_connection:stripe' };
  const built = await buildInvocation(fixed, { request: true, input: {} });
  assert.equal(built.connection_id, 'service_connection:stripe');
  assert.deepEqual(built.credential_injections.map(item => item.secret_name), [connectionFieldName('service_connection:stripe', 'secret_key')]);
  assert.equal('connection' in built, false, 'the connection object is not carried into the request');
});

test('connection { vendor, from_input } takes the account the caller names, and the held key is that account\'s', async () => {
  const built = await buildInvocation(read, { request: true, input: { connection: { connection_id: account } } });
  assert.equal(built.connection_id, account);
  assert.deepEqual(built.credential_injections.map(item => item.secret_name), [connectionFieldName(account, 'secret_key')]);
  assert.equal('connection' in built, false);
});

test('the bare vendor handle is accepted too', async () => {
  const built = await buildInvocation(read, { request: true, input: { connection: { connection_id: 'service_connection:stripe' } } });
  assert.equal(built.connection_id, 'service_connection:stripe');
});

test('a handle of another vendor, or none, is refused before any key is named', async () => {
  for (const handed of ['service_connection:paypal:main', 'service_connection:stripex', '', undefined]) {
    await assert.rejects(buildInvocation(read, { request: true, input: { connection: { connection_id: handed } } }), error => {
      assert.match(error.message, /needs a stripe connection/);
      return true;
    });
  }
  await assert.rejects(buildInvocation(read, { request: true, input: {} }), /needs a stripe connection/);
});

test('two accounts of one vendor never share a held key', async () => {
  const other = 'service_connection:stripe:second-account';
  const first = await buildInvocation(read, { request: true, input: { connection: { connection_id: account } } });
  const second = await buildInvocation(read, { request: true, input: { connection: { connection_id: other } } });
  assert.notEqual(first.credential_injections[0].secret_name, second.credential_injections[0].secret_name);
});
