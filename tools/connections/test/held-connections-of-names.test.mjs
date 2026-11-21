// tools/connections/test/held-connections-of-names.test.mjs
// The connections a vault holds, read from its held names alone, as connect-service.ts writes them, over made-up names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heldConnectionsOfNames } from '../read-data/held-connections-of-names.mjs';
import { findTheAccountOfAService } from '../do-work/find-the-account-of-a-service.mjs';

const hex = text => Buffer.from(text, 'utf8').toString('hex');
const named = (connection, field) => `service-connection-${hex(connection)}${field ? `-field-${hex(field)}` : ''}`;

test('each connection the names write, with its fields, in connection id order', () => {
  const names = [
    named('service_connection:stripe:shop', 'secret_key'),
    named('service_connection:stripe:shop', 'test_secret_key'),
    named('service_connection:resend'),
    'pursuit_for_who_runs_it-connection',
    'service-connection-zz',
    `${named('service_connection:stripe:a', 'x')}-field-00`,
  ];
  assert.deepEqual(heldConnectionsOfNames(names), [
    { connection_id: 'service_connection:resend', fields: [] },
    { connection_id: 'service_connection:stripe:shop', fields: ['secret_key', 'test_secret_key'] },
  ]);
  assert.deepEqual(heldConnectionsOfNames(undefined), []);
});

test('what the names write is what tool:find-the-account-of-a-service takes', async () => {
  const held_connections = heldConnectionsOfNames([named('service_connection:stripe:shop', 'secret_key')]);
  assert.deepEqual(await findTheAccountOfAService({ service: 'service_connection:stripe', held_connections }),
    { connection_id: 'service_connection:stripe:shop', accounts: ['service_connection:stripe:shop'] });
});
