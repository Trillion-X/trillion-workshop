// tools/connections/test/find-the-account-of-a-service.test.mjs
// The service-with-no-account policy, moved from the engine (trillion-rust tools.rs connection_found, its tests
// a_service_named_with_no_account_is_the_one_account_the_vault_holds and its two siblings), over made-up held names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findTheAccountOfAService } from '../do-work/find-the-account-of-a-service.mjs';

const held = (...ids) => ids.map(connection_id => ({ connection_id, fields: ['secret_key'] }));

test('a service named with no account is the one account the vault holds', async () => {
  assert.deepEqual(await findTheAccountOfAService({ service: 'service_connection:stripe', held_connections: held('service_connection:stripe:sample', 'service_connection:resend:other') }),
    { connection_id: 'service_connection:stripe:sample', accounts: ['service_connection:stripe:sample'] });
});

test('several accounts held: each is named and none is chosen', async () => {
  const answer = await findTheAccountOfAService({ service: 'service_connection:stripe', held_connections: held('service_connection:stripe:b', 'service_connection:stripe:a', 'service_connection:stripe:a') });
  assert.equal(answer.connection_id, null);
  assert.deepEqual(answer.accounts, ['service_connection:stripe:a', 'service_connection:stripe:b']);
  assert.match(answer.which, /service_connection:stripe:a, service_connection:stripe:b/);
});

test('an id the caller gave is its word, and nothing held answers nothing', async () => {
  assert.equal((await findTheAccountOfAService({ service: 'service_connection:stripe:named', held_connections: held('service_connection:stripe:other') })).connection_id, 'service_connection:stripe:named');
  assert.equal((await findTheAccountOfAService({ service: 'service_connection:stripe', held_connections: held('service_connection:stripe', 'service_connection:stripe:a') })).connection_id, 'service_connection:stripe', 'a bare id the vault holds');
  assert.deepEqual(await findTheAccountOfAService({ service: 'service_connection:stripe', held_connections: held('service_connection:resend:a') }), { connection_id: null, accounts: [] });
});

test('a request of another shape is refused in words', async () => {
  for (const input of [null, [], {}, { service: 'service_connection:stripe' }, { service: 'stripe', held_connections: [] }, { service: 'service_connection:', held_connections: [] },
    { service: 'service_connection:stripe:', held_connections: [] }, { service: 'service_connection:stripe:a:b', held_connections: [] }]) {
    await assert.rejects(findTheAccountOfAService(input), Error, JSON.stringify(input));
  }
});

test('the row runs this function, reads only, and packs what it reads', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const row = rows.find(payload => payload.id === 'tool:find-the-account-of-a-service');
  assert.deepEqual(row.invoke.argv.slice(2), ['/opt/connections/do-work/find-the-account-of-a-service.mjs', 'findTheAccountOfAService']);
  assert.equal(row.read_only, true);
  assert.equal(row.invoke.internet, false);
  const packed = JSON.parse(readFileSync(new URL('../../../package-files.json', import.meta.url), 'utf8'))['tool:find-the-account-of-a-service'];
  assert.deepEqual(packed, row.invoke.files.package_files);
});
