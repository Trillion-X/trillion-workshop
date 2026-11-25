// tools/notice-when-something-shows-up/tests/kept-places-travel.test.mjs
//
// A waiter's place travels with its wake when the run names places_in (do-work/kept-places.mjs): two "computers" are two
// carriers, each with its own kept folder and its own wake book (the facts its door was told), over one database of
// places. The row-changes waiter reads a real change table (PGlite, the change stack workflow:make-a-database-for-each-pursuit
// lays down); the service-lists waiter reads a stand-in service. Nov 25 2026, 1:50 AM CST: a wake moved by wake:switch
// found a place from before Nov 22 in the other computer's kept folder and told days of row changes again.
import assert from 'node:assert/strict';
import { closeSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import * as rowChanges from '../do-work/mechanisms/row-changes.mjs';
import * as serviceLists from '../do-work/mechanisms/service-lists.mjs';
import { engineCarrier, EACH_WAITER_FD, placesConnection } from '../do-work/tell-the-engine.mjs';
import { runResidentEmitter, THIS_TOOL } from '../do-work/emit-arrival-fact.mjs';
import { folderPlaces, placesFor, PLACES_FD, PLACES_TABLE } from '../do-work/kept-places.mjs';

const ROW = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload;
/** The row's own row-changes waiter, reading again every second (a stand-in database sends no NOTIFY). */
const ROW_WAITER = (() => {
  const waiter = ROW.wakes.find(wake => wake.id === 'keep-noticing-row-changes').input.waiters[0];
  return { ...waiter, mechanism_settings: { ...waiter.mechanism_settings, look_again_seconds: 1 } };
})();
const ROW_KEY = `${ROW_WAITER.id}@${ROW_WAITER.emitted_record.address_label}`;
const SERVICE_WAITER = { kind: 'notice-when-something-shows-up.waiter-descriptor', id: 'waiter:my-bookings', is_active: true,
  mechanism_capability_ref: serviceLists.MECHANISM_REF, mechanism_leaf: 'service-lists.mjs',
  mechanism_settings: { where: 'my-bookings', request: { url: 'https://bookings.example.com/api/bookings', headers: { Authorization: 'Bearer {credential}' } },
    shape: { items: 'data', place: { value: 'booking' }, key: 'id', at: 'updated_at', at_unit: 'iso' }, list_is_whole: true, look_again_seconds: 1 },
  emitted_record: { change_kind: 'something-changed', address_label: 'where::something-changed', path_labels: ['current-item', 'something-changed'],
    payload_fields: ['where', 'place', 'change', 'key'] } };
const SERVICE_KEY = `${SERVICE_WAITER.id}@${SERVICE_WAITER.emitted_record.address_label}`;
const PLACES_IN = 'p_made_up_places-connection';

/** A database as a client of the shape every store here reads ({query, end}); end leaves the shared stand-in open. */
const clientOf = db => ({ query: (sql, params) => db.query(sql, params), end: async () => {} });

/** A database with the change stack and one watched table, notes. */
async function watchedDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());
  const stack = readFileSync(new URL('../../workflows/sql/consent-stack.sql', import.meta.url), 'utf8').split('-- Consent stack')[0];
  await db.exec(stack);
  await db.exec('CREATE TABLE notes (id int PRIMARY KEY); CREATE TRIGGER tell_row_change AFTER INSERT OR DELETE OR UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION record_row_change()');
  return db;
}
/** Adds notes, each in its own transaction; answers each change's own key (<database>:<txid>:<position>). */
async function addNotes(db, ids) {
  const keys = [];
  for (const id of ids) {
    await db.query('INSERT INTO notes VALUES ($1)', [id]);
    const [change] = (await db.query("SELECT current_database() || ':' || txid::text || ':' || position::text AS key FROM row_changes ORDER BY position DESC LIMIT 1")).rows;
    keys.push(change.key);
  }
  return keys;
}
async function placesDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());
  return db;
}

/** One computer: its own kept folder and wake book, and its run's place store (places_in's database when `places` is
 *  given, else its kept folder). `heard(fact, book)` is called with each fact its door is told. */
