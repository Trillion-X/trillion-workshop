// test-helpers/tool-closures.mjs
//
// Purpose: for each tool folder under tools/, the other tool folders its files need, transitively, written into the folder's
// OWN tool rows (tools/<folder>/what-this-tool-does-and-how-to-run-it.json, each ai-tool-descriptor payload's `uses_tools`) as "<source>/<tool>" ids, the
// source being this Workshop's package name. An engine that installs one tool at a time reads a tool's row alone to know
// which other tools to fetch with it; it reads no file of the Workshop's own.
//
//   toolClosures(top)         { "<folder>": ["<folder>", ...] } for every folder under <top>/tools, keys and lists sorted
//   rowsWithUses(text, uses)  the text of one what-this-tool-does-and-how-to-run-it.json with `uses_tools` set on each tool row (an empty list: absent)
//   writeUses(top)            rewrites every what-this-tool-does-and-how-to-run-it.json under <top>/tools whose text changes; returns the folders changed
//   usesProblems(top)         one line for each what-this-tool-does-and-how-to-run-it.json that is not what writeUses would write (none: they agree)
//
// A folder needs another folder when one of its files (code, build files, and json that holds relative paths) names it:
//   - a relative path (`../../ui/show/x`) that resolves into the other folder;
//   - a package path (`trillion-workshop/tools/ui/...`, `tools/ui/...`) in a code or build file;
//   - a package_files item of its what-this-tool-does-and-how-to-run-it.json whose `package` is the other folder.
// Documents (.md), held files (.held) and json data that only mentions a path as prose are not read for `tools/<name>/`.
// Test folders and test files are not read at all: a test that imports another tool is not a need of the tool it tests.
// Which names are tests is DATA in the tree (test-helpers/test-names.json: folder names, and file-name globs).
//
// Non-Negotiable Invariants:
//   1. Complete over small: a mention that is not a real import only adds a folder; a missed import fails a run.
//   2. Same source only: nothing outside the tree at `top` is read; no clock, no environment.
//   3. Deterministic bytes: sorted lists; the rest of a row file is left exactly as it was (a line is added or removed).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { CARD as ROWS_FILE } from './tool-rows.mjs';

export const USES_TOOLS = 'uses_tools';
const TEST_NAMES_FILE = join('test-helpers', 'test-names.json');
const SKIPPED_FOLDERS = new Set(['node_modules', 'target', '.git']);
const CODE = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.py', '.css', '.html', '.sh', '.rs', '.toml']);
const RELATIVE = /\.\.\/[A-Za-z0-9_@.\-/]*/g;
const ABSOLUTE = /(?:^|[^A-Za-z0-9_-])tools\/([a-z0-9][a-z0-9-]*)\//g;

const subfolders = dir => readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name));

