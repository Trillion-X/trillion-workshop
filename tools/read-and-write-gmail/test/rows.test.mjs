// Every Gmail row runs as the Google account its input's connection names, by handle only: the row declares the
// google-account kind and takes the account from input.connection, its token goes only in the Authorization header,
// and every request goes to Gmail over https.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);

test('each row takes its account from input.connection and no other way', () => {
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.deepEqual(row.invoke.connection, { vendor: 'google-account', from_input: 'connection' }, row.id);
    assert.equal(row.invoke.connection_id, undefined, `${row.id} fixes no account`);
    assert.ok(row.input_schema.required.includes('connection'), `${row.id} requires a connection`);
    assert.deepEqual(row.input_schema.properties.connection.required, ['connection_id'], row.id);
  }
});

test('the token goes only in the Authorization header, and only to Gmail over https', () => {
  for (const row of rows) {
    assert.deepEqual(row.invoke.credential_injections, [{ field_id: 'access_token', placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' } }], row.id);
    assert.match(row.invoke.url, /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\//, row.id);
    assert.equal(row.invoke.kind, 'http', row.id);
  }
});

test('a row reads only when it asks with GET, and each id is the mail screen\'s own', () => {
  for (const row of rows) {
    assert.equal(row.read_only, row.invoke.method === 'GET', row.id);
    assert.match(row.id, /^tool:google-account-[a-z_]+$/, row.id);
  }
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
});
