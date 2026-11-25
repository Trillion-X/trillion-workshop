// tools/notice-when-something-shows-up/tests/kept-places-per-copy.test.mjs
//
// Each wake keeps its own places (do-work/kept-places.mjs `keptKeyOf`): the copies of one wake run one waiter, each over
// its own database, so their places are kept under keys that name the wake. Nov 25 2026, 3:07 AM CST: the key was the
// waiter and its address alone, the same for keep-noticing-row-changes and its copy for each pursuit database; on one
// computer they kept one place in the kept folder, with places_in two copies naming one database
// refused each other, and four databases were each given the same carried-in place.
//
// One "computer" here is one kept folder; each copy is its own run on it (its own carrier and wake book). The two
// watched sources are two change tables in one PGlite database, so their transactions are counted by one server, as
// every pursuit database's are on one Postgres server: a place kept from one is a point in the other's order too.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import * as rowChanges from '../do-work/mechanisms/row-changes.mjs';
import { engineCarrier, flagOf, keptFolderOf, wakeOf } from '../do-work/tell-the-engine.mjs';
import { runResidentEmitter, THIS_TOOL } from '../do-work/emit-arrival-fact.mjs';
import { folderPlaces, keptKeyOf, placesFor, PLACES_TABLE } from '../do-work/kept-places.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records;
const ROW = ROWS[0].payload;
/** The row's own row-changes waiter, reading its source's change table (`table`) again every second. */
const waiterOver = table => {
  const waiter = ROW.wakes.find(wake => wake.id === 'keep-noticing-row-changes').input.waiters[0];
  return { ...waiter, mechanism_settings: { ...waiter.mechanism_settings, table, look_again_seconds: 1 } };
};
const WAITER = waiterOver('row_changes');
const SHARED_KEY = `${WAITER.id}@${WAITER.emitted_record.address_label}`;
const NOTES_COPY = 'keep-noticing-row-changes/notes';
const TASKS_COPY = 'keep-noticing-row-changes/tasks';
const PLACES_IN = 'p_made_up_places-connection';

const clientOf = db => ({ query: (sql, params) => db.query(sql, params), end: async () => {} });

/** One server with two watched sources: notes tells its changes into row_changes (the change stack every pursuit
 *  database has), tasks into tasks_changes (a change table of the same shape with its own trigger function). */
async function server(t) {
  const db = new PGlite();
  t.after(() => db.close());
  const stack = readFileSync(new URL('../../workflows/sql/consent-stack.sql', import.meta.url), 'utf8').split('-- Consent stack')[0];
  await db.exec(stack);
  await db.exec(`CREATE TABLE notes (id int PRIMARY KEY);
    CREATE TRIGGER tell_row_change AFTER INSERT OR DELETE OR UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION record_row_change();
    CREATE SEQUENCE tasks_changes_position_seq;
    CREATE TABLE tasks_changes (LIKE row_changes INCLUDING DEFAULTS);
    ALTER TABLE tasks_changes ALTER COLUMN position SET DEFAULT nextval('tasks_changes_position_seq');
    CREATE FUNCTION record_task_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO tasks_changes (table_name, op, after) VALUES (TG_TABLE_NAME, TG_OP, to_jsonb(NEW)); RETURN NULL; END $$;
    CREATE TABLE tasks (id int PRIMARY KEY);
    CREATE TRIGGER tell_row_change AFTER INSERT OR DELETE OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION record_task_change();`);
  return db;
}
/** Adds rows to `table` of `db`, each in its own transaction; answers each change's own key (<database>:<txid>:<position>). */
async function add(db, table, ids) {
  const changes = table === 'notes' ? 'row_changes' : 'tasks_changes';
  const keys = [];
  for (const id of ids) {
    await db.query(`INSERT INTO ${table} VALUES ($1)`, [id]);
    const [change] = (await db.query(`SELECT current_database() || ':' || txid::text || ':' || position::text AS key FROM ${changes} ORDER BY position DESC LIMIT 1`)).rows;
    keys.push(change.key);
  }
  return keys;
}

