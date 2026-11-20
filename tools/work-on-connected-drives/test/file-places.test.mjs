import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { createFilePlaces } from '../read-data/file-places.mjs';

const identityOf = async file => `test:${await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8'))}`;

test('finds byte-identical drive paths and the names held by the Trillion space', async t => {
  const root = await realpath(tempFolder(path.join(os.tmpdir(), 'file-places-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'First'), second = path.join(root, 'Second');
  await mkdir(first); await mkdir(second);
  const source = path.join(first, 'clip.mov'), copy = path.join(second, 'renamed.mov'), other = path.join(second, 'other.mov');
  await writeFile(source, 'same bytes'); await writeFile(copy, 'same bytes'); await writeFile(other, 'other data');
  const devices = async () => [{ mount: first, name: 'First' }, { mount: second, name: 'Second' }];
  const places = createFilePlaces({
    devices,
    identityOf,
    candidates: async () => ({ paths: [source, copy, other], unreadable: [] }),
    lookup: async () => ['/Cloud/clip.mov', '/Projects/clip.mov'],
  });
  const answer = await places({ path: source, stored: { files: {} } });
  assert.equal(answer.complete, true);
  assert.deepEqual(answer.places, [
    { kind: 'drive', path: source, mount: first, drive: 'First' },
    { kind: 'drive', path: copy, mount: second, drive: 'Second' },
    { kind: 'own-files', identity: 'test:same bytes', names: ['/Cloud/clip.mov', '/Projects/clip.mov'] },
  ]);
});

test('refuses paths outside connected drives and folders', async t => {
  const root = tempFolder(path.join(os.tmpdir(), 'file-places-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const drive = path.join(root, 'Drive'); await mkdir(drive);
  const places = createFilePlaces({ devices: async () => [{ mount: drive, name: 'Drive' }], identityOf, candidates: async () => ({ paths: [], unreadable: [] }), lookup: async () => null });
  await assert.rejects(() => places({ path: root }), error => error.status === 403);
  await assert.rejects(() => places({ path: drive }), error => error.status === 400);
});

test('reports an incomplete read instead of claiming every place was checked', async t => {
  const root = tempFolder(path.join(os.tmpdir(), 'file-places-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'clip.mov'); await writeFile(source, 'same bytes');
  const places = createFilePlaces({
    devices: async () => [{ mount: root, name: 'Drive' }], identityOf,
    candidates: async () => ({ paths: [source], unreadable: [{ path: path.join(root, 'Private'), error: 'EACCES' }] }),
    lookup: async () => [],
  });
  const answer = await places({ path: source });
  assert.equal(answer.complete, false);
  assert.deepEqual(answer.unreadable, [{ path: path.join(root, 'Private'), error: 'EACCES' }]);
});

test('the person\'s own files are the ones handed in: a name holding the same bytes is a place, others are not', async t => {
  const root = await realpath(tempFolder(path.join(os.tmpdir(), 'file-places-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'clip.mov'); await writeFile(source, 'same bytes');
  const identity = makeHashCodeHexFromBytes(Buffer.from('same bytes'));
  const places = createFilePlaces({ devices: async () => [{ mount: root, name: 'Drive' }], candidates: async () => ({ paths: [], unreadable: [] }) });
  const found = await places({ path: source, stored: { files: {
    '/Projects/clip.mov': { base64: Buffer.from('same bytes').toString('base64') },
    '/Cloud/clip.mov': { identity },
    '/Notes/clip.txt': 'same bytes',
    '/Other/clip.mov': { base64: Buffer.from('other bytes').toString('base64') },
  } } });
  assert.equal(found.identity, identity);
  assert.equal(found.complete, true);
  assert.deepEqual(found.places.at(-1), { kind: 'own-files', identity, names: ['/Cloud/clip.mov', '/Notes/clip.txt', '/Projects/clip.mov'] });
  const none = await places({ path: source, stored: { files: { '/Other/clip.mov': 'other bytes' } } });
  assert.deepEqual(none.places.map(place => place.kind), ['drive']);
  assert.equal(none.complete, true);
});

test('a run handed no files says so and is not complete, never that the person\'s files hold no copy', async t => {
  const root = await realpath(tempFolder(path.join(os.tmpdir(), 'file-places-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'clip.mov'); await writeFile(source, 'same bytes');
  const places = createFilePlaces({ devices: async () => [{ mount: root, name: 'Drive' }], identityOf, candidates: async () => ({ paths: [], unreadable: [] }) });
  const answer = await places({ path: source });
  assert.deepEqual(answer.places.map(place => place.kind), ['drive']);
  assert.equal(answer.complete, false);
  assert.equal(answer.files_not_given, true);
});