async function computer(name, { places = null, keep = tempFolder(path.join(tmpdir(), `noticer-${name}-`)), heard = () => {} } = {}) {
  const book = [];
  const said = [];
  const fetchImpl = async (url, { body }) => {
    const call = JSON.parse(body).params.arguments;
    book.push(call.input);
    heard(call.input, book);
    return new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 });
  };
  const store = await placesFor({ placesIn: places ? PLACES_IN : null, keep, tool: THIS_TOOL, keptOn: name, run: `${name}:run`,
    connection: 'postgresql://made-up-places', connect: async () => clientOf(places) });
  const carrier = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'c' }, waiters: [], fetchImpl, say: line => said.push(line), keep, places: store });
  return { name, keep, book, said, carrier, store };
}

/** Runs `waiter` on `machine` until `stop` aborts it (or `most_ms` passes); each mechanism reads its stand-in. */
async function runWaiter(machine, waiter, { watched = null, service = null, stop = new AbortController(), most_ms = 8000 } = {}) {
  const timer = setTimeout(() => stop.abort(), most_ms);
  const loadModule = async leaf => {
    if (leaf === 'row-changes.mjs') return { ...rowChanges, watchForTransitions: (settings, handlers) =>
      rowChanges.watchForTransitions(settings, { ...handlers, connection: 'postgresql://made-up-watched', connect: async () => clientOf(watched) }) };
    return { ...serviceLists, watchForTransitions: (settings, handlers) =>
      serviceLists.watchForTransitions(settings, { ...handlers, credential: 'made-up-token', fetch: service.fetch }) };
  };
  machine.carrier.scanUnderPath = async () => ({ entries: [waiter] });
  try {
    await runResidentEmitter({ carrier: machine.carrier, signal: stop.signal, loadModule, connection: 'p_made_up-connection' });
  } finally {
    clearTimeout(timer);
  }
}
const changesIn = book => book.filter(fact => fact.kind === 'something-changed').map(fact => fact.payload.key);
const waitFor = async (check, ms = 8000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('waited too long');
    await new Promise(done => setTimeout(done, 20));
  }
};

test('a row-changes waiter moved to another computer tells every change exactly once across both, the stale kept-folder place on the target passed over', async (t) => {
  const watched = await watchedDatabase(t);
  const places = await placesDatabase(t);
  await addNotes(watched, [1, 2, 3]);
  const mac = await computer('mac', { places });
  // The Mac's first run starts from now: it keeps the newest change as its place and tells nothing before it.
  const first = new AbortController();
  const macRun = runWaiter(mac, ROW_WAITER, { watched, stop: first });
  await waitFor(async () => (await places.query(`SELECT place FROM ${PLACES_TABLE} WHERE kept_as = $1`, [ROW_KEY]).catch(() => ({ rows: [] }))).rows[0]?.place);
  assert.deepEqual(mac.book, [], 'nothing before the first start is told');
  const keys = await addNotes(watched, [4, 5, 6]);
  // The wake moves after the Mac told the second of the three.
  await waitFor(() => changesIn(mac.book).includes(keys[1]));
  first.abort();
  await macRun;
  const later = await addNotes(watched, [7, 8]);
  // The other computer's kept folder holds a place from before: just after the first change, which would tell 2 to 8 again.
  const other = await computer('always-on', { places });
  await folderPlaces(other.keep).write(ROW_KEY, { payload: null, state: { after: { txid: '0', position: '1' } } });
  const second = new AbortController();
  const otherRun = runWaiter(other, ROW_WAITER, { watched, stop: second });
  await waitFor(() => changesIn(other.book).includes(later[1]));
  // A pass after the last change tells nothing more.
  await new Promise(done => setTimeout(done, 1300));
  second.abort();
  await otherRun;
  const told = [...changesIn(mac.book), ...changesIn(other.book)];
  assert.deepEqual([...told].sort(), [...keys, ...later].sort(), `told: ${told.join(', ')}`);
  assert.equal(new Set(told).size, told.length, 'nothing is told twice');
  assert.ok(changesIn(other.book).length > 0 && changesIn(mac.book).length > 0, 'each computer told its own share');
  const [row] = (await places.query(`SELECT place, kept_on, kept_by_run FROM ${PLACES_TABLE} WHERE tool = $1 AND kept_as = $2`, [THIS_TOOL, ROW_KEY])).rows;
  assert.equal(row.kept_on, 'always-on');
  assert.equal(`postgres:${row.place.state.after.txid}:${row.place.state.after.position}`, later[1], 'the place is the last change told');
  assert.deepEqual(JSON.parse(readFileSync(path.join(other.keep, readdirSync(other.keep).find(name => name.endsWith('.json'))), 'utf8')).state,
    { after: { txid: '0', position: '1' } }, 'the kept folder is never written while places_in is named');
});

