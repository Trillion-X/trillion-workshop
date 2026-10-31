// pin-files-by-content on a made-up app's settings folder: a check says which pins are stale, missing or left over;
// a write brings them up to the files and keeps the pin file's other keys and order; a folder outside the root is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinFiles } from '../read-data/pins.mjs';

const command = fileURLToPath(new URL('../do-work/pin-files.mjs', import.meta.url));

async function app() {
  const root = await mkdtemp(join(tmpdir(), 'pin-files-by-content-'));
  await mkdir(join(root, 'settings', 'themes'), { recursive: true });
  await writeFile(join(root, 'settings', 'colors.json'), '{"sky":"blue"}\n');
  await writeFile(join(root, 'settings', 'themes', 'night.json'), '{"sky":"black"}\n');
  await writeFile(join(root, 'settings', 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'pins.json'), '{\n  "_what": "made-up pins",\n  "files": {}\n}\n');
  return root;
}

const pin = (root, more = {}) => pinFiles({ root, pin_file: 'pins.json', folder: 'settings', unpinned_ok: ['package.json'], ...more });

test('a check of an empty pin file names every file as added and writes nothing', async () => {
  const root = await app();
  const answer = await pin(root);
  assert.deepEqual(answer, { ok: false, pinned: 2, added: ['colors', 'themes/night'], changed: [], gone: [], unchanged: 0, written: false });
  assert.equal(JSON.parse(await readFile(join(root, 'pins.json'), 'utf8')).files.colors, undefined);
});

test('a write pins each file by its bytes and BLAKE3, keeps the other keys, and a check then passes', async () => {
  const root = await app();
  await pin(root, { write: true });
  const held = JSON.parse(await readFile(join(root, 'pins.json'), 'utf8'));
  assert.equal(held._what, 'made-up pins');
  assert.deepEqual(held.files.colors, { path: 'colors.json', pin: { bytes: 15, blake3: held.files.colors.pin.blake3 } });
  assert.match(held.files.colors.pin.blake3, /^[0-9a-f]{64}$/);
  assert.equal((await pin(root)).ok, true);
});

test('a changed file and a removed file are named; a write keeps the order of the entries it keeps', async () => {
  const root = await app();
  await pin(root, { write: true });
  await writeFile(join(root, 'settings', 'colors.json'), '{"sky":"grey"}\n');
  await writeFile(join(root, 'settings', 'themes', 'night.json'), '');
  await writeFile(join(root, 'settings', 'apple.json'), '{}\n');
  const answer = await pin(root);
  assert.deepEqual([answer.added, answer.changed], [['apple'], ['colors', 'themes/night']]);
  await pin(root, { write: true });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(root, 'pins.json'), 'utf8')).files), ['colors', 'themes/night', 'apple']);
});

test('the shape is DATA: the identity form and other key names are the caller\'s', async () => {
  const root = await app();
  await writeFile(join(root, 'pins.json'), '{"pinned":{}}\n');
  await pin(root, { write: true, shape: { entries_at: 'pinned', hash_key: 'hash', hash_form: 'identity', strip_extension: false } });
  const held = JSON.parse(await readFile(join(root, 'pins.json'), 'utf8'));
  assert.match(held.pinned['colors.json'].pin.hash, /^1f:[0-9a-f]{64}$/);
});

test('a folder outside the root is refused; the command exits 1 on a difference and 0 once written', async () => {
  const root = await app();
  await assert.rejects(pinFiles({ root: join(root, 'settings'), pin_file: '../pins.json', folder: '.' }), /is not inside/);
  const run = verb => spawnSync(process.execPath, [command, verb, '--root', root, '--pin-file', 'pins.json', '--folder', 'settings', '--unpinned-ok', 'package.json'], { encoding: 'utf8' });
  assert.equal(run('check').status, 1);
  assert.equal(run('write').status, 0);
  assert.equal(run('check').status, 0);
});
