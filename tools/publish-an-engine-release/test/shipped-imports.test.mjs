// tools/publish-an-engine-release/test/shipped-imports.test.mjs
//
// The publish tool runs on the builder from the files install ships (SHIPPED in do-work/install-a-builder.mjs). Each
// shipped .mjs file must import only files that are shipped too, and each data file it names by path must be shipped.
// A missing import crashes the receiver with ERR_MODULE_NOT_FOUND; a missing data file fails only when it is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED } from '../do-work/install-a-builder.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DO_WORK = 'tools/publish-an-engine-release/do-work';
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const DATA_PATH = /['"`]((?:test-helpers|read-data|tools)\/[^'"`\s]+\.json)['"`]/g;
const shipped = path => SHIPPED.some(entry => path === entry || path.startsWith(`${entry}/`));

test('every file the shipped publish tool imports or names by path is shipped', () => {
  const files = new Set([
    ...readdirSync(join(ROOT, DO_WORK)).filter(name => name.endsWith('.mjs')).map(name => `${DO_WORK}/${name}`),
    ...SHIPPED.filter(entry => entry.endsWith('.mjs')),
  ]);
  const missing = [];
  for (const rel of files) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    for (const [, spec] of source.matchAll(IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(rel), spec));
      if (!shipped(target)) missing.push(`${rel} imports ${target}, which install does not ship`);
    }
    for (const [, path] of source.matchAll(DATA_PATH)) {
      if (!shipped(path)) missing.push(`${rel} reads ${path}, which install does not ship`);
    }
  }
  assert.deepEqual(missing, []);
});

// A tool that reads a data file by a relative URL (new URL('../read-data/x', import.meta.url)) fails only when it runs,
// and only on a machine that has the file. Every such file must exist in the tree the commit publishes.
const DATA_URL = /new URL\(\s*['"]([^'"`$]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
const DATA_FOLDER_URL = /new URL\(\s*`(\.{1,2}\/[^`$]*\/)\$\{/g;

test('every data file a tool reads by relative URL exists in the tree', () => {
  const missing = [];
  for (const tool of readdirSync(join(ROOT, 'tools'))) {
    const doWork = join(ROOT, 'tools', tool, 'do-work');
    if (!existsSync(doWork)) continue;
    for (const name of readdirSync(doWork).filter(file => file.endsWith('.mjs'))) {
      const rel = `tools/${tool}/do-work/${name}`;
      for (const [, spec] of readFileSync(join(ROOT, rel), 'utf8').matchAll(DATA_URL)) {
        if (!/^\.{1,2}\//.test(spec)) continue;
        const target = posix.normalize(posix.join(posix.dirname(rel), spec));
        if (!existsSync(join(ROOT, target))) missing.push(`${rel} reads ${target}, which is not in the tree`);
      }
      for (const [, spec] of readFileSync(join(ROOT, rel), 'utf8').matchAll(DATA_FOLDER_URL)) {
        const folder = posix.normalize(posix.join(posix.dirname(rel), spec));
        if (!existsSync(join(ROOT, folder))) missing.push(`${rel} reads files in ${folder}, which is not in the tree`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
