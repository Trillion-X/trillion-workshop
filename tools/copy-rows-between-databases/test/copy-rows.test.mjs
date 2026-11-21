import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { copyRows, sayWithout, shapeOf } from '../do-work/copy-rows.mjs';

// A real PostgreSQL server in a temp folder with two databases: the account's source and a client's destination.
const PORT = 55000 + (process.pid % 900);
const ADMIN = { host: '127.0.0.1', port: PORT, user: 'postgres', password: 'made-up-admin-pw' };
const connectionTo = database => `postgres://postgres:made-up-admin-pw@127.0.0.1:${PORT}/${database}`;
const SOURCE = connectionTo('p_source');
const DESTINATION = connectionTo('p_destination');
const COMMAND = fileURLToPath(new URL('../do-work/copy-rows.mjs', import.meta.url));
let server;

const run = async (connection, text, values = []) => {
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  try { return (await client.query(text, values)).rows; } finally { await client.end(); }
};
const TABLE = 'CREATE TABLE rows (recipe text PRIMARY KEY, title text, definition jsonb, kept_at timestamptz NOT NULL DEFAULT now())';
const input = (keys, more = {}) => ({ table: 'rows', key_column: 'recipe', keys, ...more });
const copy = (keys, more) => copyRows({ source: SOURCE, destination: DESTINATION, input: input(keys, more) });

