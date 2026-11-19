// test/package-files-one-layout.test.mjs
//
// A row never lays the same thing twice: the engine refuses every run of a row whose item puts a file where another item already
// put it (container.rs copy_file). layoutDuplicates finds such a pair by where it lands, so a package named as split2 and as
// node_modules/split2 at one folder is one layout, and the generator refuses to write a row that has one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutDuplicates } from '../test-helpers/tool-row-imports.mjs';

test('the same package named two ways at one folder is a double layout', () => {
  const items = [
    { packages: ['node_modules/split2'], at: '/opt/node_modules/split2' },
    { packages: ['split2'], at: '/opt/split2' },
  ];
  assert.deepEqual(layoutDuplicates(items), ['package /opt/split2 split2']);
});

test('a package folder and a path of the same tool folder are not one layout', () => {
  const items = [
    { package: 'media', paths: ['do-work'], at: '/opt/media' },
    { packages: ['numpy'], at: '/opt/media/do-work' },
  ];
  assert.deepEqual(layoutDuplicates(items), []);
});

test('the same path laid twice by two items is a double layout', () => {
  const items = [
    { package: 'app', paths: ['do-work/'], at: '/opt/app' },
    { package: 'app', paths: ['do-work'], at: '/opt/app/' },
  ];
  assert.deepEqual(layoutDuplicates(items), ['path /opt/app/do-work']);
});
