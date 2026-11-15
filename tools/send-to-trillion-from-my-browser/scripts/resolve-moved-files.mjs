// scripts/resolve-moved-files.mjs
//
// Purpose: a shared part moved here from the web client still names some of its files by the paths they had there (a
// JSON file four folders above the part, in the client's src folder). Those files moved to the tool that owns their
// feature, and that tool's moved-from.json receipt says where each went. This esbuild plugin answers an import that
// finds no file by reading the receipts, so a build needs no copy of the web client's folders.
//
// Non-negotiable invariants:
// - Only an import that finds no file is answered, and only from a receipt entry whose source path is the path the import
//   named under the web client (`web/` first, then the bare path); a path no receipt names is left to fail as it did.
// - The answer is a file that exists in this checkout; nothing is kept apart from the receipts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const RECEIPT = 'moved-from.json';

function* receipts(folder) {
  for (const name of readdirSync(folder)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(folder, name);
    if (name === RECEIPT) yield path;
    else if (statSync(path).isDirectory()) yield* receipts(path);
  }
}

/** Source path (as the web client had it) to the files that hold those bytes here, read once from every receipt. */
function homesOf(root) {
  const homes = new Map();
  for (const receipt of receipts(join(root, 'tools'))) {
    const listed = JSON.parse(readFileSync(receipt, 'utf8')).files;
    for (const file of Array.isArray(listed) ? listed : []) {
      if (!file.from || !file.to || !existsSync(join(root, file.to))) continue;
      homes.set(file.from, [...(homes.get(file.from) ?? []), file.to]);
    }
  }
  return homes;
}

export function movedFilesPlugin(root) {
  let homes = null;
  return {
    name: 'resolve-moved-files',
    setup(builder) {
      builder.onResolve({ filter: /^\.\.?\// }, args => {
        if (args.kind === 'entry-point' || !args.importer.startsWith(`${join(root, 'tools')}/`)) return undefined;
        const wanted = resolve(args.resolveDir, args.path);
        if (existsSync(wanted)) return undefined;
        const inside = relative(root, wanted);
        if (inside.startsWith('..') || inside.startsWith('tools/')) return undefined;
        homes ??= homesOf(root);
        const found = [`web/${inside}`, inside].flatMap(from => homes.get(from) ?? [])[0];
        return found ? { path: join(root, found) } : undefined;
      });
    },
  };
}
