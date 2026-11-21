// tools/keep-lists-of-rows/test/list-source.test.mjs
//
// The Lists screen's list source (read-data/list-source.ts): the person's own tables when a page picks none, and the one
// source a page mounts at its entry, read by the screen when it mounts (the members page mounts its records).
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const { outputFiles } = await build({
  absWorkingDir: root, entryPoints: ['read-data/list-source.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error',
  alias: { 'trillion-workshop': new URL('../../..', import.meta.url).pathname.replace(/\/$/, '') },
});
// The bundle holds every file it imports, so it loads from its own text (list-keeper.test.mjs does the same).
const { activeListSource, setListSource } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

test('a page that picks no list source reads the list functions of the person\'s tables', () => {
  const source = activeListSource();
  for (const name of ['readLists', 'readList', 'readRows', 'putRows', 'changeList', 'makeList', 'saveView', 'removeView', 'titleLinks', 'whereOf']) {
    assert.equal(typeof source[name], 'function', name);
  }
});

test('setListSource mounts the source that activeListSource returns', () => {
  const pages = { readLists: async () => [], readList: async () => null };
  setListSource(pages);
  assert.equal(activeListSource(), pages);
});