before(async () => {
  server = new EmbeddedPostgres({ databaseDir: tempFolder(join(tmpdir(), 'copy-rows-')), user: ADMIN.user, password: ADMIN.password, port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  const admin = new pg.Client({ ...ADMIN, database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE DATABASE p_source');
  await admin.query('CREATE DATABASE p_destination');
  await admin.end();
  await run(SOURCE, TABLE);
  await run(DESTINATION, TABLE);
  await run(SOURCE, "INSERT INTO rows (recipe, title, definition, kept_at) VALUES ('a', 'Alpha', '{\"n\":1}', '2026-01-01'), ('b', 'Beta', '{\"n\":2}', '2026-01-01')");
});

after(async () => { await server.stop(); });

test('copies named rows and answers only counts and versions', async () => {
  const answer = await copy(['a', 'b']);
  assert.deepEqual([answer.copied, answer.updated, answer.kept, answer.missing], [2, 0, 0, 0]);
  const [{ n }] = await run(DESTINATION, 'SELECT count(*)::int AS n FROM rows');
  assert.equal(n, 2);
  for (const each of answer.keys) {
    assert.equal(each.result, 'copied');
    assert.equal(each.source_version, each.destination_version);
    assert.match(each.source_version, /^[0-9a-f]{32}$/);
  }
  assert.ok(!JSON.stringify(answer).includes('Alpha'), 'no row body is in the answer');
});

test('a rerun copies nothing and keeps what is there', async () => {
  const answer = await copy(['a', 'b']);
  assert.deepEqual([answer.copied, answer.updated, answer.kept], [0, 0, 2]);
});

test('do_nothing keeps the destination row when the source changed; update_when_newer takes only a newer one', async () => {
  await run(SOURCE, "UPDATE rows SET title = 'Alpha two', kept_at = '2026-02-01' WHERE recipe = 'a'");
  const kept = await copy(['a']);
  assert.equal(kept.keys[0].result, 'kept');
  assert.notEqual(kept.keys[0].source_version, kept.keys[0].destination_version);
  const updated = await copy(['a'], { on_conflict: 'update_when_newer', version_column: 'kept_at' });
  assert.equal(updated.keys[0].result, 'updated');
  assert.equal(updated.keys[0].source_version, updated.keys[0].destination_version);
  assert.deepEqual(await run(DESTINATION, "SELECT title FROM rows WHERE recipe = 'a'"), [{ title: 'Alpha two' }]);
  // The destination is now newer than the source for b: the source's older row does not replace it.
  await run(DESTINATION, "UPDATE rows SET title = 'Beta mine', kept_at = '2026-03-01' WHERE recipe = 'b'");
  const older = await copy(['b'], { on_conflict: 'update_when_newer', version_column: 'kept_at' });
  assert.equal(older.keys[0].result, 'kept');
  assert.deepEqual(await run(DESTINATION, "SELECT title FROM rows WHERE recipe = 'b'"), [{ title: 'Beta mine' }]);
});

test('a key the source does not have is answered as missing and nothing is written for it', async () => {
  const answer = await copy(['nope', 'a', 'nope']);
  assert.deepEqual([answer.missing, answer.keys.length], [1, 2]);
  assert.deepEqual(answer.keys.find(each => each.key === 'nope'), { key: 'nope', result: 'missing', source_version: null, destination_version: null });
  assert.deepEqual(await run(DESTINATION, "SELECT recipe FROM rows WHERE recipe = 'nope'"), []);
});

test('a row of one megabyte is copied whole and the answer stays small', async () => {
  const big = 'x'.repeat(1024 * 1024);
  await run(SOURCE, "INSERT INTO rows (recipe, title, definition) VALUES ('big', 'Big', jsonb_build_object('body', $1::text))", [big]);
  const answer = await copy(['big']);
  assert.equal(answer.copied, 1);
  assert.ok(JSON.stringify(answer).length < 1000);
  assert.deepEqual(await run(DESTINATION, "SELECT length(definition ->> 'body') AS n FROM rows WHERE recipe = 'big'"), [{ n: 1024 * 1024 }]);
  assert.equal(answer.keys[0].source_version, answer.keys[0].destination_version);
});

test('all keys are written in one transaction: a failure leaves none of them', async () => {
  await run(SOURCE, "INSERT INTO rows (recipe, title) VALUES ('c', 'Gamma')");
  await run(DESTINATION, 'ALTER TABLE rows ADD CONSTRAINT no_d CHECK (recipe <> $$d$$)');
  await run(SOURCE, "INSERT INTO rows (recipe, title) VALUES ('d', 'Delta')");
  await assert.rejects(copy(['c', 'd']), /no_d/);
  assert.deepEqual(await run(DESTINATION, "SELECT recipe FROM rows WHERE recipe IN ('c', 'd')"), []);
});

test('a request that is not one is refused with its reason', () => {
  assert.throws(() => shapeOf({ ...input(['a']), table: 'rows; DROP TABLE rows' }), /table must be a plain name/);
  assert.throws(() => shapeOf({ ...input(['a']), key_column: 'a b' }), /key_column/);
  assert.throws(() => shapeOf(input('a')), /keys must be a list/);
  assert.throws(() => shapeOf(input(['a'], { on_conflict: 'replace' })), /on_conflict must be one of/);
  assert.throws(() => shapeOf(input(['a'], { on_conflict: 'update_when_newer' })), /needs version_column/);
  assert.throws(() => shapeOf(input(['a'], { version_column: 'kept_at' })), /version_column is for/);
  assert.throws(() => shapeOf(input(Array.from({ length: 1001 }, (_, i) => String(i)))), /at most 1000/);
});

test('no connection handed is refused before any is opened', async () => {
  await assert.rejects(copyRows({ source: '', destination: DESTINATION, input: input(['a']) }), /No source connection/);
  await assert.rejects(copyRows({ source: SOURCE, destination: '', input: input(['a']) }), /No destination connection/);
});

test('a failure text holds neither connection string nor password', () => {
  const said = sayWithout(new Error(`could not reach ${SOURCE} or ${DESTINATION} with made-up-admin-pw`), SOURCE, DESTINATION);
  assert.ok(!said.includes('made-up-admin-pw') && !said.includes('postgres://'));
});

test('the command reads both connections on descriptors 3 and 4 and prints the answer as the engine runs it', async () => {
  const folder = tempFolder(join(tmpdir(), 'copy-rows-fds-'));
  writeFileSync(join(folder, 'source'), SOURCE);
  writeFileSync(join(folder, 'destination'), DESTINATION);
  const [three, four] = [openSync(join(folder, 'source'), 'r'), openSync(join(folder, 'destination'), 'r')];
  const child = spawn(process.execPath, [COMMAND], { stdio: ['pipe', 'pipe', 'pipe', three, four] });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdin.end(JSON.stringify(input(['a', 'c'])));
  const code = await new Promise(resolve => child.on('close', resolve));
  closeSync(three); closeSync(four);
  assert.equal(code, 0, err);
  const answer = JSON.parse(out);
  assert.deepEqual([answer.copied, answer.kept], [1, 1]);
  assert.ok(!out.includes('postgres://'));
});
