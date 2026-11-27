// tools/list-and-run-my-tools-for-any-ai/test/publish-screen-rows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publishScreenRows, PublishScreenRowsError } from '../do-work/publish-screen-rows.mjs';
import { savedAndListedDatabase } from './saved-and-listed-database.mjs';

// The catalogue's own rows, as the held step read them: every row must save and publish with the current owners.
const catalogue = JSON.parse(readFileSync(new URL('../../show-my-screens-from-a-catalogue-of-reads-and-layouts/records/marketplace-screens.json', import.meta.url), 'utf8')).tools;

// The host version the host-version guard reads (the catalogue rows name no minimum, so it is not checked for them).
const facts = { hostVersion: '2026.11.20' };

const codeTool = {
  kind: 'ai-tool-descriptor', id: 'tool:echo-test', job: 'Echo the input text back',
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
  invoke: { kind: 'container', run: ['python3', 'main.py'], workdir: '/work' },
  can_do: ['Echo the text back'], cannot_do: ['Send messages'],
  verify: [{ kind: 'sample-run', input: { text: 'hi' } }],
};

test('every catalogue row saves and publishes as the maker, in row order, with no files (they run no code of their own)', async () => {
  const db = savedAndListedDatabase();
  const results = await publishScreenRows({ ...facts, rows: catalogue, maker: 'person:publisher', client: db.client });
  assert.equal(results.length, catalogue.length);
  assert.deepEqual(results.map(row => row.id), catalogue.map(row => row.id));
  assert.ok(results.every(row => row.saved && row.published), JSON.stringify(results.filter(row => !row.published)).slice(0, 400));
  assert.equal(db.listings.length, catalogue.length);
  assert.ok(db.listings.every(row => row.maker === 'person:publisher' && row.status === 'published'));
  assert.ok(db.saved.every(row => row.files.length === 0), 'a code-free row keeps no file bytes');
});

test('a row refused on the way (no sample-run check) is reported, and the rows after it still publish', async () => {
  const db = savedAndListedDatabase();
  const rows = [catalogue[0], { ...catalogue[1], verify: [] }, catalogue[2]];
  const results = await publishScreenRows({ ...facts, rows, maker: 'person:publisher', client: db.client });
  assert.deepEqual(results.map(row => [row.id, row.saved, row.published]), [
    [catalogue[0].id, true, true],
    [catalogue[1].id, false, false],
    [catalogue[2].id, true, true],
  ]);
  assert.match(results[1].error, /verify must be a non-empty list/);
  assert.equal(db.listings.length, 2);
});

test('a row the publish step refuses is reported as not saved and not published, as the held step answered', async () => {
  const db = savedAndListedDatabase({ listings: [{ tool_id: catalogue[0].id, maker: 'person:someone-else', status: 'published' }] });
  const results = await publishScreenRows({ ...facts, rows: [catalogue[0]], maker: 'person:publisher', client: db.client });
  assert.deepEqual([results[0].saved, results[0].published], [false, false]);
  assert.match(results[0].error, /belongs to another maker/);
  assert.equal(db.listings.length, 1);
});

test('a row whose save is refused reports saved false and published false, with the first line of the reason', async () => {
  const db = savedAndListedDatabase();
  const results = await publishScreenRows({ ...facts, rows: [{ ...catalogue[0], invoke: undefined }], maker: 'person:publisher', client: db.client });
  assert.equal(results[0].saved, false);
  assert.equal(results[0].published, false);
  assert.equal(results[0].error.includes('\n'), false);
  assert.equal(db.listings.length, 0);
});

test('a code tool still needs its files: a container row with no files is refused by save, as before', async () => {
  const db = savedAndListedDatabase();
  const results = await publishScreenRows({ ...facts, rows: [codeTool], maker: 'person:publisher', client: db.client });
  assert.deepEqual([results[0].saved, results[0].published], [false, false]);
  assert.match(results[0].error, /exactly one of them/);
});

test('the maker and the rows are required', async () => {
  const db = savedAndListedDatabase();
  await assert.rejects(publishScreenRows({ ...facts, rows: catalogue, client: db.client }), PublishScreenRowsError);
  await assert.rejects(publishScreenRows({ ...facts, rows: catalogue, maker: '  ', client: db.client }), /maker: the person publishing/);
  await assert.rejects(publishScreenRows({ ...facts, rows: 'nope', maker: 'person:publisher', client: db.client }), /rows: the catalogue rows/);
});
