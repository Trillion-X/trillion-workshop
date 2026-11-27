// tool:manage-my-api-descriptions: the caller's own rows come in as input and the change goes back as keep. Made-up
// rows only; nothing here reads or writes a store.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { accountToolSourcesFromTask } from '../do-work/sources.mjs';

const kinds = { openapi: { label: 'OpenAPI description', becomes: 'tool rows', source: { kind: 'tool-row-source', list: { url: 'x' }, row: { id_prefix: 'x.', placements: ['placement:your-computer'] } } } };
const source_data = { config: { kinds, sources: [] }, reads: [] };
const run = input => accountToolSourcesFromTask({ input, source_data });
const add = { kind: 'openapi', url: 'https://api.example.test/openapi.json', name: 'Example', id: 'example-api' };

test('a list with no input reads nothing and keeps nothing', async () => {
  const value = await run({});
  assert.deepEqual(value.yours, []);
  assert.equal(value.keep, undefined);
});

test('an add answers the source row and its receipt to keep, with no version to match', async () => {
  const value = await run({ add, request_key: 'k-1', receipt: null });
  assert.equal(value.keep.length, 2);
  const [row, receipt] = value.keep;
  assert.equal(row.id, 'tool-source:example-api');
  assert.equal(row.type, 'tool-source');
  assert.equal(row.expected, null);
  assert.equal(row.value.id, 'example-api');
  assert.equal(receipt.type, 'tool-source-change');
  assert.match(receipt.id, /^tool-source-change:/);
  assert.equal(receipt.expected, null);
  assert.equal(value.yours[0].id, 'example-api', 'the answer lists the change as it will stand');
});

test('a retry with the receipt the store holds makes no change', async () => {
  const first = await run({ add, request_key: 'k-2', receipt: null });
  const receipt = { id: first.keep[1].id, type: 'tool-source-change', value: { command_identity: first.keep[1].value.command_identity } };
  const again = await run({ add, request_key: 'k-2', receipt });
  assert.equal(again.keep, undefined);
});

test('a receipt for another request_key is refused', async () => {
  const first = await run({ add, request_key: 'k-3', receipt: null });
  const wrong = { id: 'tool-source-change:nothing', type: 'tool-source-change', value: { command_identity: first.keep[1].value.command_identity } };
  await assert.rejects(run({ add, request_key: 'k-3', receipt: wrong }), /not the one for this request_key/);
});

test('an edit keeps the identity the store gave the row, and the change returns that version as expected', async () => {
  const base = (await run({ add, request_key: 'k-4', receipt: null })).keep[0].value;
  const own = [{ id: 'tool-source:example-api', value: base, identity: 'ident-1' }];
  const edit = { id: 'example-api', name: 'Renamed' };
  const value = await run({ edit, request_key: 'k-5', own, receipt: null });
  assert.equal(value.keep[0].expected.identity, 'ident-1');
  assert.equal(value.keep[0].value.name, 'Renamed');
  assert.equal(value.keep[0].value.added_at, base.added_at);
});

test('a remove writes a tombstone at the version it was read', async () => {
  const base = (await run({ add, request_key: 'k-6', receipt: null })).keep[0].value;
  const own = [{ id: 'tool-source:example-api', value: base, identity: 'ident-2' }];
  const value = await run({ remove: 'example-api', request_key: 'k-7', own, receipt: null });
  assert.equal(value.keep[0].value.status, 'deleted');
  assert.equal(value.keep[0].expected.identity, 'ident-2');
});

test('an own row without its identity is refused, so no change is made against an unknown version', async () => {
  const base = (await run({ add, request_key: 'k-8', receipt: null })).keep[0].value;
  await assert.rejects(run({ edit: { id: 'example-api', name: 'x' }, request_key: 'k-9', own: [{ id: 'tool-source:example-api', value: base }] }), /identity/);
});

test('a header that carries a credential is refused, and nothing is kept', async () => {
  await assert.rejects(run({ add: { ...add, headers: { Authorization: 'secret' } }, request_key: 'k-10', receipt: null }), /connection owner/);
});

test('the tool holds no records door and no row names a records operation', () => {
  const source = readFileSync(new URL('../do-work/sources.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /door\.|readRecord|records:/);
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(one => one.payload);
  assert.equal(JSON.stringify(rows).includes('"records:'), false, 'no row names a records operation');
  assert.equal(JSON.stringify(rows).includes('records-door'), false, 'no row mounts the records door');
});
