// Every package in the committed package-lock.json has a licence licence-classes.json lists, in a class that lets it run
// wherever this repository's own tools run (test-helpers/lockfile-licences.mjs). This root test runs on every push, so
// a lock that gains a package of an unknown or conflicting licence is refused at push. The fixtures name packages
// only by their public npm names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { json, root, rows } from '../test-helpers/tool-rows.mjs';
import { lockLicenceRefusals } from '../test-helpers/lockfile-licences.mjs';

const classes = json(resolve(root, 'licence-classes.json')).records.map(record => record.payload);
const ownRows = [
  { kind: 'ai-tool-descriptor', id: 'tool:sample-on-your-computer', licence_class: 'licence:maker-own', placements: ['placement:your-computer'], invoke: { kind: 'on-your-computer' } },
  { kind: 'ai-tool-descriptor', id: 'tool:sample-in-a-container', licence_class: 'licence:maker-own', placements: ['placement:small-container'], invoke: { kind: 'container' } },
];
const lockOf = packages => ({ lockfileVersion: 3, packages: { '': { name: 'sample', license: 'Apache-2.0' }, ...packages } });
const refusals = packages => lockLicenceRefusals(lockOf(packages), classes, ownRows);

test('the committed package-lock.json passes against this repository\'s own rows', () => {
  assert.deepEqual(lockLicenceRefusals(json(resolve(root, 'package-lock.json')), classes, rows().map(row => row.payload)), []);
});

test('a licence is judged, not its spelling: the sharp natives (LGPL-3.0-or-later) are licence:permissive like LGPL-3.0', () => {
  for (const spelling of ['LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'GPL-2.0-only', 'GPL-3.0-or-later']) {
    assert.equal(classes.find(item => item.licences.includes(spelling))?.id, 'licence:permissive', spelling);
  }
  assert.equal(classes.find(item => item.licences.includes('AGPL-3.0-or-later'))?.id, 'licence:network-copyleft');
  assert.deepEqual(refusals({
    'node_modules/@img/sharp-libvips-darwin-arm64': { version: '1.2.4', license: 'LGPL-3.0-or-later', optional: true },
    'node_modules/@img/sharp-win32-x64': { version: '0.34.5', license: 'Apache-2.0 AND LGPL-3.0-or-later', optional: true },
  }), []);
});

test('a licence in no class is refused, alone or carried with AND', () => {
  assert.deepEqual(refusals({
    'node_modules/i': { version: '1.0.0', license: 'Some-Licence-1.0' },
    'node_modules/j': { version: '1.0.0', license: 'Apache-2.0 AND Some-Licence-1.0' },
    'node_modules/k': { version: '1.0.0', license: 'Apache-2.0' },
  }), [
    'node_modules/i (Some-Licence-1.0): Some-Licence-1.0 is in no licence class',
    'node_modules/j (Apache-2.0 AND Some-Licence-1.0): Some-Licence-1.0 is in no licence class',
  ]);
});

test('GPL-3.0 (libsignal) is licence:permissive, a run right with no placement limit here, so it passes', () => {
  assert.equal(classes.find(item => item.licences.includes('GPL-3.0')).id, 'licence:permissive');
  assert.deepEqual(refusals({ 'node_modules/libsignal': { version: '2.0.1', license: 'GPL-3.0' } }), []);
});

test('OR passes when one choice passes; a class that conflicts with the rows is refused, naming why', () => {
  assert.deepEqual(refusals({ 'node_modules/a': { license: '(MIT OR Some-Licence-1.0)' } }), []);
  assert.deepEqual(refusals({ 'node_modules/b': { license: 'CC-BY-NC-4.0' } }), [
    'node_modules/b (CC-BY-NC-4.0): CC-BY-NC-4.0 is licence:no-hosting-rights, which does not allow placement:your-computer, placement:small-container, where this repository\'s tools run',
  ]);
  assert.deepEqual(refusals({ 'node_modules/c': { license: 'AGPL-3.0' } }), [
    'node_modules/c (AGPL-3.0): AGPL-3.0 is licence:network-copyleft, which does not allow placement:your-computer, where this repository\'s tools run',
  ]);
});

test('a package with no licence, or one that is not an SPDX expression, is refused; a dev package needs only a known licence', () => {
  assert.deepEqual(refusals({ 'node_modules/d': { version: '1.0.0' }, 'node_modules/e': { license: 'MIT AND' } }), [
    'node_modules/d names no licence',
    'node_modules/e (MIT AND): not an SPDX expression: unexpected end',
  ]);
  assert.deepEqual(refusals({ 'node_modules/f': { license: 'AGPL-3.0', dev: true } }), []);
  assert.deepEqual(refusals({ 'node_modules/g': { license: 'Some-Licence-1.0', dev: true } }), ['node_modules/g (Some-Licence-1.0): Some-Licence-1.0 is in no licence class']);
});

test('a row running another repository\'s code does not bind the lock', () => {
  const external = [{ kind: 'ai-tool-descriptor', id: 'tool:sample-external', licence_class: 'licence:permissive', placements: ['placement:this-account'], invoke: { kind: 'on-your-computer', repository: 'https://example.com/sample.git' } }];
  assert.deepEqual(lockLicenceRefusals(lockOf({ 'node_modules/h': { license: 'MIT' } }), classes, [...ownRows, ...external]), []);
});