test('a place in the database wins over the kept folder; a kept key the database has no row for carries the folder place in, once', async (t) => {
  const places = await placesDatabase(t);
  const keep = tempFolder(path.join(tmpdir(), 'noticer-wins-'));
  await folderPlaces(keep).write('waiter:a@where', { payload: null, state: { after: { txid: '5', position: '1' } } });
  await folderPlaces(keep).write('waiter:b@where', { payload: null, state: { after: { txid: '9', position: '2' } } });
  const earlier = await placesFor({ placesIn: PLACES_IN, keep: null, tool: THIS_TOOL, keptOn: 'mac', run: 'mac:run', connect: async () => clientOf(places) });
  await earlier.read('waiter:a@where');
  await earlier.write('waiter:a@where', { payload: null, state: { after: { txid: '40', position: '3' } } });
  const store = await placesFor({ placesIn: PLACES_IN, keep, tool: THIS_TOOL, keptOn: 'always-on', run: 'always-on:run', connect: async () => clientOf(places) });
  assert.deepEqual((await store.read('waiter:a@where')).state, { after: { txid: '40', position: '3' } }, 'the database place, not the stale folder place');
  assert.deepEqual((await store.read('waiter:b@where')).state, { after: { txid: '9', position: '2' } }, 'no row yet: the folder place is carried in');
  const [carried] = (await places.query(`SELECT place, kept_on FROM ${PLACES_TABLE} WHERE kept_as = 'waiter:b@where'`)).rows;
  assert.deepEqual(carried, { place: { payload: null, state: { after: { txid: '9', position: '2' } } }, kept_on: 'always-on' });
  await folderPlaces(keep).write('waiter:b@where', { payload: null, state: { after: { txid: '1', position: '1' } } });
  const next = await placesFor({ placesIn: PLACES_IN, keep, tool: THIS_TOOL, keptOn: 'always-on', run: 'always-on:next', connect: async () => clientOf(places) });
  assert.deepEqual((await next.read('waiter:b@where')).state, { after: { txid: '9', position: '2' } }, 'once in the database, the folder is not read again');
});

test('two runs keeping one place at once: the one that started last holds it, the other is refused, says so, and tells nothing more', async (t) => {
  const places = await placesDatabase(t);
  const mac = await computer('mac', { places });
  const other = await computer('always-on', { places });
  const record = (n) => ({ addressLabel: 'where::something-changed', waiterRef: 'waiter:row-changes', payload: { kind: 'something-changed', key: `p:${n}` }, eventKey: `p:${n}`, state: { after: { txid: String(n), position: '1' } } });
  await mac.carrier.writeRecord(record(1));
  await other.carrier.readCurrent('where::something-changed', 'waiter:row-changes');
  await assert.rejects(mac.carrier.writeRecord(record(2)), (error) => error.placeTaken && /held by run always-on:run on always-on/.test(error.message));
  const refusedLines = () => mac.said.filter(line => line.startsWith('{"place_refused"'));
  assert.equal(refusedLines().length, 1);
  assert.deepEqual(Object.keys(JSON.parse(refusedLines()[0])), ['place_refused', 'held_by', 'kept_on', 'kept_at']);
  assert.equal(JSON.parse(refusedLines()[0]).held_by, 'always-on:run');
  const toldBefore = mac.book.length;
  await assert.rejects(mac.carrier.writeRecord(record(3)), (error) => error.placeTaken);
  await assert.rejects(mac.carrier.keepState('where::something-changed', { after: { txid: '3', position: '1' } }, 'waiter:row-changes'), (error) => error.placeTaken);
  assert.equal(mac.book.length, toldBefore, 'a run whose place was taken tells nothing more');
  assert.equal(refusedLines().length, 1, 'said once');
  await other.carrier.writeRecord(record(4));
  const [row] = (await places.query(`SELECT place, kept_by_run FROM ${PLACES_TABLE} WHERE kept_as = 'waiter:row-changes@where::something-changed'`)).rows;
  assert.deepEqual(row, { place: { payload: record(4).payload, state: record(4).state }, kept_by_run: 'always-on:run' });
});

