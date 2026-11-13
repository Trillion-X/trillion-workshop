// tools/bring-in-new-items-from-this-computer/test/inputs-are-rows.test.mjs
//
// Every place items come from is a row of the account list `inputs` (computer/inputs.mjs), proved on a records door kept
// in memory and a made-up service: the list is made once with computer-sources.json's rows as its starting rows and is
// never refilled; the places the reader looks at and reads are the list's rows; a row the person sets to not be read
// is listed and unread; a row removed stays removed; an unreachable account leaves the last rows being read; and a
// connected service the code has never heard of is one more row (reader `tool`, a Workshop tool and where its list of
// new things is) and its new things arrive, once each, with no code change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readNewItems} from '../computer/read-new-items.mjs';
import {inputsDefinition, liveInputs, readable, readersWith, serviceReader, startersOf, toolRunner} from '../computer/inputs.mjs';
import {listsOverDoor} from '../../records-door/read-data/lists-door.mjs';
import {memoryDoor} from '../../watch-my-sources/test/memory-door.mjs';

const rows = JSON.parse(fs.readFileSync(new URL('../computer/computer-sources.json', import.meta.url), 'utf8'));
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inputs-are-rows-'));
const MADE_UP = {
  label: 'Madeup Notes', category: 'Notes', connection: 'service_connection:madeup-notes', look: {paths: []},
  read: {route: 'Madeup Notes', reader: 'tool', tool: 'tool:madeup-notes-list-changed', input: {connection: {connection_id: 'service_connection:madeup-notes'}, changed_since: '{since}'},
    items: 'notes', time: 'unix-seconds', fields: {source_id: 'id', at: 'changed', title: 'name', text: 'body'}, settle_seconds: 0},
};

function standInAccount() {
  const kept = new Map();
  return {
    kept,
    keep: async file => ({id: `file:${file.name}`, name: file.name}),
    account: async (route, {body}) => {
      const one = item => { const id = `${item.route}:${item.source_id}`; kept.set(id, {...item, arrivals: (kept.get(id)?.arrivals ?? 0) + 1}); return {message_id: `message:${id}`, arrival_id: `arrival:${id}`, repeated: false}; };
      return body.items ? {status: 200, body: {items: body.items.map(one)}} : {status: 200, body: one(body)};
    },
  };
}

test('the list is made once with the file\'s rows as its starting rows, and the reader\'s places are the list\'s rows', async () => {
  const door = memoryDoor();
  const lists = listsOverDoor(door);
  const inputs = liveInputs({lists, rows});
  assert.deepEqual(inputs.sources.map(source => source.id), rows.sources.map(source => source.id), 'before the account is read, the starting rows are the places');
  assert.equal(await inputs.refresh(), true);
  assert.equal(inputs.ready(), true);
  const held = await lists.read('inputs');
  assert.equal(held.rows.length, rows.sources.length, 'every starting row is a row of the list');
  assert.equal(held.list.title_field, 'label');
  assert.deepEqual(inputs.carriers.map(carrier => carrier.route).sort(), rows.sources.filter(source => source.read).map(source => source.read.route).sort());

  const writes = door.writes.length;
  const again = liveInputs({lists: listsOverDoor(door), rows});
  await again.refresh();
  assert.equal(door.writes.length, writes, 'another reader finds the list and writes nothing');
});

test('a row the person removed stays removed, and one set to not be read is listed and unread', async () => {
  const door = memoryDoor();
  const lists = listsOverDoor(door);
  await liveInputs({lists, rows}).refresh();
  const records = [...door.kept.values()].filter(record => record.type === 'record:inputs');
  const downloads = records.find(record => record.id === 'record:inputs:downloads');
  const photos = records.find(record => record.id === 'record:inputs:photos');
  assert.ok(downloads && photos);
  await door.write([{id: downloads.id, type: downloads.type, value: null}]);
  await lists.putRows('inputs', {rows: [{id: 'photos', values: {reading: 'No'}}]});

  const inputs = liveInputs({lists: listsOverDoor(door), rows});
  await inputs.refresh();
  assert.equal(inputs.sources.some(source => source.id === 'downloads'), false, 'the removed place is not put back');
  assert.ok(inputs.sources.some(source => source.id === 'photos'), 'a place not read is still listed');
  assert.equal(inputs.carriers.some(carrier => carrier.route === 'Photos'), false, 'and is not read');
  assert.equal(inputs.carriers.some(carrier => carrier.route === 'Apple Notes'), true);
});

