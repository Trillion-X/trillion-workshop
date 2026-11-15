// scripts/tool-folders.mjs
//
// Purpose
//   Where the Workshop's shared rows and tool folders are, read from records/tool-folders.json: the files of rows to
//   load at deploy, and which folder holds each tool package by name. The open tools live in the public
//   trillion-workshop module (github.com/Trillion-X/trillion-workshop, installed by package.json); the closed parts of
//   this repository are read the same way. Nothing here names a tool, a package or a module.
//
// Non-negotiable invariants
//   1. A tool folder name is found in exactly one place; a second folder of the same name is refused, never shadowed.
//   2. A listed module that is not installed is refused with what to run, never skipped.
//   3. A folder path stays inside its repository or module: no absolute path and no "..".
//
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const inside = (path, what) => {
  if (typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`records/tool-folders.json: ${what} must be a folder inside its repository or module, not ${JSON.stringify(path)}.`);
  return path;
};

/** The files of rows and the tool folder of each package name that `folders` (records/tool-folders.json) lists. */
export function toolFolders(folders = JSON.parse(readFileSync(resolve(repo, 'records/tool-folders.json'), 'utf8')).folders, root = repo, modules = join(root, 'node_modules')) {
  const rowFiles = [];
  const packages = new Map();
  for (const folder of folders) {
    const base = folder.module === undefined ? root : resolve(modules, inside(folder.module, 'module'));
    if (!existsSync(base)) throw new Error(`The tool folders in ${folder.module} are not installed; run npm install.`);
    if (folder.rows !== undefined) {
      const named = new RegExp(folder.rows_named);
      const at = resolve(base, inside(folder.rows, 'rows'));
      rowFiles.push(...readdirSync(at).filter(name => named.test(name)).sort().map(name => join(at, name)));
    }
    if (folder.packages === undefined) continue;
    const at = resolve(base, inside(folder.packages, 'packages'));
    const excluded = folder.exclude_packages ?? [];
    if (!Array.isArray(excluded) || excluded.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name))) throw new Error('Package exclusions must name exact package folders.');
    for (const name of readdirSync(at, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
      if (excluded.includes(name)) continue;
      const where = join(at, name);
      if (packages.has(name)) throw new Error(`Two tool folders are named ${name}: ${packages.get(name)} and ${where}. Rename or remove one.`);
      packages.set(name, where);
      const rows = folder.rows_in_each_package && join(where, folder.rows_in_each_package);
      if (rows && existsSync(rows)) rowFiles.push(rows);
    }
  }
  const packageDir = name => {
    const where = packages.get(name);
    if (!where) throw new Error(`No tool folder has the package ${name}; add it to a folder listed in records/tool-folders.json.`);
    return where;
  };
  return { rowFiles, packageDir };
}