/** One run of the wake `wake` (null: a run no wake started) on the computer whose kept folder is `keep`, its places in
 *  `places` (places_in's database) when given, else in `keep`. */
async function runOf(wake, { keep, places = null }) {
  const book = [];
  const said = [];
  const fetchImpl = async (url, { body }) => {
    book.push(JSON.parse(body).params.arguments.input);
    return new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 });
  };
  const store = await placesFor({ placesIn: places ? PLACES_IN : null, keep, tool: THIS_TOOL, keptOn: 'mac', run: `mac:${wake}:${Math.random()}`,
    connection: 'postgresql://made-up-places', connect: async () => clientOf(places) });
  const carrier = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'c' }, waiters: [], fetchImpl, say: line => said.push(line), keep, places: store, wake });
  return { wake, book, said, carrier };
}

/** Runs `waiter` in `run` over `watched` until `stop` aborts it (or `most_ms` passes). */
async function watch(run, waiter, watched, stop, most_ms = 10000) {
  const timer = setTimeout(() => stop.abort(), most_ms);
  const loadModule = async () => ({ ...rowChanges, watchForTransitions: (settings, handlers) =>
    rowChanges.watchForTransitions(settings, { ...handlers, connection: 'postgresql://made-up-watched', connect: async () => clientOf(watched) }) });
  run.carrier.scanUnderPath = async () => ({ entries: [waiter] });
  try {
    await runResidentEmitter({ carrier: run.carrier, signal: stop.signal, loadModule, connection: 'p_made_up-connection' });
  } finally {
    clearTimeout(timer);
  }
}
const changesIn = book => book.filter(fact => fact.kind === 'something-changed').map(fact => fact.payload.key);
const waitFor = async (check, ms = 10000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('waited too long');
    await new Promise(done => setTimeout(done, 20));
  }
};
const placeOf = async (places, keptAs) => (await places.query(`SELECT place, version::text AS version FROM ${PLACES_TABLE} WHERE tool = $1 AND kept_as = $2`,
  [THIS_TOOL, keptAs]).catch(() => ({ rows: [] }))).rows[0] ?? null;
const keyOfPlace = place => `postgres:${place.state.after.txid}:${place.state.after.position}`;
const refusals = run => [...run.said.filter(line => line.startsWith('{"place_refused"')), ...run.book.filter(fact => fact.payload.refusal_reason)];

/** Both copies watch at once, the notes copy over notes and the tasks copy over tasks; `stop(until)` waits for `until`, then a
 *  quiet pass, then stops both. */
function bothWatch({ db, notesCopy, tasksCopy, quietMs = 1300 }) {
  const stops = [new AbortController(), new AbortController()];
  const runs = [watch(notesCopy, waiterOver('row_changes'), db, stops[0]), watch(tasksCopy, waiterOver('tasks_changes'), db, stops[1])];
  return { stop: async (until) => {
    await waitFor(until);
    await new Promise(done => setTimeout(done, quietMs));
    stops.forEach(stop => stop.abort());
    await Promise.all(runs);
  } };
}
const started = () => new Promise(done => setTimeout(done, 400));

test('the kept key names the wake that started the run, and the row gives the run that id from its task', () => {
  assert.deepEqual(keptKeyOf({ wake: NOTES_COPY, waiterRef: 'waiter:row-changes', addressLabel: 'where::something-changed' }),
    { as: 'keep-noticing-row-changes/notes|waiter:row-changes@where::something-changed', carriedFrom: 'waiter:row-changes@where::something-changed' });
  assert.deepEqual(keptKeyOf({ wake: null, waiterRef: 'waiter:row-changes', addressLabel: 'where::something-changed' }),
    { as: 'waiter:row-changes@where::something-changed', carriedFrom: null }, 'a run no wake started keeps under the key without one');
  assert.deepEqual(keptKeyOf({ wake: 'keep-noticing', addressLabel: 'clock::due' }), { as: 'keep-noticing|clock::due', carriedFrom: 'clock::due' });
  const programs = ROWS.filter(row => row.payload.invoke?.argv?.includes('do-work/tell-the-engine.mjs'));
  assert.ok(programs.length >= 2);
  for (const record of programs) {
    const { argv } = record.payload.invoke;
    assert.deepEqual(argv.slice(argv.indexOf('--wake')), ['--wake', { fill: { from: 'task', field: 'cause.wake' } }], record.id);
  }
  assert.equal(wakeOf(['--keep', '/k', '--wake', NOTES_COPY]), NOTES_COPY);
  assert.equal(wakeOf(['--keep', '/k', '--wake']), null, 'a task with no cause.wake leaves the word out');
  assert.equal(keptFolderOf(['--keep', '--wake', NOTES_COPY]), null, 'a flag is never taken for the word after another flag');
  assert.equal(flagOf('--keep', ['--keep', '/k']), '/k');
});

