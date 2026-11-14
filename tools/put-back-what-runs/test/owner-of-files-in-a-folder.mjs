// tools/put-back-what-runs/test/owner-of-files-in-a-folder.mjs
//
// A synthetic second owner, only for the tests: it renders files into a folder from its rows ({ folder, rows: { name: text } })
// and reads what the folder holds. Nothing in the reconciler names it; a declaration row names this module and its exports.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const read = path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

/** What the folder holds that its rows do not render: missing, changed or extra files. */
export function folderDifferences({ folder, rows }) {
  const found = Object.entries(rows).flatMap(([name, text]) => {
    const live = read(join(folder, name));
    if (live === undefined) return [{ name, reason: 'missing' }];
    return live === text ? [] : [{ name, reason: 'changed' }];
  });
  const extra = existsSync(folder) ? readdirSync(folder).filter(name => !(name in rows)) : [];
  return [...found, ...extra.map(name => ({ name, reason: 'not in the rows' }))];
}

/** Render the rows into the folder again: every row's file written, every file no row names removed. */
export function putFolderBack({ folder, rows }) {
  mkdirSync(folder, { recursive: true });
  const written = [];
  for (const [name, text] of Object.entries(rows)) if (read(join(folder, name)) !== text) { writeFileSync(join(folder, name), text); written.push(name); }
  const removed = readdirSync(folder).filter(name => !(name in rows));
  for (const name of removed) rmSync(join(folder, name));
  return { written, removed };
}
