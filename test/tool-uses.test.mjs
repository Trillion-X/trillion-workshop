// Every tool row declares the other tools its folder's files use (`uses_tools`), as test-helpers/write-pinned-files.mjs writes them.
import { tempFolder } from '../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rowsWithUses, toolClosures, usesProblems } from '../test-helpers/tool-closures.mjs';

const top = resolve(import.meta.dirname, '..');
const testNames = JSON.stringify({ folders: ['test', 'tests', '__tests__'], files: ['*.test.*', '*.spec.*', 'test_*'] });

test('every tool row declares the tools its folder\'s imports reach (run node test-helpers/write-pinned-files.mjs)', () => {
  assert.deepEqual(usesProblems(top), []);
});

test('a relative path, a package path and a package_files item each name a folder, and the need is transitive', () => {
  const root = tempFolder(join(tmpdir(), 'closures-'));
  const put = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('test-helpers/test-names.json', testNames);
  put('tools/a/show/x.tsx', "import b from '../../b/read-data/y.mjs';\n");
  put('tools/b/read-data/y.mjs', "import c from 'trillion-workshop/tools/c/read-data/z.mjs';\n");
  put('tools/c/read-data/z.mjs', 'export const z = 1;\n');
  put('tools/d/tool-rows.json', JSON.stringify({ records: [{ payload: { kind: 'ai-tool-descriptor', id: 'tool:d', invoke: { files: { package_files: [{ package: 'c', paths: ['read-data'], at: '/opt/c' }, { package: 'd', paths: ['x'], at: '/opt/d' }] } } } }] }));
  put('tools/e/notes.md', 'see tools/a/show/x.tsx\n');
  put('tools/e/node_modules/p/index.mjs', "import '../../../a/show/x.tsx';\n");
  assert.deepEqual(toolClosures(root), { a: ['b', 'c'], b: ['c'], c: [], d: ['c'], e: [] });
});

test('a test folder or test file names no need, while a code file beside it still does; the test names are read from the tree\'s test-helpers/test-names.json', () => {
  const root = tempFolder(join(tmpdir(), 'closures-tests-'));
  const put = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('test-helpers/test-names.json', testNames);
  const importsOf = (name, up = '../../') => `import x from '${up}${name}/read-data/y.mjs';\n`;
  for (const name of ['g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p']) put(`tools/${name}/read-data/y.mjs`, 'export const y = 1;\n');
  put('tools/f/test/a.mjs', importsOf('g'));
  put('tools/f/tests/a.mjs', importsOf('h'));
  put('tools/f/__tests__/a.mjs', importsOf('i'));
  put('tools/f/x.test.mjs', importsOf('j', '../'));
  put('tools/f/y.spec.ts', importsOf('k', '../'));
  put('tools/f/test_z.py', "import tools.l.read_data.y\nprint('tools/o/')\n");
  put('tools/f/code.mjs', importsOf('m', '../'));
  put('tools/f/tests-helper/a.mjs', importsOf('n'));
  assert.deepEqual(toolClosures(root).f, ['m', 'n']);
  put('test-helpers/test-names.json', JSON.stringify({ folders: ['checks'], files: ['*.check.*'] }));
  put('tools/f/checks/a.mjs', importsOf('l'));
  put('tools/f/y.check.mjs', importsOf('p', '../'));
  assert.deepEqual(toolClosures(root).f, ['g', 'h', 'i', 'j', 'k', 'm', 'n', 'o']);
});

test('uses_tools is set on a tool row in its own layout, replaced when it changes, removed when empty, and nothing else moves', () => {
  const spread = '{\n "records": [\n  {\n   "payload": {\n    "kind": "ai-tool-descriptor",\n    "id": "tool:x"\n   }\n  }\n ]\n}\n';
  const packed = '{"records": [{"payload": {"kind": "ai-tool-descriptor", "id": "tool:x"}}, {"payload": {"kind": "tool-row-source", "id": "s"}}]}\n';
  for (const text of [spread, packed]) {
    const one = rowsWithUses(text, ['w/a']);
    assert.deepEqual(JSON.parse(one).records[0].payload.uses_tools, ['w/a']);
    assert.equal(JSON.parse(one).records[0].payload.id, 'tool:x');
    const two = rowsWithUses(one, ['w/a', 'w/b']);
    assert.deepEqual(JSON.parse(two).records[0].payload.uses_tools, ['w/a', 'w/b']);
    assert.equal(rowsWithUses(two, ['w/a', 'w/b']), two);
    assert.equal(rowsWithUses(two, []), text);
  }
  assert.equal(JSON.parse(rowsWithUses(packed, ['w/a'])).records[1].payload.uses_tools, undefined);
});
