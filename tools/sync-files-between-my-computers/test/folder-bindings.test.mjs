// Folder bindings (do-work/folder-bindings.mjs). Moved from old trillion test/files-sync-adoption.test.mjs: the two
// binding tests keep their assertions; the old Drive under them is replaced by a stand-in keeper here with the same
// three operations the module asks for (entryOf, keepFile with its compare-and-set gate, writeRefusal). The test of
// the Drive's loopback HTTP routes for bindings went with that Drive. Every folder is a fresh temporary folder.
import assert from 'node:assert/strict';
import test from 'node:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { createFolderBindings } from '../do-work/folder-bindings.mjs';
import { settingsOf as settings } from '../do-work/drive-sync-status.mjs';

const identityOf = bytes => makeHashCodeHexFromBytes(bytes);
const text = value => Buffer.from(value);
const IGNORED = ['._', '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', '.hidden', '.metadata_never_index'];

// A keeper of the person's Trillion files in memory: the one compare-and-set gate on every keep.
function keeper() {
  const files = new Map();
  const ops = {
    entryOf: async name => files.get(name) ?? null,
    writeRefusal: async name => (name.startsWith('/Shared/') ? 'The shared folder is not written here.' : null),
    keepFile: async (name, stream, size, mediaType, modifiedAt, expected) => {
      const parts = [];
      for await (const piece of stream) parts.push(piece);
      const bytes = Buffer.concat(parts);
      const current = files.get(name)?.identity ?? null;
      if (expected !== undefined && expected !== current) throw Object.assign(new Error('This file changed.'), { status: 409, code: 'stale_version', current_identity: current });
      const entry = { identity: identityOf(bytes), byte_length: bytes.length };
      files.set(name, entry);
      return entry;
    },
  };
  return { files, ops, stored: async name => files.get(name) ?? null };
}
function mounted({ redirect = {} } = {}) {
  const k = keeper();
  const home = mkdtempSync(path.join(tmpdir(), 'sync-home-'));
  const config = { ...settings().folder_bindings, redirect: { ...settings().folder_bindings.redirect, ...redirect } };
  const folderBindings = createFolderBindings({ ops: k.ops, config, file: path.join(home, 'state', 'bindings.json'), stateDir: path.join(home, 'state'), home,
    ignored: name => IGNORED.some(start => path.posix.basename(name).startsWith(start)) });
  return { ...k, folderBindings };
}
const folderWith = files => {
  const root = mkdtempSync(path.join(tmpdir(), 'trillion-bound-'));
  for (const [name, content] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), content); }
  return root;
};

