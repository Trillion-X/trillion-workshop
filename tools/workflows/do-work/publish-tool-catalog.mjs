// tools/workflows/do-work/publish-tool-catalog.mjs
//
// published/tools.json is generated, never edited by hand: the Workshop's tool rows, flat, in the file shape a list view
// is published in (read-data/tool-catalog.mjs). Run it after any change to a tool-rows.json and commit the result.
//
//   node tools/workflows/do-work/publish-tool-catalog.mjs TOOLS_FOLDER           writes published/tools.json
//   node tools/workflows/do-work/publish-tool-catalog.mjs TOOLS_FOLDER --check   exit 1 when the file is not what the rows make
//   node tools/workflows/do-work/publish-tool-catalog.mjs TOOLS_FOLDER --git-tree FULL_TREE --stdout
//     emits only catalogue JSON from that immutable tree, without changing the published file
//
// TOOLS_FOLDER is the Workshop's tools folder (the one holding every tools/<name>/tool-rows.json). A write from the
// working tree is refused while the checkout's HEAD is not origin/main (read-data/committed-tree.mjs staleCheckout).

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { catalogText } from '../read-data/tool-catalog.mjs';
import { committedTree, immutableTree, staleCheckout } from '../read-data/committed-tree.mjs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGET = new URL('../published/tools.json', import.meta.url);

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  if (!process.argv[2]) { console.error('Give the Workshop tools folder: node publish-tool-catalog.mjs TOOLS_FOLDER [--check]'); process.exit(2); }
  const refAt = process.argv.indexOf('--git-ref');
  const treeAt = process.argv.indexOf('--git-tree');
  const stdout = process.argv.includes('--stdout');
  const check = process.argv.includes('--check');
  if (refAt >= 0 && (!process.argv[refAt + 1] || process.argv[refAt + 1].startsWith('--'))) throw new Error('--git-ref requires a commit.');
  if (treeAt >= 0 && (!process.argv[treeAt + 1] || process.argv[treeAt + 1].startsWith('--'))) throw new Error('--git-tree requires a full tree identity.');
  if (refAt >= 0 && treeAt >= 0) throw new Error('Choose --git-ref or --git-tree, not both.');
  if (stdout && check) throw new Error('Choose --stdout or --check, not both.');
  if (treeAt >= 0 && !stdout) throw new Error('--git-tree requires --stdout; candidate generation never writes published files.');
  const repository = dirname(resolve(process.argv[2]));
  const reader = treeAt >= 0 ? immutableTree(repository, process.argv[treeAt + 1])
    : refAt >= 0 ? committedTree(repository, process.argv[refAt + 1]) : undefined;
  const text = catalogText(process.argv[2], reader);
  if (stdout) process.stdout.write(text);
  else if (check) {
    if (readFileSync(TARGET, 'utf8') !== text) { console.error('published/tools.json is not what the tool rows make: run publish-tool-catalog.mjs.'); process.exit(1); }
  } else {
    const stale = reader ? null : staleCheckout(repository);
    if (stale) { console.error(stale); process.exit(1); }
    writeFileSync(TARGET, text);
  }
}