test('a running row-changes waiter whose place another computer claims ends with that refusal as its fact; the other goes on', async (t) => {
  const watched = await watchedDatabase(t);
  const places = await placesDatabase(t);
  await addNotes(watched, [1]);
  const mac = await computer('mac', { places });
  const macRun = runWaiter(mac, ROW_WAITER, { watched });
  await new Promise(done => setTimeout(done, 300));
  const other = await computer('always-on', { places });
  const stop = new AbortController();
  const otherRun = runWaiter(other, ROW_WAITER, { watched, stop });
  await new Promise(done => setTimeout(done, 300));
  const [both] = await addNotes(watched, [2]);
  await macRun;
  const refusal = mac.book.find(fact => fact.payload.refusal_reason === 'place-kept-elsewhere');
  assert.ok(refusal, JSON.stringify(mac.book));
  assert.match(refusal.payload.refusal_detail, /held by run always-on:run on always-on/);
  assert.ok(changesIn(mac.book).every(key => key === both), 'the Mac told at most the one change it read before its write was refused');
  const [after] = await addNotes(watched, [3]);
  await waitFor(() => changesIn(other.book).includes(after));
  stop.abort();
  await otherRun;
  assert.deepEqual(changesIn(other.book), [both, after]);
  assert.ok(!changesIn(mac.book).includes(after));
});

test('a service-lists waiter moved to another computer tells each thing once, its stale kept-folder fingerprints passed over', async (t) => {
  const places = await placesDatabase(t);
  const booking = id => ({ id, status: 'confirmed', updated_at: `2026-11-25T0${id}:00:00Z` });
  let list = [booking(1), booking(2)];
  const service = { fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: list }) }) };
  const first = new AbortController();
  const mac = await computer('mac', { places, heard: fact => { if (fact.payload.key === '3') first.abort(); } });
  const macRun = runWaiter(mac, SERVICE_WAITER, { service, stop: first });
  // The first read adopts what is there; the next one tells the new booking.
  await new Promise(done => setTimeout(done, 300));
  list = [booking(1), booking(2), booking(3)];
  await macRun;
  list = [booking(1), booking(2), booking(3), booking(4)];
  const second = new AbortController();
  const other = await computer('always-on', { places, heard: fact => { if (fact.payload.key === '4') setTimeout(() => second.abort(), 1300); } });
  // Fingerprints from before: only booking 1 seen, so 2 and 3 would be told again as added.
  const [one] = Object.entries((await places.query(`SELECT place FROM ${PLACES_TABLE} WHERE kept_as = $1`, [SERVICE_KEY])).rows[0].place.state.seen);
  await folderPlaces(other.keep).write(SERVICE_KEY, { payload: null, state: { seen: Object.fromEntries([one]), read_at: 0, print_rule: null, print: null } });
  await runWaiter(other, SERVICE_WAITER, { service, stop: second });
  const told = [...changesIn(mac.book), ...changesIn(other.book)];
  assert.deepEqual(told, ['3', '4'], `told: ${told.join(', ')}`);
});