test('a folder binding is refused unless its constraints hold, and a run sends only what is new or changed and never removes a name', async () => {
  const local = folderWith({ 'a.txt': 'alpha', 'sub/b.bin': 'bravo bytes', 'empty.txt': '', '.DS_Store': 'finder' });
  symlinkSync('/etc/hosts', path.join(local, 'link'));
  const m = mounted();
  const bound = m.folderBindings;
  await assert.rejects(bound.add({ local: 'relative/path', target: '/Backup' }), /whole absolute path/);
  await assert.rejects(bound.add({ local: path.join(local, 'missing'), target: '/Backup' }), /missing or cannot be read/);
  await assert.rejects(bound.add({ local, target: '/Shared/Docs' }), /shared folder is not written here/);
  const binding = await bound.add({ local, target: '/Backup/Docs' });
  await assert.rejects(bound.add({ local, target: '/Other' }), /already bound/);
  await assert.rejects(bound.add({ local: path.join(local, 'sub'), target: '/Third' }), /overlaps/);
  const first = await bound.run(binding.id);
  assert.deepEqual([first.uploaded, first.unchanged, first.empty, first.ignored, first.links_left, first.failed.length], [2, 0, 1, 1, 1, 0]);
  assert.equal((await m.stored('/Backup/Docs/a.txt')).identity, identityOf(text('alpha')));
  assert.equal((await m.stored('/Backup/Docs/sub/b.bin')).identity, identityOf(text('bravo bytes')));
  assert.equal(await m.stored('/Backup/Docs/.DS_Store'), null);
  const second = await bound.run(binding.id);
  assert.deepEqual([second.uploaded, second.unchanged], [0, 2], 'nothing is sent twice');
  writeFileSync(path.join(local, 'a.txt'), 'alpha, edited');
  const third = await bound.run(binding.id);
  assert.equal(third.uploaded, 1);
  assert.equal((await m.stored('/Backup/Docs/a.txt')).identity, identityOf(text('alpha, edited')));
  // A name changed in Trillion after the last run: a backup's local folder is the truth, so the run reads Trillion's current
  // version fresh and replaces exactly that version through the compare-and-set gate.
  m.files.set('/Backup/Docs/a.txt', { identity: identityOf(text('changed elsewhere')), byte_length: 17 });
  writeFileSync(path.join(local, 'a.txt'), 'edited again here');
  const conflicted = await bound.run(binding.id);
  assert.equal(conflicted.uploaded, 1);
  assert.equal((await m.stored('/Backup/Docs/a.txt')).identity, identityOf(text('edited again here')));
  rmSync(path.join(local, 'sub/b.bin'));
  await bound.run(binding.id);
  assert.equal((await m.stored('/Backup/Docs/sub/b.bin')).identity, identityOf(text('bravo bytes')), 'a local removal never removes a Trillion name');
  assert.equal((await bound.edit(binding.id, { enabled: false })).enabled, false);
  await assert.rejects(bound.run(binding.id), error => error.code === 'paused', 'a paused binding does not run');
  await bound.edit(binding.id, { enabled: true });
  rmSync(local, { recursive: true });
  const view = await bound.read(binding.id);
  assert.equal(view.checks.every(row => row.ok), false, 'the check reports the folder that went missing underneath');
  assert.deepEqual(await bound.remove(binding.id), { id: binding.id, removed: true });
  assert.deepEqual(await bound.list(), []);
});

test('redirect is off until turned on, moves nothing unless every file is proven stored, keeps the folder whole, and restore puts it back', async () => {
  const local = path.join(mkdtempSync(path.join(tmpdir(), 'trillion-known-')), 'Documents');
  mkdirSync(local);
  writeFileSync(path.join(local, 'plan.txt'), 'the plan');
  writeFileSync(path.join(local, 'empty.txt'), '');
  const linkRoot = mkdtempSync(path.join(tmpdir(), 'trillion-link-'));
  const off = mounted();
  const offBinding = await off.folderBindings.add({ local, target: '/Known/Documents' });
  await assert.rejects(off.folderBindings.redirect(offBinding.id), error => error.code === 'redirect_off');
  const m = mounted({ redirect: { enabled: true, link_root: linkRoot } });
  const bound = m.folderBindings;
  const binding = await bound.add({ local, target: '/Known/Documents' });
  await assert.rejects(bound.redirect(binding.id), error => error.code === 'not_proven' && error.problems[0].name === '/Known/Documents/empty.txt');
  assert.equal(lstatSync(local).isDirectory(), true, 'a refused redirect changes nothing');
  assert.equal(readFileSync(path.join(local, 'plan.txt'), 'utf8'), 'the plan');
  rmSync(path.join(local, 'empty.txt'));
  const done = await bound.redirect(binding.id);
  assert.equal(lstatSync(local).isSymbolicLink(), true);
  assert.equal(readlinkSync(local), path.join(linkRoot, '/Known/Documents'));
  assert.equal(readFileSync(path.join(done.redirect.archive, 'plan.txt'), 'utf8'), 'the plan', 'the whole folder is kept, not deleted');
  assert.equal((await m.stored('/Known/Documents/plan.txt')).identity, identityOf(text('the plan')));
  await assert.rejects(bound.remove(binding.id), error => error.code === 'redirected');
  const back = await bound.restore(binding.id);
  assert.equal(back.redirect, null);
  assert.equal(lstatSync(local).isDirectory(), true);
  assert.equal(readFileSync(path.join(local, 'plan.txt'), 'utf8'), 'the plan');
  await bound.redirect(binding.id);
  unlinkSync(local); writeFileSync(local, 'someone put a file here');
  await assert.rejects(bound.restore(binding.id), error => error.code === 'path_changed');
  assert.equal(readFileSync(local, 'utf8'), 'someone put a file here', 'restore never overwrites what is at the old path');
});
