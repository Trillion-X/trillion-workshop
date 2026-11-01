// tools/workflows/do-work/publish-tool-catalog.mjs
//
// published/tools.json is generated, never edited by hand: the Workshop's tool rows, flat, in the file shape a list view
// is published in (read-data/tool-catalog.mjs). Run it after any change to a tool-rows.json and commit the result.
//
//   node tools/workflows/do-work/publish-tool-catalog.mjs TOOLS_FOLDER           writes published/tools.json
//   node tools/workflows/do-work/publish-tool-catalog.mjs TOOLS_FOLDER --check   exit 1 when the file is not what the rows make
//
// TOOLS_FOLDER is the Workshop's tools folder (the one holding every tools/<name>/tool-rows.json).

import { readFileSync, writeFileSync } from 'node:fs';
import { catalogText } from '../read-data/tool-catalog.mjs';
import { committedTree } from '../read-data/committed-tree.mjs';
import { resolve, dirname } from 'node:path';

const TARGET = new URL('../published/tools.json', import.meta.url);

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2]) { console.error('Give the Workshop tools folder: node publish-tool-catalog.mjs TOOLS_FOLDER [--check]'); process.exit(2); }
  const refAt = process.argv.indexOf('--git-ref');
  if (refAt >= 0 && !process.argv[refAt + 1]) throw new Error('--git-ref requires a commit.');
  const reader = refAt < 0 ? undefined : committedTree(dirname(resolve(process.argv[2])), process.argv[refAt + 1]);
  const text = catalogText(process.argv[2], reader);
  if (process.argv.includes('--check')) {
    if (readFileSync(TARGET, 'utf8') !== text) { console.error('published/tools.json is not what the tool rows make: run publish-tool-catalog.mjs.'); process.exit(1); }
  } else writeFileSync(TARGET, text);
}