test('two copies of one wake on one computer, both naming one places database, keep two places, never refuse each other, and each tells every change of its own source once', async (t) => {
  const db = await server(t);
  const places = new PGlite();
  t.after(() => places.close());
  const keep = tempFolder(path.join(tmpdir(), 'noticer-copies-'));
  const notesCopy = await runOf(NOTES_COPY, { keep, places });
  const tasksCopy = await runOf(TASKS_COPY, { keep, places });
  const both = bothWatch({ db, notesCopy, tasksCopy });
  await started();
  // The two sources change in turns, so each copy's place passes over the other's transactions.
  const notes = [];
  const tasks = [];
  notes.push(...await add(db, 'notes', [1]));
  tasks.push(...await add(db, 'tasks', [10]));
  notes.push(...await add(db, 'notes', [2, 3]));
  tasks.push(...await add(db, 'tasks', [11]));
  await both.stop(() => changesIn(notesCopy.book).length >= 3 && changesIn(tasksCopy.book).length >= 2);
  assert.deepEqual(changesIn(notesCopy.book), notes, 'the notes copy tells each change of its source once, in order');
  assert.deepEqual(changesIn(tasksCopy.book), tasks, 'the tasks copy tells each change of its source once, in order');
  assert.deepEqual([...refusals(notesCopy), ...refusals(tasksCopy)], [], 'neither copy refuses the other');
  const rows = (await places.query(`SELECT kept_as, place FROM ${PLACES_TABLE} ORDER BY kept_as`)).rows;
  assert.deepEqual(rows.map(row => row.kept_as), [`${NOTES_COPY}|${SHARED_KEY}`, `${TASKS_COPY}|${SHARED_KEY}`]);
  assert.equal(keyOfPlace(rows[0].place), notes.at(-1));
  assert.equal(keyOfPlace(rows[1].place), tasks.at(-1));
  assert.deepEqual(readdirSync(keep).filter(name => name.endsWith('.json')), [], 'no place is kept in the kept folder while places_in is named');
  assert.deepEqual(readdirSync(path.join(keep, 'waiter-folders')).sort(),
    [`${NOTES_COPY}|${WAITER.id}`, `${TASKS_COPY}|${WAITER.id}`].map(key => Buffer.from(key).toString('base64url')).sort(), 'each copy has a waiter folder of its own');
});