test('an unreachable account leaves the last rows being read, and a restart goes on from them', async () => {
  const folder = dir();
  const cacheFile = path.join(folder, 'inputs-cache.json');
  const door = memoryDoor();
  const lists = listsOverDoor(door);
  const first = liveInputs({lists, rows, cacheFile});
  await first.refresh();
  await lists.putRows('inputs', {rows: [{id: 'madeup-notes', values: MADE_UP}]});
  await first.refresh({force: true});
  assert.ok(first.carriers.some(carrier => carrier.route === 'Madeup Notes'));

  const broken = {find: async () => { throw new Error('the account could not be reached'); }, ensure: async () => { throw new Error('the account could not be reached'); }, read: async () => { throw new Error('the account could not be reached'); }};
  const lines = [];
  const restarted = liveInputs({lists: broken, rows, cacheFile, log: line => lines.push(line)});
  assert.ok(restarted.carriers.some(carrier => carrier.route === 'Madeup Notes'), 'a restart reads the rows it last saw, not only the starting rows');
  assert.equal(await restarted.refresh(), false);
  assert.ok(restarted.carriers.some(carrier => carrier.route === 'Madeup Notes'));
  assert.match(lines.join('\n'), /could not be read/);
});

test('a connected service the code has never heard of is one more row, and its new things arrive once each', async () => {
  const folder = dir();
  const door = memoryDoor();
  const lists = listsOverDoor(door);
  const inputs = liveInputs({lists, rows: {...rows, sources: rows.sources.filter(source => source.id === 'wispr-flow')}});
  await inputs.refresh();
  assert.equal(inputs.carriers.some(carrier => carrier.route === 'Madeup Notes'), false);

  // The person adds the service: one row of their list.
  await lists.putRows('inputs', {rows: [{id: 'madeup-notes', values: MADE_UP}]});
  await inputs.refresh({force: true});
  const carrier = inputs.carriers.find(held => held.route === 'Madeup Notes');
  assert.ok(carrier, 'the new row is a place the reader reads');

  let clock = Date.parse('2026-11-13T12:00:00Z');
  const asked = [];
  const run = async (tool, input) => {
    asked.push({tool, input});
    const from = Date.parse(input.changed_since) / 1000;
    const noon = Date.parse('2026-11-13T12:00:00Z') / 1000;
    return {notes: [
      {id: 'old', name: 'Before', body: 'written before the first look', changed: noon - 100},
      {id: 'n1', name: 'Plan', body: 'Call the supplier on Monday', changed: noon + 1800},
      {id: 'empty', name: 'Blank', body: '   ', changed: noon + 1900},
    ].filter(note => note.changed > from)};
  };
  const stand = standInAccount();
  const look = () => readNewItems({carriers: inputs.carriers, account: stand.account, keep: stand.keep, stateFile: path.join(folder, 'state.json'), readers: readersWith({tool: serviceReader(run)}), now: () => new Date(clock)});

  await look().tick();
  clock += 3_600_000;
  await look().tick();
  await look().tick();
  assert.ok(asked.length >= 2 && asked.every(call => call.tool === 'tool:madeup-notes-list-changed'), 'the service is read by the tool its row names');
  assert.equal(asked[0].input.connection.connection_id, 'service_connection:madeup-notes', 'with the connection its row names, by handle');
  const kept = stand.kept;
  assert.ok(kept.has('Madeup Notes:n1'), 'the new note arrived');
  assert.equal(kept.get('Madeup Notes:n1').arrivals, 1, 'once');
  assert.equal(kept.get('Madeup Notes:n1').text, 'Call the supplier on Monday');
  assert.equal(kept.get('Madeup Notes:n1').title, 'Plan');
  assert.equal(kept.has('Madeup Notes:empty'), false, 'a thing with no words is passed over');
});

