// read-data/manifest-permissions.mjs (DATA in read-data/manifest-permissions.json): manifests checked against permission
// rows, entries confined to their folder, host API gated per call. Moved from old trillion
// test/manifest-permissions.test.mjs with its assertions unchanged; the test of the old Mac host's tool loader
// (computer/mac-tools.mjs) stays with that host.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkManifest, confinedEntry, guardApi } from '../read-data/manifest-permissions.mjs';
import { checkDeclaredPermissions } from '../do-work/check-a-manifest.mjs';

test('a manifest may only name permissions that have a row', () => {
  assert.equal(checkManifest({ permissions: ['read_files', 'network_egress'] }).ok, true);
  const bad = checkManifest({ permissions: ['read_files', 'root_everything'] });
  assert.deepEqual([bad.ok, bad.unknown], [false, ['root_everything']]);
  assert.match(bad.why, /root_everything/);
  assert.equal(checkManifest({}).ok, true);
});

test('an entry outside its package folder is refused, by path or by symlink', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'perm-'));
  const other = mkdtempSync(path.join(os.tmpdir(), 'perm-other-'));
  mkdirSync(path.join(root, 'sub')); writeFileSync(path.join(other, 'evil.mjs'), 'export default 1');
  symlinkSync(path.join(other, 'evil.mjs'), path.join(root, 'link.mjs'));
  assert.equal(confinedEntry(root, './sub/ok.mjs'), path.join(root, 'sub', 'ok.mjs'));
  for (const bad of ['../x.mjs', '/etc/passwd', './sub/../../x.mjs', 'link.mjs']) assert.throws(() => confinedEntry(root, bad), /outside its package folder/, bad);
});

test('the guarded API exposes only gated calls and each refuses without its permission', async () => {
  const calls = [];
  const api = { fetch: async url => { calls.push(['fetch', url]); return 'ok'; }, readFile: path_ => { calls.push(['readFile', path_]); return 'text'; }, secretThing: () => 'never', log: line => calls.push(['log', line]) };
  const reader = guardApi(api, { permissions: ['read_files'] }, { open: ['log'] });
  assert.equal(reader.readFile('/a'), 'text');
  assert.throws(() => reader.fetch('https://x.test'), /fetch needs the permission network_egress/);
  assert.equal(reader.secretThing, undefined, 'a call no row gates is not exposed');
  reader.log('hello');
  assert.deepEqual(calls, [['readFile', '/a'], ['log', 'hello']]);
  assert.ok(Object.isFrozen(reader));
  const both = guardApi(api, { permissions: ['network_egress'] });
  assert.equal(await both.fetch('https://x.test'), 'ok');
});

test('the row checks a manifest against the shipped rows or the caller\'s own', () => {
  assert.deepEqual(checkDeclaredPermissions({ manifest: { permissions: ['read_screen'] } }).needs.map(row => row.id), ['read_screen']);
  const own = checkDeclaredPermissions({ manifest: { permissions: ['read_screen'] }, permissions: [{ id: 'print', says: 'Print', calls: ['print'] }] });
  assert.deepEqual([own.ok, own.unknown], [false, ['read_screen']]);
  assert.equal(checkDeclaredPermissions({}).ok, true);
});
