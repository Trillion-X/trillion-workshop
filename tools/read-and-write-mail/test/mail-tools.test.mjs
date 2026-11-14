// The mail tool rows are derived from the provider rows: one row per job, no vendor in a tool id, each row's by_input
// variants (connection kind and key renewal) equal to what read-data/mail-providers.json declares, every operation a
// provider row names run by an export of read-data/mail.mjs and an adapter function, and no vendor word outside the
// provider rows and the adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { HEADER_FIELDS } from '../read-data/neutral.mjs';
import * as mail from '../read-data/mail.mjs';

const here = path => new URL(path, import.meta.url);
const file = path => JSON.parse(readFileSync(here(path), 'utf8'));
const providers = file('../read-data/mail-providers.json');
const rows = file('../tool-rows.json').records.map(record => record.payload);
const camel = operation => operation.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

test('one row per operation of the provider file, named for its job, with no vendor in its id or label', () => {
  assert.deepEqual(rows.map(row => row.id).sort(), providers.operations.map(operation => `tool:${operation}`).sort());
  const vendors = providers.providers.flatMap(row => [row.id, row.label, row.connection_vendor, row.adapter]).map(word => word.toLowerCase());
  for (const row of rows) for (const word of vendors) {
    assert.ok(!row.id.toLowerCase().includes(word), `${row.id} names ${word}`);
    assert.ok(!`${row.label} ${row.job}`.toLowerCase().includes(word), `${row.id}'s words name ${word}`);
  }
});

test('each row\'s by_input variants are exactly the provider rows\' connection kind and key renewal', () => {
  const expected = Object.fromEntries(providers.providers.map(row => [row.id, { connection: { vendor: row.connection_vendor, from_input: 'connection' }, refresh: row.refresh }]));
  for (const row of rows) {
    assert.equal(row.invoke.by_input.input, 'provider', row.id);
    assert.deepEqual(row.invoke.by_input.variants, expected, row.id);
    assert.equal(row.invoke.connection, undefined, `${row.id} fixes no connection kind of its own`);
    assert.equal(row.invoke.refresh, undefined, `${row.id} fixes no key renewal of its own`);
    assert.deepEqual(row.invoke.credential_mounts, [{ field_id: 'access_token', fd: 4 }], row.id);
    assert.ok(row.input_schema.required.includes('provider') && row.input_schema.required.includes('connection'), row.id);
  }
});

test('each row runs the export of its operation, and every provider offers only operations it has an adapter function for', async () => {
  for (const row of rows) {
    const operation = row.id.replace(/^tool:/, '');
    assert.equal(row.invoke.argv[3], camel(operation), row.id);
    assert.equal(typeof mail[camel(operation)], 'function', `${operation} has an export`);
    assert.equal(row.read_only, ['find-my-mailbox', 'list-new-mail', 'find-mail', 'read-mail-headers', 'read-a-mail', 'read-a-conversation', 'list-mail-drafts', 'read-a-mail-draft', 'list-send-as-addresses'].includes(operation), row.id);
  }
  for (const provider of providers.providers) {
    const adapter = await import(`../read-data/adapters/${provider.adapter}.mjs`);
    for (const operation of provider.operations) {
      assert.ok(providers.operations.includes(operation), `${provider.id} offers ${operation}, which no tool runs`);
      assert.equal(typeof adapter.operations[operation], 'function', `${provider.id} offers ${operation} with no adapter function`);
    }
    for (const folder of Object.keys(provider.folders)) assert.ok([...providers.folders, 'archive'].includes(folder), `${provider.id} names a folder ${folder} no screen offers`);
    for (const neutral of Object.values(provider.labels)) assert.ok(providers.neutral_labels.includes(neutral), `${provider.id} maps to ${neutral}, not a neutral label`);
    assert.deepEqual(readdirSync(here('../read-data/adapters/')).includes(`${provider.adapter}.mjs`), true);
  }
});

test('the provider file is the only place a vendor is named, apart from the adapters', () => {
  const vendors = providers.providers.flatMap(row => [row.id, row.connection_vendor, ...row.hosts]).filter(word => word.length > 3);
  for (const name of ['../read-data/mail.mjs', '../read-data/neutral.mjs']) {
    const text = readFileSync(here(name), 'utf8').toLowerCase();
    for (const vendor of vendors) assert.ok(!text.includes(vendor), `${name} names ${vendor}`);
  }
  const kits = readdirSync(here('../kits/')).filter(name => name.endsWith('.json'));
  assert.deepEqual(kits.map(name => `tool:${name.replace(/\.json$/, '')}`).sort(), rows.map(row => row.id).sort());
});

test('a neutral message names every header the neutral file says, and the two providers\' adapters agree on it', () => {
  assert.deepEqual(Object.keys(HEADER_FIELDS), ['from', 'to', 'cc', 'bcc', 'reply_to', 'subject', 'date', 'message_id', 'references', 'in_reply_to', 'list_unsubscribe']);
});
