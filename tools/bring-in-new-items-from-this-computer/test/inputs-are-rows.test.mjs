// tools/bring-in-new-items-from-this-computer/test/inputs-are-rows.test.mjs
//
// Every place items come from is a row of the account list `inputs` (computer/inputs.mjs), proved on a list kept in
// memory by this test (the caller's store: it reads the list, hands it in and keeps what the reader asks for) and a
// made-up service: the list is made once with computer-sources.json's rows as its starting rows and is never refilled;
// the places the reader looks at and reads are the list's rows; a row the person sets to not be read is listed and
// unread; a row removed stays removed; an unreachable account leaves the last rows being read; and a connected service
// the code has never heard of is one more row (reader `tool`, a Workshop tool and where its list of new things is) and
// its new things arrive, once each, with no code change.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readNewItems} from '../computer/read-new-items.mjs';
import {inputsDefinition, liveInputs, readable, readersWith, serviceReader, startersOf} from '../computer/inputs.mjs';

const rows = JSON.parse(fs.readFileSync(new URL('../computer/computer-sources.json', import.meta.url), 'utf8'));
const dir = () => tempFolder(path.join(os.tmpdir(), 'inputs-are-rows-'));
const MADE_UP = {
  label: 'Madeup Notes', category: 'Notes', connection: 'service_connection:madeup-notes', look: {paths: []},
  read: {route: 'Madeup Notes', reader: 'tool', tool: 'tool:madeup-notes-list-changed', input: {connection: {connection_id: 'service_connection:madeup-notes'}, changed_since: '{since}'},
    items: 'notes', time: 'unix-seconds', fields: {source_id: 'id', at: 'changed', title: 'name', text: 'body'}, settle_seconds: 0},
};

// The list as the caller's store keeps it: records by id, {type, value}. A keep write is refused when the record it
// expected has moved, as a store refuses it; writes before a failing one stay kept.
function storeInMemory() {
  const records = new Map();
  let writes = 0;
  return {
    records,
    get writes() { return writes; },
    // The list as the caller reads it: {list, rows: [{id, values}]}, list null when the list is not made yet.
    read() {
      const list = records.get('list:inputs');
      if (!list) return {list: null, rows: []};
      const rowsHeld = [...records].filter(([, record]) => record.type === 'record:inputs').map(([id, record]) => ({id: id.slice('record:inputs:'.length), values: record.value}));
      return {list: list.value, rows: rowsHeld};
    },
    keep(writesToKeep, {failAt = -1} = {}) {
      writesToKeep.forEach((write, at) => {
        if (at === failAt) throw new Error('the connection dropped');
        const held = records.has(write.id) ? {type: records.get(write.id).type, value: records.get(write.id).value} : null;
        if (!isDeepStrictEqual(held, write.expected)) throw new Error(`${write.id} moved since it was read`);
        records.set(write.id, {type: write.type, value: write.value});
        writes += 1;
      });
    },
    // A row the person changed or added: its values merged over what it holds (a null takes the field out).
    putRow(id, values) {
      const recordId = `record:inputs:${id}`;
      const value = {...(records.get(recordId)?.value ?? {})};
      for (const [field, given] of Object.entries(values)) { if (given === null) delete value[field]; else value[field] = given; }
      records.set(recordId, {type: 'record:inputs', value});
    },
    remove(id) { records.delete(`record:inputs:${id}`); },
  };
}

// The caller's part of a look: read the list (null when the read fails), keep the writes take returns, then apply.
async function refreshWith(inputs, store, {force = false, failAt} = {}) {
  if (!inputs.due({force})) return false;
  let held = null;
  try { held = store.read(); } catch { held = null; }
  const {keep, sources} = inputs.take(held);
  if (keep.length) store.keep(keep, {failAt});
  inputs.apply(sources);
  return sources !== null;
}

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
  const store = storeInMemory();
  const inputs = liveInputs({rows});
  assert.deepEqual(inputs.sources.map(source => source.id), rows.sources.map(source => source.id), 'before the account is read, the starting rows are the places');
  assert.equal(await refreshWith(inputs, store), true);
  assert.equal(inputs.ready(), true);
  const held = store.read();
  assert.equal(held.rows.length, rows.sources.length, 'every starting row is a row of the list');
  assert.equal(held.list.title_field, 'label');
  assert.deepEqual(inputs.carriers.map(carrier => carrier.route).sort(), rows.sources.filter(source => source.read).map(source => source.read.route).sort());

  const writes = store.writes;
  await refreshWith(liveInputs({rows}), store);
  assert.equal(store.writes, writes, 'another reader finds the list and writes nothing');
});