/** The test names of the tree at `top`: folder names, and file-name patterns where `*` is any run of characters. */
function testNamesOf(top) {
  const names = JSON.parse(readFileSync(join(top, TEST_NAMES_FILE), 'utf8'));
  const pattern = glob => new RegExp(`^${glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
  return { folders: new Set(names.folders), files: names.files.map(pattern) };
}

function* filesUnder(dir, tests) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name) && !tests.folders.has(entry.name)) yield* filesUnder(join(dir, entry.name), tests);
    } else if (entry.isFile() && !tests.files.some(pattern => pattern.test(entry.name))) yield join(dir, entry.name);
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

/** The package items of one what-this-tool-does-and-how-to-run-it.json that name another tool folder. */
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
  const tests = testNamesOf(top);
  const direct = new Map();
  for (const folder of [...folders].sort()) {
    const needs = new Set();
    for (const file of filesUnder(join(toolsDir, folder), tests)) {
      const extension = extname(file);
      if (!CODE.has(extension) && extension !== '.json') continue;
      const source = readFileSync(file, 'utf8');
      if (source.includes('\0')) continue;
      for (const name of namedIn(file, source, folder, toolsDir, folders)) needs.add(name);
      if (file === join(toolsDir, folder, ROWS_FILE)) for (const name of packagesIn(source, folder, folders)) needs.add(name);
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

const sourceOf = top => JSON.parse(readFileSync(join(top, 'package.json'), 'utf8')).name;
const WHITE = /\s/;

/** The index just past the JSON value that starts at `at` (leading white space skipped). */
function valueEnd(text, at) {
  let i = at;
  while (WHITE.test(text[i])) i += 1;
  if (text[i] === '"') {
    for (i += 1; text[i] !== '"'; i += text[i] === '\\' ? 2 : 1);
    return i + 1;
  }
  if (text[i] === '{' || text[i] === '[') {
    const close = text[i] === '{' ? '}' : ']';
    i += 1;
    for (;;) {
      while (WHITE.test(text[i]) || text[i] === ',' || text[i] === ':') i += 1;
      if (text[i] === close) return i + 1;
      i = valueEnd(text, i);
    }
  }
  while (!/[\s,\]}]/.test(text[i])) i += 1;
  return i;
}

/** The direct members of the object whose `{` is at `open`: [{ key, start, end }] with the value's end. */
function members(text, open) {
  const found = [];
  let i = open + 1;
  for (;;) {
    while (WHITE.test(text[i]) || text[i] === ',') i += 1;
    if (text[i] === '}') return found;
    const start = i;
    const keyEnd = valueEnd(text, i);
    const key = JSON.parse(text.slice(start, keyEnd));
    i = keyEnd;
    while (WHITE.test(text[i]) || text[i] === ':') i += 1;
    i = valueEnd(text, i);
    found.push({ key, start, end: i });
  }
}

/** The `{` of each record's payload in a what-this-tool-does-and-how-to-run-it.json, in file order. */
function payloadOpens(text) {
  const top = members(text, text.indexOf('{'));
  const records = top.find(member => member.key === 'records');
  const opens = [];
  let i = text.indexOf('[', records.start) + 1;
  for (;;) {
    while (WHITE.test(text[i]) || text[i] === ',') i += 1;
    if (text[i] === ']') return opens;
    const payload = members(text, i).find(member => member.key === 'payload');
    opens.push(text.indexOf('{', text.indexOf(':', payload.start)));
    i = valueEnd(text, i);
  }
}

/** The text of one what-this-tool-does-and-how-to-run-it.json with each tool row's `uses_tools` (ids "<source>/<tool>") set to `uses`. */
export function rowsWithUses(text, uses) {
  const opens = payloadOpens(text).reverse();
  let out = text;
  for (const open of opens) {
    const kind = members(out, open).find(member => member.key === 'kind');
    if (!kind || !out.slice(kind.start, kind.end).endsWith('"ai-tool-descriptor"')) continue;
    const old = members(out, open).find(member => member.key === USES_TOOLS);
    if (old) {
      let { start, end } = old;
      const after = /^,\s*/.exec(out.slice(end));
      if (after) end += after[0].length;
      else start -= /,\s*$/.exec(out.slice(0, start))[0].length;
      out = out.slice(0, start) + out.slice(end);
    }
    if (!uses.length) continue;
    const layout = /^\s*\n([ \t]*)/.exec(out.slice(open + 1));
    const entry = layout
      ? `\n${layout[1]}"${USES_TOOLS}": [\n${uses.map(use => `${layout[1]}  ${JSON.stringify(use)}`).join(',\n')}\n${layout[1]}],`
      : `"${USES_TOOLS}": ${JSON.stringify(uses)}, `;
    out = `${out.slice(0, open + 1)}${entry}${out.slice(open + 1)}`;
  }
  return out;
}

function rowFiles(top) {
  return subfolders(resolve(top, 'tools')).map(entry => entry.name).sort().map(folder => [folder, join(top, 'tools', folder, ROWS_FILE)]).filter(([, file]) => existsSync(file));
}

function usesByFolder(top) {
  const source = sourceOf(top);
  const closures = toolClosures(top);
  return folder => closures[folder].map(name => `${source}/${name}`);
}

export function writeUses(top) {
  const uses = usesByFolder(top);
  const changed = [];
  for (const [folder, file] of rowFiles(top)) {
    const before = readFileSync(file, 'utf8');
    const after = rowsWithUses(before, uses(folder));
    if (after !== before) {
      writeFileSync(file, after);
      changed.push(folder);
    }
  }
  return changed;
}

export function usesProblems(top) {
  const uses = usesByFolder(top);
  return rowFiles(top).filter(([folder, file]) => {
    const text = readFileSync(file, 'utf8');
    return rowsWithUses(text, uses(folder)) !== text;
  }).map(([folder]) => `tools/${folder}/${ROWS_FILE} does not declare the tools its files use (run node test-helpers/write-pinned-files.mjs)`);
}
