// tools/publish-an-engine-release/test/shipped-imports.test.mjs
//
// The publish tool runs on the builder from the files install ships (SHIPPED in do-work/install-a-builder.mjs). Each
// shipped .mjs file must import only files that are shipped too, and each data file it names by path must be shipped.
// A missing import crashes the receiver with ERR_MODULE_NOT_FOUND; a missing data file fails only when it is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
