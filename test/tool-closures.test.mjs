// tool-closures.json (the tool folders each tool folder needs) is what test-helpers/write-pinned-files.mjs writes, and the scan holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TOOL_CLOSURES, toolClosures, toolClosuresText } from '../test-helpers/tool-closures.mjs';

const top = resolve(import.meta.dirname, '..');

test('the committed tool-closures.json is what the generator writes (run node test-helpers/write-pinned-files.mjs)', () => {
  assert.equal(readFileSync(resolve(top, TOOL_CLOSURES), 'utf8'), toolClosuresText(top));
});

test('every folder is listed, with sorted lists that never name the folder itself or a folder that is not there', () => {
  const { tools } = JSON.parse(readFileSync(resolve(top, TOOL_CLOSURES), 'utf8'));
  const names = Object.keys(tools);
  assert.deepEqual(names, [...names].sort());
  for (const [name, needs] of Object.entries(tools)) {
    assert.deepEqual(needs, [...needs].sort(), name);
    assert.ok(!needs.includes(name), name);
    for (const other of needs) assert.ok(other in tools, `${name} names ${other}`);
  }
});

test('a relative path, a package path and a package_files item each name a folder, and the need is transitive', () => {
  const root = mkdtempSync(join(tmpdir(), 'closures-'));
  const put = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('tools/a/show/x.tsx', "import b from '../../b/read-data/y.mjs';\n");
  put('tools/b/read-data/y.mjs', "import c from 'trillion-workshop/tools/c/read-data/z.mjs';\n");
  put('tools/c/read-data/z.mjs', 'export const z = 1;\n');
  put('tools/d/tool-rows.json', JSON.stringify([{ invoke: { files: { package_files: [{ package: 'c', paths: ['read-data'], at: '/opt/c' }, { package: 'd', paths: ['x'], at: '/opt/d' }] } } }]));
  put('tools/e/notes.md', 'see tools/a/show/x.tsx\n');
  put('tools/e/node_modules/p/index.mjs', "import '../../../a/show/x.tsx';\n");
  assert.deepEqual(toolClosures(root), { a: ['b', 'c'], b: ['c'], c: [], d: ['c'], e: [] });
});