test('a waiter folder is the wake\'s own; its first ask starts from a copy of the folder every copy shared, which is left as it was', () => {
  const keep = tempFolder(path.join(tmpdir(), 'noticer-waiter-folders-'));
  const carrierOf = wake => engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'c' }, waiters: [], say: () => {}, keep, wake });
  const sharedFolder = carrierOf(null).folderFor('waiter:linked-device');
  assert.equal(sharedFolder, path.join(keep, 'waiter-folders', Buffer.from('waiter:linked-device').toString('base64url')), 'a run no wake started: as before');
  writeFileSync(path.join(sharedFolder, 'session.json'), '{"device":"one"}');
  const notesFolder = carrierOf(NOTES_COPY).folderFor('waiter:linked-device');
  assert.equal(path.basename(notesFolder), Buffer.from(`${NOTES_COPY}|waiter:linked-device`).toString('base64url'));
  assert.equal(readFileSync(path.join(notesFolder, 'session.json'), 'utf8'), '{"device":"one"}', 'carried over from the shared folder');
  writeFileSync(path.join(notesFolder, 'session.json'), '{"device":"notes"}');
  assert.equal(readFileSync(path.join(carrierOf(NOTES_COPY).folderFor('waiter:linked-device'), 'session.json'), 'utf8'), '{"device":"notes"}', 'carried once: its own folder after that');
  assert.equal(readFileSync(path.join(carrierOf(TASKS_COPY).folderFor('waiter:linked-device'), 'session.json'), 'utf8'), '{"device":"one"}', 'another copy starts from the shared folder too');
  assert.equal(readFileSync(path.join(sharedFolder, 'session.json'), 'utf8'), '{"device":"one"}', 'the shared folder is left as it was');
  assert.deepEqual(readdirSync(path.join(keep, 'waiter-folders')).filter(name => name.endsWith('.new')), [], 'no half-copied folder is left');
});

test('with no places_in, two copies on one computer keep one file each in the one kept folder', async (t) => {
  const db = await server(t);
  const keep = tempFolder(path.join(tmpdir(), 'noticer-copies-folder-'));
  const notesCopy = await runOf(NOTES_COPY, { keep });
  const tasksCopy = await runOf(TASKS_COPY, { keep });
  const both = bothWatch({ db, notesCopy, tasksCopy });
  await started();
  const notes = await add(db, 'notes', [1, 2]);
  const tasks = await add(db, 'tasks', [10, 11, 12]);
  await both.stop(() => changesIn(notesCopy.book).length >= 2 && changesIn(tasksCopy.book).length >= 3);
  assert.deepEqual(changesIn(notesCopy.book), notes);
  assert.deepEqual(changesIn(tasksCopy.book), tasks);
  const folder = folderPlaces(keep);
  assert.equal(readdirSync(keep).filter(name => name.endsWith('.json')).length, 2);
  assert.equal(keyOfPlace(await folder.read(`${NOTES_COPY}|${SHARED_KEY}`)), notes.at(-1));
  assert.equal(keyOfPlace(await folder.read(`${TASKS_COPY}|${SHARED_KEY}`)), tasks.at(-1));
});