test('a tool whose input is a number gets the number', async () => {
  let asked;
  const items = await serviceReader(async (tool, input) => { asked = input; return {data: [{id: 'txn_1', created: 1_800_000_100, description: 'Payment'}]}; })(
    {route: 'X', tool: 'tool:x', input: {since: '{since_seconds}', note: 'from {since}'}, items: 'data', time: 'unix-seconds', fields: {source_id: 'id', at: 'created', text: 'description'}}, new Date(1_800_000_000_000));
  assert.deepEqual(asked, {since: 1_800_000_000, note: 'from 2027-01-15T08:00:00.000Z'});
  assert.equal(items[0].at, '2027-01-15T08:01:40.000Z');
});

test('a tool that did not finish is an error, and its answer is read from the door\'s result', async () => {
  assert.deepEqual(await toolRunner({run: async () => ({status: 200, result: {data: []}, headers: {}})})('tool:x', {}), {data: []});
  await assert.rejects(toolRunner({run: async () => ({exit_code: 1, error: 'the service is not connected'})})('tool:x', {}), /not connected/);
  await assert.rejects(toolRunner({run: async () => ({status: 401, result: {error: {message: 'bad key'}}})})('tool:x', {}), /bad key/);
});

test('a service reader says what is wrong with a row that cannot be read', async () => {
  const read = serviceReader(async () => ({notes: 'not a list'}));
  await assert.rejects(read({route: 'X', tool: 'tool:x', items: 'notes'}, new Date()), /answered no list at notes/);
  await assert.rejects(read({route: 'X'}, new Date()), /names no tool/);
  assert.deepEqual(await serviceReader(async () => ({}))({route: 'X', tool: 'tool:x', items: 'notes'}, new Date()), [], 'an answer with no list holds no new things');
  assert.equal(startersOf(rows).length, rows.sources.length);
  assert.equal(inputsDefinition().id, 'inputs');
});

test('a first run cut off after the list was made goes on from there: the missing starting rows are put in once, then the list is marked seeded', async () => {
  const door = memoryDoor();
  const real = door.write;
  let writes = 0;
  door.write = async (...args) => { writes += 1; if (writes === 2) throw new Error('the connection dropped'); return real(...args); };
  const first = liveInputs({lists: listsOverDoor(door), rows});
  assert.equal(await first.refresh(), false, 'the cut-off run reads nothing from the list');
  assert.equal([...door.kept.values()].filter(record => record.type === 'record:inputs').length, 0, 'the list was made without its rows');

  const again = liveInputs({lists: listsOverDoor(door), rows});
  assert.equal(await again.refresh(), true);
  const lists = listsOverDoor(door);
  assert.equal((await lists.read('inputs')).rows.length, rows.sources.length, 'every starting row is there, once');
  assert.ok((await lists.find('inputs')).seeded, 'the list is marked seeded');
  const marked = door.writes.length;
  await liveInputs({lists: listsOverDoor(door), rows}).refresh();
  assert.equal(door.writes.length, marked, 'a seeded list is not written again');
});

test('two readers starting together end with one list and each starting row once', async () => {
  const door = memoryDoor();
  const a = liveInputs({lists: listsOverDoor(door), rows, everySeconds: 0}), b = liveInputs({lists: listsOverDoor(door), rows, everySeconds: 0});
  await Promise.all([a.refresh(), b.refresh()]);
  await a.refresh({force: true});
  await b.refresh({force: true});
  const held = (await listsOverDoor(door).read('inputs')).rows;
  assert.equal(held.length, rows.sources.length);
  assert.equal(new Set(held.map(row => row.id)).size, held.length);
  assert.equal(a.carriers.length, b.carriers.length);
  assert.ok(a.carriers.length > 0);
});

