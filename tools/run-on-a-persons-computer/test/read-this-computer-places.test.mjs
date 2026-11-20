// test/read-this-computer-places.test.mjs
// The reader's places are the rows of the person's `inputs` list handed in by the program that starts it, kept for a
// restart without them; a place read with a tool runs that tool on the account (tools:run), never through a door.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { placesOf, startReading, toolRunOver } from '../read-this-computer.mjs';

const folder = () => tempFolder(path.join(os.tmpdir(), 'read-this-computer-places-'));
const starters = { sources: [{ id: 'starter', label: 'Starter', read: { route: 'Starter', reader: 'folder' } }], every_seconds: 600, read_every_seconds: 30, files_folder: '/Files' };
const service = { id: 'made-up', values: { label: 'Made-up service', category: 'Notes', look: { paths: [] }, read: { route: 'Made-up service', reader: 'tool', tool: 'tool:made-up-list', items: 'things', fields: { source_id: 'id', text: 'words' }, settle_seconds: 0 } } };

test('handed-in rows are the places and are kept; without them the kept rows, else the starting rows', () => {
  const cacheFile = path.join(folder(), 'inputs-cache.json');
  assert.deepEqual(placesOf({ rows: starters, cacheFile }).map(place => place.id), ['starter'], 'nothing handed in and nothing kept: the starting rows');
  assert.deepEqual(placesOf({ rows: starters, places: [service], cacheFile }).map(place => place.id), ['made-up'], 'the handed-in rows are the places');
  assert.deepEqual(placesOf({ rows: starters, cacheFile }).map(place => place.id), ['made-up'], 'a restart without them reads the rows kept');
  assert.deepEqual(placesOf({ rows: starters, places: [], cacheFile }), [], 'an empty list handed in is no places, not the starting rows');
});

test('a tool place runs its tool on the account with one key per read and answers its result', async () => {
  const asked = [];
  const run = toolRunOver(async (name, args) => { asked.push({ name, args }); return { tool: args.input.tool, exit_code: 0, result: { things: [] } }; });
  assert.deepEqual(await run('tool:made-up-list', { since: 'a' }), { things: [] });
  await run('tool:made-up-list', { since: 'a' });
  await run('tool:made-up-list', { since: 'b' });
  assert.equal(asked[0].name, 'do_one_thing_in_my_account');
  assert.equal(asked[0].args.method, 'tools:run');
  assert.deepEqual(asked[0].args.input, { tool: 'tool:made-up-list', input: { since: 'a' } });
  assert.equal(asked[0].args.request_key, asked[1].args.request_key, 'the same read sent again has the same key');
  assert.notEqual(asked[0].args.request_key, asked[2].args.request_key, 'another read has its own key');
  assert.doesNotMatch(JSON.stringify(asked), /records:/, 'no records operation is asked');
});

test('a tool run that did not finish is a throw saying why', async () => {
  const run = toolRunOver(async () => ({ tool: 'tool:made-up-list', exit_code: 1, error: 'the service is closed' }));
  await assert.rejects(run('tool:made-up-list', {}), /tool:made-up-list did not finish: the service is closed/);
});

test('the reader reads a service row handed in, with its tool run on the account', async () => {
  const shared = folder(), runs = [];
  const call = async (name, args) => { runs.push(args.input.tool); return { result: { things: [{ id: 't1', words: 'first thing' }] } }; };
  const reader = startReading({ rows: starters, places: [service], call, account: async () => ({ status: 200, body: { message_id: 'm1', arrival_id: 'a1' } }),
    keep: async () => ({}), shared, timers: false, log: () => {}, hearing: () => null, look: async () => ({ sources: [], browser_sites: [] }) });
  try {
    await reader.once();
    assert.deepEqual(reader.status().places.map(place => place.route), ['Made-up service'], 'the handed-in row is the place read');
    assert.deepEqual(runs, ['tool:made-up-list']);
  } finally { reader.stop(); fs.rmSync(shared, { recursive: true, force: true }); }
});

test('two handed-in rows with one route are read once, and the log names the other', async () => {
  const shared = folder(), lines = [];
  const twin = { id: 'made-up-twin', values: { ...service.values, label: 'Twin' } };
  const reader = startReading({ rows: starters, places: [service, twin], call: async () => ({ result: { things: [] } }), account: async () => ({ status: 200, body: {} }),
    keep: async () => ({}), shared, timers: false, log: line => lines.push(line), hearing: () => null, look: async () => ({ sources: [], browser_sites: [] }) });
  try {
    await reader.once();
    assert.deepEqual(reader.status().places.map(place => place.route), ['Made-up service']);
    assert.ok(lines.some(line => line.includes('made-up-twin')), 'the row left unread is named');
  } finally { reader.stop(); fs.rmSync(shared, { recursive: true, force: true }); }
});