test('with no places_in, places are kept in the kept folder as before: one file per kept key, its name the key as base64url', async () => {
  const keep = tempFolder(path.join(tmpdir(), 'noticer-folder-'));
  let connected = false;
  const store = await placesFor({ placesIn: null, keep, tool: THIS_TOOL, keptOn: 'mac', run: 'mac:run', connect: async () => { connected = true; } });
  assert.equal(store.kind, 'kept-folder');
  assert.equal(connected, false, 'no database is opened');
  const fetchImpl = async () => new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 });
  const carrier = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'c' }, waiters: [], fetchImpl, say: () => {}, keep });
  await carrier.writeRecord({ addressLabel: 'where::something-changed', waiterRef: 'waiter:row-changes', payload: { kind: 'something-changed' }, eventKey: 'p:1', state: { after: { txid: '1', position: '1' } } });
  const file = `${Buffer.from('waiter:row-changes@where::something-changed').toString('base64url')}.json`;
  assert.deepEqual(readdirSync(keep), [file]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(keep, file), 'utf8')), { payload: { kind: 'something-changed' }, state: { after: { txid: '1', position: '1' } } });
  const restarted = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'c' }, waiters: [], fetchImpl, say: () => {}, keep });
  assert.deepEqual((await restarted.readCurrent('where::something-changed', 'waiter:row-changes')).state, { after: { txid: '1', position: '1' } });
  assert.equal(restarted.placeTaken('waiter:row-changes'), null);
});

test('a place store that cannot be read is a crash: the waiter is started again, never started from now', async (t) => {
  const watched = await watchedDatabase(t);
  await addNotes(watched, [1]);
  const machine = await computer('mac');
  machine.carrier = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'c' }, waiters: [], say: () => {},
    fetchImpl: async (url, { body }) => { machine.book.push(JSON.parse(body).params.arguments.input); return new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 }); },
    places: { kind: 'database', read: async () => { throw Object.assign(new Error('the places in p could not be read or written: proxy 502'), { crash: true }); }, write: async () => {}, taken: () => null, close: async () => {} } });
  await assert.rejects(runWaiter(machine, ROW_WAITER, { watched }), /proxy 502/);
  assert.deepEqual(changesIn(machine.book), []);
});

test('the places table is made once, a table with a trigger of its own is refused, and the row mounts places_in apart from every other credential', async (t) => {
  const places = await placesDatabase(t);
  await placesFor({ placesIn: PLACES_IN, tool: THIS_TOOL, keptOn: 'mac', run: 'a', connect: async () => clientOf(places) });
  await placesFor({ placesIn: PLACES_IN, tool: THIS_TOOL, keptOn: 'mac', run: 'b', connect: async () => clientOf(places) });
  await places.exec(`CREATE FUNCTION told() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER tell_row_change AFTER INSERT OR UPDATE ON ${PLACES_TABLE} FOR EACH ROW EXECUTE FUNCTION told()`);
  await assert.rejects(placesFor({ placesIn: PLACES_IN, tool: THIS_TOOL, keptOn: 'mac', run: 'c', connect: async () => clientOf(places) }), /has a trigger of its own/);
  const mounts = ROW.invoke.credential_mounts;
  assert.deepEqual(mounts.find(item => item.secret_name_from_input === 'places_in'), { secret_name_from_input: 'places_in', fd: PLACES_FD, only_when: { input: 'places_in', present: true } });
  assert.ok(PLACES_FD > EACH_WAITER_FD && PLACES_FD <= 63, 'the last descriptor a process is handed, past every waiter of a usual list');
  assert.equal(ROW.input_schema.properties.places_in.type, 'string');
  const file = path.join(tempFolder(path.join(tmpdir(), 'noticer-fd-')), 'connection');
  writeFileSync(file, 'postgresql://made-up-places\n');
  const fd = openSync(file, 'r');
  t.after(() => closeSync(fd));
  assert.equal(placesConnection(PLACES_IN, fd), 'postgresql://made-up-places', 'the run reads the connection off the descriptor it was given');
  assert.throws(() => placesConnection(PLACES_IN, 1000), /places_in names p_made_up_places-connection, but this run holds no connection on descriptor 1000/);
});
