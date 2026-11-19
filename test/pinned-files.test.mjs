// The Workshop's pinned files (pinned-files.json) agree with its lockfile, and the helpers that make and check them hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installs, manifestProblems, PINNED_FILES, resolveDependency, treeOf, writePinnedFiles, SCRIPTS_NOT_NEEDED } from '../test-helpers/pinned-files.mjs';

const top = resolve(import.meta.dirname, '..');
const read = name => JSON.parse(readFileSync(resolve(top, name), 'utf8'));

test('every package the lockfile installs is pinned at its address and version, and nothing else of the lockfile is', () => {
  assert.deepEqual(manifestProblems(read(PINNED_FILES), read('package-lock.json')), []);
});

test('every pin is an https address with a BLAKE3 and the publisher record it was read against', () => {
  const { packages, programs } = read(PINNED_FILES);
  const pins = [...Object.values(packages).flatMap(row => Object.values(row.fetch)), ...Object.values(programs).flatMap(row => Object.values(row.fetch ?? {}))];
  for (const pin of pins.filter(pin => !pin.unverified)) {
    assert.match(pin.url, /^https:\/\/[^/@:]+\//);
    assert.match(pin.checked_against, /^https:\/\/[^/@:]+\//);
    assert.match(pin.blake3, /^[0-9a-f]{64}$/);
  }
});

const entry = (version, extra = {}) => ({ version, resolved: `https://registry.example.org/x/-/x-${version}.tgz`, integrity: 'sha512-AAAA', ...extra });

test('a module tree is the lockfile resolution: nested folder first, then each folder up, platform-only optionals left out', () => {
  const packages = {
    'node_modules/kit': entry('1.0.0', { dependencies: { a: '^1', b: '^1' }, optionalDependencies: { native: '^1', plain: '^1' } }),
    'node_modules/a': entry('1.0.0', { dependencies: { b: '^2' } }),
    'node_modules/a/node_modules/b': entry('2.0.0'),
    'node_modules/b': entry('1.0.0'),
    'node_modules/native': entry('1.0.0', { os: ['darwin'] }),
    'node_modules/plain': entry('1.0.0'),
    'node_modules/dev-only': entry('1.0.0', { dev: true }),
  };
  assert.equal(resolveDependency(packages, 'node_modules/a', 'b'), 'node_modules/a/node_modules/b');
  assert.equal(resolveDependency(packages, 'node_modules/kit', 'b'), 'node_modules/b');
  assert.equal(resolveDependency(packages, 'node_modules/kit', 'nobody'), null);
  assert.deepEqual(treeOf(packages, 'kit'), ['node_modules/a', 'node_modules/a/node_modules/b', 'node_modules/b', 'node_modules/kit', 'node_modules/plain']);
  assert.throws(() => treeOf(packages, 'dev-only'), /does not install/);
  assert.throws(() => treeOf({ ...packages, 'node_modules/kit': entry('1.0.0', { dependencies: { missing: '^1' } }) }, 'kit'), /needs missing/);
  assert.throws(() => treeOf({ ...packages, 'node_modules/plain': entry('1.0.0', { hasInstallScript: true }) }, 'plain'), /install script/);
  // A package whose install script was read and changes no file it runs with (install-scripts-not-needed.json) is admitted.
  assert.deepEqual(treeOf({ ...packages, 'node_modules/plain': entry('1.0.0', { hasInstallScript: true }) }, 'plain', { 'node_modules/plain': 'prints a warning only' }), ['node_modules/plain']);
  for (const [key, why] of Object.entries(SCRIPTS_NOT_NEEDED)) assert.ok(key.startsWith('node_modules/') && why.length > 40, `${key} says what its script does`);
});

test('writing the pinned files keeps a pin at the same address and version, reads a new one against its sha512 and refuses other bytes', async () => {
  const bytes = Buffer.from('an archive');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const lock = { packages: { '': {}, 'node_modules/kit': { version: '1.0.0', resolved: 'https://registry.example.org/kit/-/kit-1.0.0.tgz', integrity }, 'node_modules/dev': entry('1.0.0', { dev: true }) } };
  const previous = { _what: 'x', programs: {}, packages: { wheel: { version: '1', archive: 'zip', fetch: { any: { url: 'https://w.example.org/w.whl', blake3: 'a'.repeat(64), checked_against: 'https://w.example.org/' } } } } };
  const asked = [];
  const made = await writePinnedFiles({ lock, previous, fetchBytes: async address => { asked.push(address); return bytes; } });
  assert.deepEqual(asked, ['https://registry.example.org/kit/-/kit-1.0.0.tgz']);
  assert.deepEqual(Object.keys(made.packages), ['node_modules/kit', 'wheel']);
  assert.equal(made.packages['node_modules/kit'].archive, 'tgz');
  assert.match(made.packages['node_modules/kit'].fetch.any.blake3, /^[0-9a-f]{64}$/);
  assert.equal(made.packages['node_modules/kit'].fetch.any.checked_against, 'https://registry.example.org/kit/1.0.0');
  assert.deepEqual(manifestProblems(made, lock), []);
  const again = await writePinnedFiles({ lock, previous: made, fetchBytes: async () => { throw new Error('read again'); } });
  assert.deepEqual(again, made);
  await assert.rejects(writePinnedFiles({ lock, previous, fetchBytes: async () => Buffer.from('other bytes') }), /not the lockfile's sha512/);
  assert.ok(manifestProblems(previous, lock).some(line => line.includes('node_modules/kit')), 'a package the lockfile installs and nothing pins');
  assert.ok(manifestProblems({ packages: { 'node_modules/gone': made.packages['node_modules/kit'] } }, lock).some(line => line.includes('node_modules/gone')));
  assert.equal(installs(lock.packages['node_modules/dev']), false);
});