test('two rows with one route are not both read, and a read block with no route is left unread', () => {
  const lines = [];
  const places = [
    {id: 'one', read: {route: 'Same'}}, {id: 'two', read: {route: 'Same'}}, {id: 'none', read: {reader: 'sqlite'}},
    {id: 'paused', reading: 'No', read: {route: 'Paused'}}, {id: 'look-only', look: {paths: []}}, {id: 'fine', read: {route: 'Fine'}},
  ];
  assert.deepEqual(readable(places, line => lines.push(line)).map(place => place.id), ['one', 'fine']);
  assert.match(lines.join('\n'), /two shares the route "Same" with one/);
  assert.match(lines.join('\n'), /none has a read block with no route/);
});

test('a read cut off by the account sends the rest next look and never what was sent again, and a failing service names why while the other places read', async () => {
  const folder = dir();
  const noon = Date.parse('2026-11-13T12:00:00Z');
  let clock = noon, failSecond = true;
  const things = [{id: 'a', words: 'first', at: noon / 1000 + 600}, {id: 'b', words: 'second', at: noon / 1000 + 660}];
  const carrier = {route: 'Cut service', reader: 'tool', tool: 'tool:cut-list', items: 'things', time: 'unix-seconds', fields: {source_id: 'id', at: 'at', text: 'words'}, settle_seconds: 0};
  const broken = {route: 'Broken service', reader: 'tool', tool: 'tool:broken-list', items: 'things', fields: {source_id: 'id', text: 'words'}, settle_seconds: 0};
  const stand = standInAccount();
  const account = async (route, request) => (failSecond && request.body.source_id === 'b' ? {status: 500, body: {error: 'the account dropped'}} : stand.account(route, request));
  const run = async tool => { if (tool === 'tool:broken-list') throw new Error('service_connection:broken is not connected'); return {things}; };
  const look = () => readNewItems({carriers: [carrier, broken], account, keep: stand.keep, stateFile: path.join(folder, 'state.json'), readers: readersWith({tool: serviceReader(run)}), now: () => new Date(clock)});
  await look().tick();
  clock += 3_600_000;
  await look().tick();
  assert.equal(stand.kept.get('Cut service:a')?.arrivals, 1);
  assert.equal(stand.kept.has('Cut service:b'), false, 'the item the account dropped is not marked sent');
  failSecond = false;
  clock += 120_000;
  await look().tick();
  await look().tick();
  assert.equal(stand.kept.get('Cut service:a').arrivals, 1, 'what was sent is never sent again');
  assert.equal(stand.kept.get('Cut service:b').arrivals, 1);
  const status = look().status();
  assert.match(status.find(place => place.route === 'Broken service').status, /is not connected/, 'a failing service says why');
});

test('a place not read for longer than its warning time says so in its status, and a place being read does not', async () => {
  const folder = dir();
  let clock = Date.parse('2026-11-13T12:00:00Z'), reading = false;
  const carrier = {route: 'Quiet', reader: 'tool', tool: 'tool:quiet', items: 'things', fields: {source_id: 'id', text: 'words'}, settle_seconds: 0};
  const run = async () => { if (!reading) throw new Error('could not be reached'); return {things: []}; };
  const stand = standInAccount();
  const look = () => readNewItems({carriers: [carrier], account: stand.account, keep: stand.keep, stateFile: path.join(folder, 'state.json'), readers: readersWith({tool: serviceReader(run)}), warnAfterHours: 24, now: () => new Date(clock)});
  await look().tick();
  clock += 20 * 3_600_000;
  assert.equal(look().status()[0].warning, undefined, 'twenty hours is inside the warning time');
  clock += 6 * 3_600_000;
  assert.match(look().status()[0].warning, /has not been read for 26 hours/);
  reading = true;
  await look().tick();
  assert.equal(look().status()[0].warning, undefined, 'a place that reads again is no longer warned about');
});
