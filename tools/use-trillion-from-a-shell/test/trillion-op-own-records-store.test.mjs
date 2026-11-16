// tools/use-trillion-from-a-shell/test/trillion-op-own-records-store.test.mjs
//
// `trillion op @own-records records:read | records:list | records:write` is answered by the person's own SQLite file
// (trillion.json own_records_store), no door asked, with the door's shapes (read {id, type, value}, list {records, next}, write {accepted}).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import settings from '../do-work/trillion.json' with { type: 'json' };
import { main, ownRecordsFile, stateOf, TrillionError } from '../do-work/trillion.mjs';

const KEY = `nm_${'ab'.repeat(16)}`;
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };

/** A file shaped like the person's: tables per row type (w_ for a bare type), id, a few columns and extra; a list row naming a row type. */
const fileWith = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'own-records-store-')), 'rows.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    create table lesson_learned(id text, "note.title", "note.tier", "document.text", extra text);
    create table w_ai_job(id text, status, job, extra text);
    create table w_list(id text, row_type, extra text);
    create index ix_lesson_learned_id on lesson_learned(id);
    insert into lesson_learned values ('record:lesson-learned:a', 'Alpha', 1, 'text a', null), ('record:lesson-learned:b', 'Beta', 2, 'text b', '{"flag":true,"tags":["x"]}'), ('record:lesson-learned:c', 'Gamma', 2, 'text c', null);
    insert into w_ai_job values ('ai-job:1', 'waiting', 'do it', null), ('ai-job:2', 'done', 'did it', '{"result":"fine"}');
    insert into w_list values ('list:lessons-learned', 'lesson-learned', null);
  `);
  db.close();
  return file;
};

/** `trillion op ...` against `file`; any request to a door fails the test. */
const run = async (argv, { file = fileWith() } = {}) => {
  const result = await main(argv, {
    env: { TRILLION_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: mkdtempSync(join(tmpdir(), 'own-records-store-state-')) }),
    ownRecordsFile: () => file,
    fetchImpl: async () => { throw new Error('a door was asked'); },
    wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
  });
  return { result, file };
};
const op = (method, input) => ['op', '@own-records', method, JSON.stringify(input)];
const json = async promise => JSON.parse((await promise).result);

test('read, list and write are answered from the file', async () => {
  const file = fileWith();
  const read = await run(op('records:read', { id: 'record:lesson-learned:b' }), { file });
  assert.deepEqual(JSON.parse(read.result), { id: 'record:lesson-learned:b', type: 'record:lesson-learned', value: { 'note.title': 'Beta', 'note.tier': 2, 'document.text': 'text b', flag: true, tags: ['x'] } });
  const wrote = await json(run(op('records:write', { records: [{ id: 'ai-job:3', type: 'record:ai-job', value: { status: 'waiting', job: 'new', note: { a: 1 } } }] }), { file }));
  assert.deepEqual(wrote, { accepted: true, pending: false, records: [{ id: 'ai-job:3', type: 'record:ai-job' }] });
  const back = await json(run(op('records:read', { id: 'ai-job:3' }), { file }));
  assert.deepEqual(back.value, { status: 'waiting', job: 'new', note: { a: 1 } });
  assert.equal(back.type, 'ai-job');
});

test('a list is a type, a list name or a bare type, paged by id, narrowed by where, prefix and fields', async () => {
  const file = fileWith();
  const first = await json(run(op('records:list', { type: 'record:lesson-learned', limit: 2 }), { file }));
  assert.deepEqual(first.records.map(row => row.id), ['record:lesson-learned:a', 'record:lesson-learned:b']);
  assert.equal(first.next, 'record:lesson-learned:b');
  const second = await json(run(op('records:list', { type: 'record:lesson-learned', limit: 2, after: first.next }), { file }));
  assert.deepEqual(second.records.map(row => row.id), ['record:lesson-learned:c']);
  assert.equal(second.next, null);
  const named = await json(run(op('records:list', { type: 'lessons-learned', where: { 'note.tier': 2 }, fields: ['note.title'] }), { file }));
  assert.deepEqual(named.records.map(row => [row.type, row.value]), [['record:lesson-learned', { 'note.title': 'Beta' }], ['record:lesson-learned', { 'note.title': 'Gamma' }]]);
  const jobs = await json(run(op('records:list', { type: 'ai-job', where: { status: 'done' } }), { file }));
  assert.deepEqual(jobs.records.map(row => [row.id, row.value.result]), [['ai-job:2', 'fine']]);
  const flagged = await json(run(op('records:list', { type: 'record:lesson-learned', where: { flag: true } }), { file }));
  assert.deepEqual(flagged.records.map(row => row.id), ['record:lesson-learned:b']);
  const prefixed = await json(run(op('records:list', { type: 'record:lesson-learned', prefix: 'record:lesson-learned:c', reverse: true }), { file }));
  assert.deepEqual(prefixed.records.map(row => row.id), ['record:lesson-learned:c']);
  assert.deepEqual(await json(run(op('records:list', { type: 'record:nothing-here' }), { file })), { records: [], next: null });
});

test('a write replaces the row, removes it with a null value, and an expected value that moved refuses it all', async () => {
  const file = fileWith();
  await run(op('records:write', { records: [{ id: 'record:lesson-learned:a', type: 'record:lesson-learned', value: { 'note.title': 'Alpha two' } }] }), { file });
  assert.deepEqual((await json(run(op('records:read', { id: 'record:lesson-learned:a' }), { file }))).value, { 'note.title': 'Alpha two' });
  const stale = run(op('records:write', { records: [
    { id: 'record:lesson-learned:c', type: 'record:lesson-learned', value: null },
    { id: 'record:lesson-learned:a', type: 'record:lesson-learned', value: { 'note.title': 'x' }, expected: { type: 'record:lesson-learned', value: { 'note.title': 'Alpha' } } }] }), { file });
  await assert.rejects(stale, error => error instanceof TrillionError && error.code === 'records_expected_changed');
  assert.equal((await json(run(op('records:read', { id: 'record:lesson-learned:c' }), { file }))).value['note.title'], 'Gamma', 'the removal in the same write was rolled back');
  await run(op('records:write', { records: [{ id: 'record:lesson-learned:c', type: 'record:lesson-learned', value: null }] }), { file });
  assert.equal((await json(run(op('records:read', { id: 'record:lesson-learned:c' }), { file }))).value, null);
  await run(op('records:write', { records: [{ id: 'record:brand-new:1', type: 'record:brand-new', value: { word: 'one' } }] }), { file });
  assert.deepEqual((await json(run(op('records:list', { type: 'record:brand-new' }), { file }))).records.map(row => row.value), [{ word: 'one' }]);
});

test('a file that will not open says so, and --dry-run on a write shows the row it would change and writes nothing', async () => {
  const missing = await run(op('records:read', { id: 'ai-job:1' }), { file: join(tmpdir(), 'no-such-folder-for-rows', 'x.sqlite') }).catch(error => error);
  assert.match(missing.message, /could not be opened/);
  const file = fileWith();
  const shown = await json(run([...op('records:write', { records: [{ id: 'ai-job:1', type: 'ai-job', value: { status: 'done', job: 'do it' } }] }), '--dry-run'], { file }));
  assert.equal(shown.dry_run, true);
  assert.equal(shown.rows[0].action, 'replaces this row');
  assert.deepEqual(shown.rows[0].diff.map(row => row.field), ['status']);
  assert.equal((await json(run(op('records:read', { id: 'ai-job:1' }), { file }))).value.status, 'waiting');
});

test('the person\'s own rows file is the one .sqlite file in their data folder, and no other count is guessed at', () => {
  const home = mkdtempSync(join(tmpdir(), 'own-records-home-'));
  const folder = join(home, '.trillion', 'my-data');
  mkdirSync(folder, { recursive: true });
  assert.throws(() => ownRecordsFile({ home }), /holds 0/);
  writeFileSync(join(folder, 'rows.sqlite'), '');
  writeFileSync(join(folder, 'README.md'), '');
  assert.equal(ownRecordsFile({ home }), join(folder, 'rows.sqlite'));
  writeFileSync(join(folder, 'more.sqlite'), '');
  assert.throws(() => ownRecordsFile({ home }), /holds 2/);
});

test('with --json a refusal is {code, message} on the error line, so a program reads the code and not the words', async () => {
  const door = createServer((request, response) => {
    request.resume().on('end', () => response.setHeader('content-type', 'application/json').end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, structuredContent: { code: 'records_invalid', error: { message: 'refused' } }, content: [] } })));
  });
  await new Promise(done => door.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${door.address().port}`;
  const program = fileURLToPath(new URL('../do-work/trillion.mjs', import.meta.url));
  const ran = await new Promise(done => {
    const child = spawn(process.execPath, [program, 'op', '@notes', 'records:read', '{"id":"x"}', '--json', '--origin', origin], { env: { ...process.env, TRILLION_KEY: KEY } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => done({ status, stderr }));
  });
  door.close();
  assert.notEqual(ran.status, 0);
  assert.equal(JSON.parse(ran.stderr.trim().split('\n').at(-1)).code, 'records_invalid');
});