test('a row the person removed stays removed, and one set to not be read is listed and unread', async () => {
  const store = storeInMemory();
  await refreshWith(liveInputs({rows}), store);
  store.remove('downloads');
  store.putRow('photos', {reading: 'No'});

  const inputs = liveInputs({rows});
  await refreshWith(inputs, store);
  assert.equal(inputs.sources.some(source => source.id === 'downloads'), false, 'the removed place is not put back');
  assert.ok(inputs.sources.some(source => source.id === 'photos'), 'a place not read is still listed');
  assert.equal(inputs.carriers.some(carrier => carrier.route === 'Photos'), false, 'and is not read');
  assert.equal(inputs.carriers.some(carrier => carrier.route === 'Apple Notes'), true);
});

test('an unreachable account leaves the last rows being read, and a restart goes on from them', async () => {
  const folder = dir();
  const cacheFile = path.join(folder, 'inputs-cache.json');
  const store = storeInMemory();
  const first = liveInputs({rows, cacheFile});
  await refreshWith(first, store);
  store.putRow('madeup-notes', MADE_UP);
  await refreshWith(first, store, {force: true});
  assert.ok(first.carriers.some(carrier => carrier.route === 'Madeup Notes'));

  const broken = {read: () => { throw new Error('the account could not be reached'); }, keep: () => { throw new Error('the account could not be reached'); }};
  const lines = [];
  const restarted = liveInputs({rows, cacheFile, log: line => lines.push(line)});
  assert.ok(restarted.carriers.some(carrier => carrier.route === 'Madeup Notes'), 'a restart reads the rows it last saw, not only the starting rows');
  assert.equal(await refreshWith(restarted, broken), false);
  assert.ok(restarted.carriers.some(carrier => carrier.route === 'Madeup Notes'));
  assert.match(lines.join('\n'), /could not be read/);
});

test('a connected service the code has never heard of is one more row, and its new things arrive once each', async () => {
  const folder = dir();
  const store = storeInMemory();
  const inputs = liveInputs({rows: {...rows, sources: rows.sources.filter(source => source.id === 'wispr-flow')}});
  await refreshWith(inputs, store);
  assert.equal(inputs.carriers.some(carrier => carrier.route === 'Madeup Notes'), false);

  // The person adds the service: one row of their list.
  store.putRow('madeup-notes', MADE_UP);
  await refreshWith(inputs, store, {force: true});
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

test('a tool that did not finish is an error the reader names, and a tool\'s answer is the run\'s result', async () => {
  const read = serviceReader(async tool => { if (tool === 'tool:y') throw new Error('the service is not connected'); return {data: []}; });
  assert.deepEqual(await read({route: 'X', tool: 'tool:x', items: 'data'}, new Date()), []);
  await assert.rejects(read({route: 'X', tool: 'tool:y', items: 'data'}, new Date()), /not connected/);
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
  const store = storeInMemory();
  await assert.rejects(refreshWith(liveInputs({rows}), store, {failAt: 1}), /the connection dropped/);
  assert.equal([...store.records.values()].filter(record => record.type === 'record:inputs').length, 0, 'the list was made without its rows');
  assert.equal(store.records.get('list:inputs').value.seeded, undefined, 'and is not marked seeded');

  assert.equal(await refreshWith(liveInputs({rows}), store), true);
  assert.equal(store.read().rows.length, rows.sources.length, 'every starting row is there, once');
  assert.ok(store.read().list.seeded, 'the list is marked seeded');
  const marked = store.writes;
  await refreshWith(liveInputs({rows}), store);
  assert.equal(store.writes, marked, 'a seeded list is not written again');
});

test('two readers starting together: a write made from a list read before the other kept its rows is refused, and the next look reads the one list', async () => {
  const store = storeInMemory();
  const first = liveInputs({rows}), second = liveInputs({rows});
  const firstWrites = first.take(store.read());
  const secondWrites = second.take(store.read());
  store.keep(firstWrites.keep);
  assert.throws(() => store.keep(secondWrites.keep), /moved since it was read/, 'the stale write is refused');
  first.apply(firstWrites.sources);

  assert.equal(await refreshWith(second, store, {force: true}), true);
  assert.equal(store.read().rows.length, rows.sources.length, 'each starting row is there, once');
  assert.equal(new Set(store.read().rows.map(row => row.id)).size, rows.sources.length);
  assert.equal(second.carriers.length, first.carriers.length);
  assert.ok(second.carriers.length > 0);
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
