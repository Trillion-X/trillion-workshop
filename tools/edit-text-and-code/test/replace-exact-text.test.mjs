// tools/edit-text-and-code: the one-piece replace, in the module and run the way the engine runs the row
// (granted folder in argv, { file, find, replace } on standard input, the answer on the last line), on made-up files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { replaceExactlyOnce, Refusal } from '../do-work/replace-exact-text.mjs';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

function run(granted, input) {
  const ran = spawnSync(process.execPath, [resolve(folder, 'do-work', 'replace-exact-text.mjs'), granted], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: ran.status, answer: JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
}

function bakery(t) {
  const root = mkdtempSync(join(tmpdir(), 'edit-text-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'menu'), { recursive: true });
  writeFileSync(join(root, 'menu', 'prices.txt'), 'bagel 3\nloaf 5\ncroissant 4\nbagel 3 extra\n');
  writeFileSync(join(root, 'notes.md'), 'first line\nsecond line\n');
  return root;
}

test('the module replaces one occurrence and refuses none or several', () => {
  assert.equal(replaceExactlyOnce('a b c', 'b', 'x'), 'a x c');
  assert.equal(replaceExactlyOnce('a b c', ' b', ''), 'a c');
  assert.throws(() => replaceExactlyOnce('a b c', 'z', 'x'), /does not occur/);
  assert.throws(() => replaceExactlyOnce('b b', 'b', 'x'), /more than once/);
  assert.throws(() => replaceExactlyOnce('abc', '', 'x'), /may not be empty/);
  assert.throws(() => replaceExactlyOnce('abc', 'a', undefined), Refusal);
});

test('the row runs on the person\'s computer with the change-a-folder grant, with no internet', () => {
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoke.kind, 'computer');
  assert.deepEqual(rows[0].invoke.capabilities, ['change-a-folder']);
  assert.notEqual(rows[0].invoke.internet, true);
  assert.deepEqual(rows[0].invoke.argv.at(-1), { fill: { from: 'task', field: 'grants.change-a-folder.folder' } });
});

test('a run changes only the one run of text and reports the sizes', t => {
  const root = bakery(t);
  const { status, answer } = run(root, { file: 'menu/prices.txt', find: 'loaf 5', replace: 'loaf 6' });
  assert.equal(status, 0);
  assert.deepEqual(answer.result, { file: 'menu/prices.txt', bytes_before: 41, bytes_after: 41, replaced: 1 });
  assert.equal(readFileSync(join(root, 'menu', 'prices.txt'), 'utf8'), 'bagel 3\nloaf 6\ncroissant 4\nbagel 3 extra\n');
  assert.deepEqual(readdirSync(join(root, 'menu')), ['prices.txt'], 'no staging file is left behind');
});

test('text is compared as it is: newlines, quotes and a trailing newline in the fragment count', t => {
  const root = bakery(t);
  assert.equal(run(root, { file: 'notes.md', find: 'first line\nsecond', replace: '1st\n"2nd"' }).status, 0);
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), '1st\n"2nd" line\n');
  const miss = run(root, { file: 'notes.md', find: 'line\n\n', replace: 'x' });
  assert.equal(miss.status, 1);
  assert.match(miss.answer.error, /does not occur/);
});

test('zero or several matches change nothing and say why', t => {
  const root = bakery(t);
  const before = readFileSync(join(root, 'menu', 'prices.txt'), 'utf8');
  const many = run(root, { file: 'menu/prices.txt', find: 'bagel 3', replace: 'bagel 4' });
  assert.equal(many.status, 1);
  assert.match(many.answer.error, /more than once.*unique/);
  const none = run(root, { file: 'menu/prices.txt', find: 'muffin', replace: 'x' });
  assert.match(none.answer.error, /does not occur/);
  assert.equal(readFileSync(join(root, 'menu', 'prices.txt'), 'utf8'), before);
});

test('the file keeps its permission bits', t => {
  const root = bakery(t);
  chmodSync(join(root, 'notes.md'), 0o640);
  assert.equal(run(root, { file: 'notes.md', find: 'second', replace: '2nd' }).status, 0);
  assert.equal(statSync(join(root, 'notes.md')).mode & 0o777, 0o640);
});

test('a path that leaves the folder, a link, a folder, a missing file or binary bytes is refused', t => {
  const root = bakery(t);
  const outside = mkdtempSync(join(tmpdir(), 'edit-text-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.txt'), 'outside\n');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
  symlinkSync(outside, join(root, 'linked-folder'));
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  const ask = file => run(root, { file, find: 'outside', replace: 'x' });
  assert.match(ask('../x').answer.error, /leaves the granted folder/);
  assert.match(ask(join(outside, 'secret.txt')).answer.error, /relative/);
  assert.match(ask('link.txt').answer.error, /link/);
  assert.match(ask('linked-folder/secret.txt').answer.error, /link/);
  assert.match(ask('menu').answer.error, /not a regular file/);
  assert.match(ask('nothing.txt').answer.error, /does not exist/);
  assert.match(run(root, { file: 'blob.bin', find: 'a', replace: 'x' }).answer.error, /not valid UTF-8/);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside\n');
});

test('a request that is not JSON or lacks a file is refused with the shape to send', t => {
  const root = bakery(t);
  const ran = spawnSync(process.execPath, [resolve(folder, 'do-work', 'replace-exact-text.mjs'), root], { input: 'not json', encoding: 'utf8' });
  assert.match(JSON.parse(ran.stdout).error, /\{ file, find, replace \}/);
  assert.match(run(root, { find: 'a', replace: 'b' }).answer.error, /file must be a path/);
});