for (const store of ['places_in', 'kept folder']) {
  test(`copies that find only the shared key carry over from it once (${store}): nothing told twice, nothing passed over, the shared place never moved`, async (t) => {
    const db = await server(t);
    const places = store === 'places_in' ? new PGlite() : null;
    if (places) t.after(() => places.close());
    const keep = tempFolder(path.join(tmpdir(), 'noticer-carry-'));
    // Before: the waiter ran under the key without a wake, which every copy shared. Its run starts from now, tells notes
    // 1 and 2, and leaves the shared place at note 2. The task made before that place was the past, never told again.
    await add(db, 'notes', [0]);
    await add(db, 'tasks', [9]);
    const before = await runOf(null, { keep, places });
    const firstStop = new AbortController();
    const firstRun = watch(before, waiterOver('row_changes'), db, firstStop);
    await started();
    const told = await add(db, 'notes', [1, 2]);
    await waitFor(() => changesIn(before.book).length >= 2);
    firstStop.abort();
    await firstRun;
    assert.deepEqual(changesIn(before.book), told);
    const shared = places ? await placeOf(places, SHARED_KEY) : { place: await folderPlaces(keep).read(SHARED_KEY) };
    assert.equal(keyOfPlace(shared.place), told[1]);
    // While nothing runs, each source changes: these come after the shared place and must each be told once.
    const notesWhileDown = await add(db, 'notes', [3]);
    const tasksWhileDown = await add(db, 'tasks', [20, 21]);
    // The copies start, each with no key of its own: each carries over from the shared place.
    const notesCopy = await runOf(NOTES_COPY, { keep, places });
    const tasksCopy = await runOf(TASKS_COPY, { keep, places });
    const first = bothWatch({ db, notesCopy, tasksCopy });
    await started();
    const notesLater = await add(db, 'notes', [4]);
    const tasksLater = await add(db, 'tasks', [22]);
    await first.stop(() => changesIn(notesCopy.book).length >= 2 && changesIn(tasksCopy.book).length >= 3);
    assert.deepEqual(changesIn(notesCopy.book), [...notesWhileDown, ...notesLater], 'notes: after the shared place, nothing twice, nothing passed over');
    assert.deepEqual(changesIn(tasksCopy.book), [...tasksWhileDown, ...tasksLater], 'tasks: every task after the shared place, none before it');
    assert.deepEqual([...refusals(notesCopy), ...refusals(tasksCopy)], []);
    // Started again, each goes on from its own place: the shared place is not carried over a second time.
    const notesAfter = await add(db, 'notes', [5]);
    const notesAgain = await runOf(NOTES_COPY, { keep, places });
    const tasksAgain = await runOf(TASKS_COPY, { keep, places });
    const second = bothWatch({ db, notesCopy: notesAgain, tasksCopy: tasksAgain });
    await started();
    const tasksAfter = await add(db, 'tasks', [23]);
    await second.stop(() => changesIn(notesAgain.book).length >= 1 && changesIn(tasksAgain.book).length >= 1);
    assert.deepEqual(changesIn(notesAgain.book), notesAfter);
    assert.deepEqual(changesIn(tasksAgain.book), tasksAfter);
    if (places) {
      assert.deepEqual(await placeOf(places, SHARED_KEY), shared, 'no copy claims, moves or removes the shared row');
      assert.deepEqual((await places.query(`SELECT kept_as FROM ${PLACES_TABLE} ORDER BY kept_as`)).rows.map(row => row.kept_as),
        [`${NOTES_COPY}|${SHARED_KEY}`, `${TASKS_COPY}|${SHARED_KEY}`, SHARED_KEY]);
    } else {
      assert.deepEqual(await folderPlaces(keep).read(SHARED_KEY), shared.place, 'no copy writes or removes the shared file');
      assert.equal(readdirSync(keep).filter(name => name.endsWith('.json')).length, 3);
    }
  });
}

test('a database store carries over in order: the wake\'s own row, the shared row, the folder\'s own file, the folder\'s shared file', async (t) => {
  const places = new PGlite();
  t.after(() => places.close());
  const keep = tempFolder(path.join(tmpdir(), 'noticer-order-'));
  const at = txid => ({ payload: null, state: { after: { txid: String(txid), position: '1' } } });
  const folder = folderPlaces(keep);
  await folder.write(SHARED_KEY, at(1));
  const store = () => placesFor({ placesIn: PLACES_IN, keep, tool: THIS_TOOL, keptOn: 'mac', run: `mac:${Math.random()}`, connect: async () => clientOf(places) });
  const key = wake => keptKeyOf({ wake, waiterRef: WAITER.id, addressLabel: WAITER.emitted_record.address_label });
  const read = async wake => (await (await store()).read(key(wake).as, key(wake).carriedFrom)).state.after.txid;
  assert.equal(await read('a'), '1', 'only the folder\'s shared file: carried in');
  await folder.write(key('b').as, at(2));
  assert.equal(await read('b'), '2', 'the folder\'s own file wins over its shared file');
  const plain = await store();
  await plain.read(SHARED_KEY);
  await plain.write(SHARED_KEY, at(3));
  await folder.write(key('c').as, at(4));
  assert.equal(await read('c'), '3', 'the shared row in the database wins over the folder');
  const ownRow = await store();
  await ownRow.read(key('c').as, key('c').carriedFrom);
  await ownRow.write(key('c').as, at(5));
  assert.equal(await read('c'), '5', 'the wake\'s own row wins over all');
  assert.equal(await read('a'), '1', 'once carried, the wake\'s own row is read');
  await plain.write(SHARED_KEY, at(6));
  assert.equal(await read('a'), '1', 'a shared place that moves later is not carried over a second time');
  assert.equal(await folder.read(key('a').as), null, 'the kept folder is not written while places_in is named');
});
