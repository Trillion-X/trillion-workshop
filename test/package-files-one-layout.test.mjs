// test/package-files-one-layout.test.mjs
//
// A row never lays a file the commit does not hold, or one package folder twice: the engine refuses every run of such a row
// (trillion-rust container.rs). The rule is the pin tool's (layoutProblems in tools/workflows/do-work/pin-a-commit-by-its-files.mjs),
// and the generator and the push gate both call it, so these cases pin that one rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutProblems } from '../tools/workflows/do-work/pin-a-commit-by-its-files.mjs';

const commitWith = (layout, paths) => [
  ['package-files.json', Buffer.from(JSON.stringify(layout))],
  ...paths.map(path => [path, Buffer.alloc(0)]),
];

test('one package folder placed by two packages items is a problem', () => {
  const files = commitWith({
    'tool:a': [{ packages: ['split2'], at: '/opt/node_modules/split2' }, { packages: ['node_modules/split2'], at: '/opt/node_modules/split2' }],
  }, []);
  assert.deepEqual(layoutProblems(files), ['tool:a places the package folder /opt/node_modules/split2 twice']);
});

test('a file a row lays that the commit does not hold is a problem', () => {
  const files = commitWith({ 'tool:a': [{ package: 'a', paths: ['do-work/missing.mjs'], at: '/opt/a' }] }, ['tools/a/do-work/present.mjs']);
  assert.deepEqual(layoutProblems(files), ['tool:a is laid out with tools/a/do-work/missing.mjs, which this commit does not hold']);
});

test('a package folder and a path of one tool folder are not one layout', () => {
  const files = commitWith({
    'tool:a': [{ package: 'media', paths: ['do-work'], at: '/opt/media' }, { packages: ['numpy'], at: '/opt/media/do-work' }],
  }, ['tools/media/do-work/x.mjs']);
  assert.deepEqual(layoutProblems(files), []);
});
