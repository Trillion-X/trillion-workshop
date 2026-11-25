// tools/workspace-screens/test/pages-are-the-same-wherever-they-are-built.test.mjs
//
// The front door's pages are a function of the Workshop commit alone: built twice, in two temporary folders, they are the same
// files with the same bytes, and a node_modules reached through a link names no folder of the computer that built them.
// Nov 25 2026: an apply links the Workshop's node_modules into the tree it unpacks; the icon plugin found lucide-react by
// require.resolve (the link's target) and esbuild followed links to their targets, so the builder's own folders went into the
// bundles and their content names, and every apply renamed every page bundle of the gateway (754 new names, 754 strays,
// 99 changed pages for an engine-only change).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { workspacePages } from '../web/scripts/workspace-pages.mjs';
import { installedFolder } from '../../send-to-trillion-from-my-browser/scripts/named-icons.mjs';

const fingerprint = pages => new Map(pages.map(({ page, bytes }) => [page, createHash('sha256').update(bytes).digest('hex')]));

test('the pages built twice, each in its own temporary folder, are the same files with the same bytes', { timeout: 900_000 }, () => {
  const site = { name: 'Example', cli: 'example' };
  const first = fingerprint(workspacePages('https://app.example.test', site));
  const second = fingerprint(workspacePages('https://app.example.test', site));
  assert.ok(first.size > 0);
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort(), 'the same file names');
  assert.deepEqual([...first].filter(([page, hash]) => second.get(page) !== hash).map(([page]) => page), [], 'the same bytes in every file');
});

test('an installed package is found by the path of the node_modules above the build, never the target of its link', () => {
  const place = realpathSync(mkdtempSync(join(tmpdir(), 'installed-folder-')));
  const elsewhere = join(place, 'elsewhere');
  mkdirSync(join(elsewhere, 'some-package'), { recursive: true });
  writeFileSync(join(elsewhere, 'some-package', 'package.json'), '{"name":"some-package"}');
  const tree = join(place, 'tree', 'deep', 'below');
  mkdirSync(tree, { recursive: true });
  symlinkSync(elsewhere, join(place, 'tree', 'node_modules'));
  assert.equal(installedFolder(tree, 'some-package'), join(place, 'tree', 'node_modules', 'some-package'));
  assert.throws(() => installedFolder(tree, 'not-installed'), /not-installed is not installed above/);
});

test('every esbuild build of the page makers keeps a linked folder\'s own path', () => {
  for (const file of ['build-workspace.mjs', 'screen-modules.mjs', 'harness-setup-assets.mjs']) {
    const text = readFileSync(new URL(`../web/scripts/${file}`, import.meta.url), 'utf8');
    const builds = text.split('absWorkingDir: root').length - 1;
    assert.ok(builds > 0, `${file} builds`);
    assert.equal(text.split('absWorkingDir: root, preserveSymlinks: true').length - 1, builds, `${file}: each build sets preserveSymlinks`);
  }
});

test('with preserveSymlinks, two trees whose node_modules link to different folders give the same bundle bytes and names', async () => {
  const place = realpathSync(mkdtempSync(join(tmpdir(), 'linked-trees-')));
  const tree = name => {
    const modules = join(place, `${name}-modules`, 'dep');
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, 'package.json'), '{"name":"dep","main":"index.js"}');
    writeFileSync(join(modules, 'index.js'), 'export const value = 1;\nexport const more = () => value + 1;\n');
    const root = join(place, name);
    mkdirSync(root);
    // The two files of the made-up tree, written as words so no import of this test's own names a file beside it.
    const brings = (names, from) => ['im', `port { ${names} } from ${JSON.stringify(from)};`].join('');
    writeFileSync(join(root, 'a.js'), `${brings('value', 'dep')} console.log(value); ${['im', 'port(', JSON.stringify('./b.js'), ');'].join('')}\n`);
    writeFileSync(join(root, 'b.js'), `${brings('more', 'dep')} console.log(more());\n`);
    symlinkSync(join(place, `${name}-modules`), join(root, 'node_modules'));
    return root;
  };
  const built = async root => (await build({ absWorkingDir: root, preserveSymlinks: true, entryPoints: ['a.js'], bundle: true, splitting: true, format: 'esm',
    write: false, outdir: '/out', entryNames: '[name]-[hash]', chunkNames: '[name]-[hash]', logLevel: 'silent' }))
    .outputFiles.map(file => `${file.path} ${createHash('sha256').update(file.contents).digest('hex')}`).sort();
  assert.deepEqual(await built(tree('one')), await built(tree('two')));
});
