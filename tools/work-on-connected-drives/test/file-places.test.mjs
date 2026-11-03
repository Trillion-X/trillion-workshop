import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFilePlaces } from '../read-data/file-places.mjs';

const identityOf = async file => `test:${await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8'))}`;

test('finds byte-identical drive paths and the names held by the Trillion space', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'trillion-file-places-')));
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
    lookup: async identity => ({ identity, names: ['/Cloud/clip.mov', '/Projects/clip.mov'] }),
  });
  const answer = await places({ path: source });
  assert.equal(answer.complete, true);
  assert.deepEqual(answer.places, [
    { kind: 'drive', path: source, mount: first, drive: 'First' },
    { kind: 'drive', path: copy, mount: second, drive: 'Second' },
    { kind: 'trillion-space', identity: 'test:same bytes', names: ['/Cloud/clip.mov', '/Projects/clip.mov'] },
  ]);
});

test('refuses paths outside connected drives and folders', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trillion-file-places-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const drive = path.join(root, 'Drive'); await mkdir(drive);
  const places = createFilePlaces({ devices: async () => [{ mount: drive, name: 'Drive' }], identityOf, candidates: async () => ({ paths: [], unreadable: [] }), lookup: async () => null });
  await assert.rejects(() => places({ path: root }), error => error.status === 403);
  await assert.rejects(() => places({ path: drive }), error => error.status === 400);
});

test('reports an incomplete read instead of claiming every place was checked', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trillion-file-places-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'clip.mov'); await writeFile(source, 'same bytes');
  const places = createFilePlaces({
    devices: async () => [{ mount: root, name: 'Drive' }], identityOf,
    candidates: async () => ({ paths: [source], unreadable: [{ path: path.join(root, 'Private'), error: 'EACCES' }] }),
    lookup: async () => null,
  });
  const answer = await places({ path: source });
  assert.equal(answer.complete, false);
  assert.deepEqual(answer.unreadable, [{ path: path.join(root, 'Private'), error: 'EACCES' }]);
});
