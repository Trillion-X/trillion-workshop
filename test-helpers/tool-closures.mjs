// test-helpers/tool-closures.mjs
//
// Purpose: for each tool folder under tools/, the other tool folders its files need, transitively. The engine reads the
// Workshop's tool-closures.json (written by write-pinned-files.mjs) to fetch only the folders a run of one tool needs.
//
//   toolClosures(top)    { "<folder>": ["<folder>", ...] } for every folder under <top>/tools, keys and lists sorted
//
// A folder needs another folder when one of its files (code, build files, and json that holds relative paths) names it:
//   - a relative path (`../../ui/show/x`) that resolves into the other folder;
//   - a package path (`trillion-workshop/tools/ui/...`, `tools/ui/...`) in a code or build file;
//   - a package_files item of its tool-rows.json whose `package` is the other folder.
// Documents (.md), held files (.held) and json data that only mentions a path as prose are not read for `tools/<name>/`.
//
// Non-Negotiable Invariants:
//   1. Complete over small: a mention that is not a real import only adds a folder; a missed import fails a run.
//   2. Same source only: nothing outside the tree at `top` is read; no clock, no environment.
//   3. Deterministic bytes: sorted keys, sorted lists, no timestamps.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

export const TOOL_CLOSURES = 'tool-closures.json';
const SKIPPED_FOLDERS = new Set(['node_modules', 'target', '.git']);
const CODE = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.py', '.css', '.html', '.sh', '.rs', '.toml']);
const RELATIVE = /\.\.\/[A-Za-z0-9_@.\-/]*/g;
const ABSOLUTE = /(?:^|[^A-Za-z0-9_-])tools\/([a-z0-9][a-z0-9-]*)\//g;

const subfolders = dir => readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name));

function* filesUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) yield* filesUnder(join(dir, entry.name));
    } else if (entry.isFile()) yield join(dir, entry.name);
  }
}

/** The other tool folders one file names. */
function namedIn(file, source, folder, toolsDir, folders) {
  const found = new Set();
  const extension = extname(file);
  const asCode = CODE.has(extension);
  if (!asCode && extension !== '.json') return found;
  for (const [spec] of source.matchAll(RELATIVE)) {
    const into = relative(toolsDir, resolve(dirname(file), spec));
    if (into.startsWith('..')) continue;
    const name = into.split(sep)[0];
    if (name && name !== folder && folders.has(name)) found.add(name);
  }
  if (asCode) {
    for (const [, name] of source.matchAll(ABSOLUTE)) if (name !== folder && folders.has(name)) found.add(name);
  }
  return found;
}

/** The package items of one tool-rows.json that name another tool folder. */
function packagesIn(source, folder, folders) {
  const found = new Set();
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if (Array.isArray(value.package_files)) {
        for (const item of value.package_files) if (item && typeof item.package === 'string' && item.package !== folder && folders.has(item.package)) found.add(item.package);
      }
      Object.values(value).forEach(walk);
    }
  };
  walk(JSON.parse(source));
  return found;
}

export function toolClosures(top) {
  const toolsDir = resolve(top, 'tools');
  const folders = new Set(subfolders(toolsDir).map(entry => entry.name));
  const direct = new Map();
  for (const folder of [...folders].sort()) {
    const needs = new Set();
    for (const file of filesUnder(join(toolsDir, folder))) {
      const extension = extname(file);
      if (!CODE.has(extension) && extension !== '.json') continue;
      const source = readFileSync(file, 'utf8');
      if (source.includes('\0')) continue;
      for (const name of namedIn(file, source, folder, toolsDir, folders)) needs.add(name);
      if (file === join(toolsDir, folder, 'tool-rows.json')) for (const name of packagesIn(source, folder, folders)) needs.add(name);
    }
    direct.set(folder, needs);
  }
  const tools = {};
  for (const folder of [...folders].sort()) {
    const seen = new Set();
    const queue = [...direct.get(folder)];
    while (queue.length) {
      const next = queue.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...direct.get(next));
    }
    seen.delete(folder);
    tools[folder] = [...seen].sort();
  }
  return tools;
}

/** The text of tool-closures.json for the tree at `top`. */
export const toolClosuresText = top => `${JSON.stringify({
  _what: 'For each folder under tools/, the sorted list of OTHER tool folders its files need, transitively (relative paths, tools/<name>/ paths and package_files packages), same source only. The engine reads it to fetch only a tool\'s folders. Written by test-helpers/write-pinned-files.mjs; test/tool-closures.test.mjs fails when it differs.',
  tools: toolClosures(top),
}, null, 1)}\n`;
