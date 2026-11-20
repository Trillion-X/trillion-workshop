// test-helpers/tool-row-imports.mjs
//
// Purpose: for every ai-tool-descriptor row in a Workshop tree (a row of a folder's tool-rows.json, or a row a tool-row-source
// there lists from its package's records file, as the engine reads them: see rowsOfToolFile), follow the static and dynamic relative imports from the
// row's declared files and entry programs (invoke.argv under /opt), and report what the row's invoke.files.package_files
// does not cover. Findings: missing-relative-import (a file the program reaches is not packed), argv-not-declared (the
// entry program is not packed), bare-import-not-declared (a module name with no module entry), dangling-in-tree (a
// relative import whose target is not in the tree), read-file-not-packed (a file a module reads at run time by a literal
// path is not packed: the row would start and fail reading it). A data file a module imports is reached as an import too.
// Read-only; the tree is read from git at `ref`.
//
// door-without-records (gate): the row's entry export reaches a call on the person's records door through the call graph
// (run-an-export's named export, or a direct script's top-level code), and the row declares neither invoke.records nor a
// `stored` list (the person's things it is given as values, records-door/read-data/values-door.mjs). Rows named
// in tool-row-door-exceptions.json are exempt, each with its reason. records-without-door (report only): the row declares
// invoke.records or `stored` and its entry reaches no door call. The walk follows named calls only, so a dynamic call it cannot name is
// not followed: such a row runs with no records descriptor and is refused at run time, never given broader rights.
//
// Non-Negotiable Invariants:
//   1. A row's package_files covers every file the walk reaches through a relative import. A gap is a row the engine would
//      start without a module it needs (ERR_MODULE_NOT_FOUND on the installed snapshot).
//      The walk follows .mjs, .js, .cjs and .ts files (a .ts program the engine runs through Node's type stripping is a program
//      like any other; a type-only import is erased and never followed). A package declared only at a module-style path
//      (/opt/node_modules/...) is where a bare import of its name resolves, not where a relative import from a sibling lands, so it
//      does not cover the file.
//   2. Read from git objects at `ref`, never the working tree, so a gate judges the commit being pushed.
//
//   toolRowFindings({ repo, ref }) → { results: [{ row_file, id, status, package_files, findings, items }], shapes, byRow }
//   packageFilesByRow({ repo, ref }) → { "<row id>": [package_files items] }: the row's declared items, then a package item for
//   each file its walk reaches that no declared item covers (at /opt/<package>), then, for each bare npm name it imports that
//   the Workshop lockfile pins, one packages item {packages: [<lockfile key>], at: /opt/<lockfile key>} for the module and each
//   package it needs (test-helpers/pinned-files.mjs `treeOf`), the packages the Workshop's pinned-files.json pins. The publish
//   step writes it into the archive; the walker writes nothing.
//
// Bare imports: a name in test-helpers/tool-row-imports.json `provided_by_the_system` is the system's and is skipped. Any
// other bare name is resolved through the Workshop's own lockfile (package-lock.json at ref): the module and everything it
// needs are its tree (`resolves_to` on its finding names the version).
//
// Origin: the sweep's check-imports.mjs (inventory in the sweep lane's folder), moved here as the owner.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { MODULES, SCRIPTS_NOT_NEEDED, treeOf } from './pinned-files.mjs';

const SYSTEM_DATA = 'test-helpers/tool-row-imports.json';
const PINNED_FILES = 'pinned-files.json';
const DOOR_EXCEPTIONS = 'test-helpers/tool-row-door-exceptions.json';
const LOCKFILE = 'package-lock.json';

// Static import specifiers (relative and bare) from JS source.
// Words are separated by whitespace and never contain it, so a statement can end in one way only. A statement that does not
// reach its `from` fails for every keyword inside the same run of words, so the scan skips the run once: time stays in
// proportion to the size of the source however long a run of words without punctuation it holds.
const BINDINGS = String.raw`[\w*{},$]+(?:\s+[\w*{},$]+)*`;
const KEYWORD = /import|export/g;
const STATEMENT = new RegExp(String.raw`(?:import\s+(?:${BINDINGS}\s+from\s+)?|export\s+${BINDINGS}\s+from\s+|import\s*\()\s*['"]([^'"]+)['"]`, 'y');
const DYNAMIC = /import\s*\(\s*['"]([^'"]+)['"]/y;
const RUN = /[\w*{},$\s]*/y;
const TYPE_ONLY = /^(?:import|export)\s+type\s+[{*\w]/;
export const specsOf = (src) => {
  const out = new Set();
  let skipUntil = 0;
  let k;
  KEYWORD.lastIndex = 0;
  while ((k = KEYWORD.exec(src))) {
    const pattern = k.index < skipUntil ? DYNAMIC : STATEMENT;
    pattern.lastIndex = k.index;
    const m = pattern.exec(src);
    // A type-only statement is erased before the program runs: the engine never loads its module.
    if (m) { if (!TYPE_ONLY.test(m[0])) out.add(m[1]); KEYWORD.lastIndex = pattern.lastIndex; continue; }
    if (pattern === STATEMENT) { RUN.lastIndex = k.index; RUN.exec(src); skipUntil = RUN.lastIndex; }
  }
  return [...out];
};

// Run-time file reads by a literal path: new URL('./x.json', import.meta.url), join(import.meta.dirname, 'x.json'), and
// readFileSync('./x.json') of a relative literal. An import walk never sees these, so the walker lays each literal that names
// a file of the tree beside its module (a literal that names no file is not one to lay out).
const READS = [
  /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  /(?:join|resolve)\(\s*import\.meta\.dirname\s*,\s*['"]([^'"]+)['"]/g,
  /(?:readFileSync|readFile|openSync|createReadStream)\(\s*['"](\.{1,2}\/[^'"]+)['"]/g,
];
export const readsOf = (src) => [...new Set(READS.flatMap(re => [...src.matchAll(re)].map(m => m[1])))];

// Python imports: `import x`, `import x.y as z` and `from x import y` give the top-level name; `from .x import y` and `from . import x`
// give the sibling module as './x' (and '../x' for two dots). A comment line holds none.
const PY_IMPORT = /^\s*(?:import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)|from\s+(\.*)([\w.]*)\s+import\s+([\w*(),\s]+))/;
export const pySpecsOf = (src) => {
  const out = new Set();
  for (const line of src.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(PY_IMPORT);
    if (!m) continue;
    if (m[1]) for (const part of m[1].split(',')) out.add(part.trim().split(/\s+/)[0].split('.')[0]);
    else if (m[2]) {
      const prefix = m[2].length === 1 ? './' : '../'.repeat(m[2].length - 1);
      if (m[3]) out.add(prefix + m[3].split('.').join('/'));
      else for (const name of m[4].replace(/[()]/g, '').split(',')) if (name.trim() && name.trim() !== '*') out.add(prefix + name.trim().split(/\s+as\s+/)[0]);
    } else out.add(m[3].split('.')[0]);
  }
  return [...out];
};

// Literal names a file loads: a string on a code line (a comment line holds none), with `call` when it follows `(`, `,` or `=`
// (module("find-recurring-voices.py", ...)). A spawn, an open or a path constant are all such a literal.
export const loadsOf = (src) => {
  const out = [];
  for (const line of src.split('\n')) {
    if (/^\s*(#|\/\/)/.test(line)) continue;
    for (const m of line.matchAll(/(['"])([^'"\n]{1,300})\1/g)) out.push({ literal: m[2], call: /[(,=]\s*$/.test(line.slice(0, m.index)) });
  }
  return out;
};


export function toolRowFindings({ repo, ref = 'HEAD' }) {
  const REF = ref;
// Read-only: for every ai-tool-descriptor row in trillion-workshop origin/main,
// follow static relative imports from the row's declared files and report any
// reached file that the row's invoke.files.package_files does not list.
// Usage: node check-imports.mjs <workshop-repo> <out.json>

const git = (args, opts = {}) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 30, ...opts });

// `git -C <folder>` falls through to an enclosing repository when the folder is not itself one (a scratch export inside
// another checkout), and the gate would judge that other tree's commit and report on files this tree never had. A folder
// that is not the top of a git repository is refused by name.
const top = (() => { try { return fs.realpathSync(git(['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { return null; } })();
if (top !== fs.realpathSync(repo)) throw new Error(`${repo} is not the top of a git repository${top ? ` (git resolves it to ${top})` : ''}: the gate reads git objects at ${REF}, so it judges only a repository's own commit. Commit the tree, or pass the repository that holds its commit as repo and the commit as ref.`);

const allFiles = git(['ls-tree', '-r', '--name-only', REF]).toString().split('\n').filter(Boolean);
const fileSet = new Set(allFiles);
const toolRowFiles = allFiles.filter((f) => /^tools\/[^/]+\/tool-rows\.json$/.test(f));
const codeFiles = allFiles.filter((f) => /^tools\/.+\.(mjs|js|cjs|ts|py)$/.test(f));
const PY = /\.py$/;
// The tool a workshop path belongs to: tools/<name>.
const toolOf = (file) => file.split('/').slice(0, 2).join('/');
// The tree's code files by their file name: a Python file names a sibling module or another tool's module by that name. A test's
// stand-in (test/, tests/, __tests__/) is never the module a program runs, so a name is looked up among the others only.
const codeByBase = new Map();
for (const f of codeFiles.filter((c) => !/\/(test|tests|__tests__)\//.test(c))) {
  const base = path.posix.basename(f);
  if (!codeByBase.has(base)) codeByBase.set(base, []);
  codeByBase.get(base).push(f);
}

// The blobs read so far, by workshop path. Each batch is one git call; a file a listed row source names is read in a batch of its own.
const blobs = new Map();
const readBlobs = (files) => {
  const want = [...new Set(files)].filter((f) => !blobs.has(f));
  if (want.length === 0) return;
  const req = Buffer.from(want.map((f) => `${REF}:${f}`).join('\n') + '\n');
  const raw = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], { input: req, maxBuffer: 2 ** 31 });
  let pos = 0;
  for (const f of want) {
    const nl = raw.indexOf(0x0a, pos);
    const header = raw.slice(pos, nl).toString();
    pos = nl + 1;
    const m = header.match(/ (\w+) (\d+)$/);
    if (!m) { blobs.set(f, null); continue; } // "missing"
    const size = Number(m[2]);
    blobs.set(f, raw.slice(pos, pos + size));
    pos += size + 1;
  }
};
readBlobs([...toolRowFiles, ...codeFiles, SYSTEM_DATA, PINNED_FILES, LOCKFILE, DOOR_EXCEPTIONS, 'package.json']);
const text = (f) => (blobs.get(f) ? blobs.get(f).toString('utf8') : null);

// The rows a tools folder offers, read as the engine reads them (trillion-rust src/tool_runs/tools/catalog.rs `parse` and
// `listed`; the names are tool-runs.json's `rows_file`, `row_kind`, `row_source_kind` and `source_records_file`). A folder's
// tool-rows.json is { records: [{ payload }] }: a payload of ROW_KIND is a row, and a payload of ROW_SOURCE_KIND lists the rows of
// the kind it names (list.records.kind) from list.records.file (default SOURCE_RECORDS_FILE) in the folder list.records.package:
// one .json file, or each .json file directly in a folder, every one holding `things` (else `records`) of { payload }. A row is
// kept when it has an id that holds no `/` (the engine's tool key separator); a listed row is a row of its own package's files.
const ROWS_FILE = 'tool-rows.json';
const ROW_KIND = 'ai-tool-descriptor';
const ROW_SOURCE_KIND = 'tool-row-source';
const SOURCE_RECORDS_FILE = 'records.json';
const relativeInside = (file) => !file.startsWith('/') && file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const listedFilesOf = (pkg, file) => {
  const path = `tools/${pkg}/${file}`;
  if (fileSet.has(path)) return [path];
  return allFiles.filter((f) => f.startsWith(path + '/') && !f.slice(path.length + 1).includes('/') && f.endsWith('.json')).sort();
};
// The rows one row source lists. A source the engine cannot read is left out alone, so an unreadable file gives no rows.
function listedRowsOf(source) {
  const list = source.list?.records;
  if (typeof list?.package !== 'string' || typeof list?.kind !== 'string') return [];
  const file = typeof list.file === 'string' ? list.file : SOURCE_RECORDS_FILE;
  if (!/^[^/]+$/.test(list.package) || list.package === '.' || list.package === '..' || !relativeInside(file)) return [];
  const files = listedFilesOf(list.package, file);
  readBlobs(files);
  const rows = [];
  for (const f of files) {
    let kept;
    try { kept = JSON.parse(text(f)); } catch { return []; }
    const things = kept?.things ?? kept?.records;
    for (const thing of Array.isArray(things) ? things : []) {
      if (thing?.payload?.kind === list.kind) rows.push(thing.payload);
    }
  }
  return rows;
}
// Every row a tool-rows.json offers, direct or listed, with the id the engine keys it by.
function rowsOfToolFile(rowFile) {
  const doc = JSON.parse(text(rowFile));
  const rows = [];
  for (const rec of doc.records || []) {
    const payload = rec?.payload;
    if (payload?.kind === ROW_KIND) rows.push(payload);
    else if (payload?.kind === ROW_SOURCE_KIND) rows.push(...listedRowsOf(payload));
  }
  return rows.filter((row) => typeof row.id === 'string' && row.id !== '' && !row.id.includes('/'));
}
const systemNames = new Set(JSON.parse(text(SYSTEM_DATA)).provided_by_the_system);
// Rows the function-level walk over-reports, each with the reason a reader checked it: they need no records descriptor.
const doorExceptions = new Set(text(DOOR_EXCEPTIONS) === null ? [] : Object.keys(JSON.parse(text(DOOR_EXCEPTIONS)).rows));
const lockPackages = JSON.parse(text(LOCKFILE)).packages ?? {};
const pinnedPackages = JSON.parse(text(PINNED_FILES) ?? '{}').packages ?? {};
// The Python standard library, the modules a Python file imports without a package; and the pinned packages a Python module name
// resolves to (import name -> pinned-files.json package), with the packages each pinned package needs (its wheels' requirements).
const pythonData = JSON.parse(text(SYSTEM_DATA));
const PYTHON_STDLIB = new Set(pythonData.python_stdlib);
const PYTHON_PACKAGES = pythonData.python_packages;
const PYTHON_REQUIRES = pythonData.python_requires;
const pythonClosure = (name, out = new Set()) => {
  if (out.has(name)) return out;
  out.add(name);
  for (const dependency of PYTHON_REQUIRES[name] ?? []) pythonClosure(dependency, out);
  return out;
};
// The Workshop's own package name (package.json `name`). A bare import of `<name>/tools/<package>/<path>` is a file of this tree
// that resolves under /opt/node_modules/<name>/tools/<package>: its folder is laid there whole (a module beside it, such as the
// formula engine's .wasm read through import.meta.resolve, goes with it). Without this, 1b819b955 (Nov 19 2026, 6:07 PM CST)
// left every row that reaches move-records-through-declared-states without the formula engine, and each run stopped with
// ERR_MODULE_NOT_FOUND (Cannot find package 'trillion-workshop').
const selfName = JSON.parse(text('package.json') ?? '{}').name ?? null;

// The Workshop module a bare name resolves to: the lockfile's pinned version and the lockfile keys of its tree. A module the row
// declares by name may run its install script (the owner chose it by declaring it, so its tree is kept); one the row only
// imports is refused unless install-scripts-not-needed.json names it.
const trees = new Map();
const resolvesToModule = (name, declared = new Set()) => {
  const entry = lockPackages[`${MODULES}${name}`];
  if (!entry) return null;
  const kept = declared.has(name);
  const cacheKey = `${name}|${kept}`;
  if (!trees.has(cacheKey)) {
    const notNeeded = kept ? { ...SCRIPTS_NOT_NEEDED, [`${MODULES}${name}`]: 'declared by name by the tool row' } : SCRIPTS_NOT_NEEDED;
    // A tree the lockfile cannot make (a package that runs an install script, a dependency it does not install) is a finding
    // on the row that imports it, `module-tree-refused`, and places nothing: the row runs without it, as before.
    try { trees.set(cacheKey, { name, version: entry.version, keys: treeOf(lockPackages, name, notNeeded) }); }
    catch (error) { trees.set(cacheKey, { name, version: entry.version, keys: [], refused: error.message }); }
  }
  return trees.get(cacheKey);
};

const isBuiltin = (s) => s.startsWith('node:') || ['fs', 'path', 'crypto', 'child_process', 'os', 'url', 'util', 'http', 'https', 'net', 'stream', 'events', 'zlib', 'buffer', 'readline', 'assert', 'worker_threads', 'module', 'tty', 'process'].includes(s);

// Expand one row's package_files into the set of workshop files it covers.
function coverageOf(entries) {
  const covers = []; // {pkg, rel, at}
  const modules = new Set();
  for (const e of entries) {
    // A package the row pins itself (invoke.packages, by name) resolves a bare import when its entry lays it at /opt/node_modules/<name>.
    if (e.packages) { for (const key of e.packages) { if (key.startsWith(MODULES) && !key.slice(MODULES.length).includes(MODULES)) modules.add(key.slice(MODULES.length)); else if (e.at === `/opt/${MODULES}${key}`) modules.add(key); } continue; }
    if (!e.package || !e.at) continue;
    for (const p of e.paths || []) covers.push({ pkg: e.package, rel: p.replace(/\/$/, ''), at: e.at });
  }
  return { covers, modules };
}

// A file is packed when a declared entry of its package mounts it where a relative import from a sibling finds it, under /opt
// beside the other tools. An entry for the package at a module-style path (/opt/node_modules/...) is where a bare import of the
// package name resolves, and leaves the sibling place empty: the program starts without the file, so the package name alone does
// not cover it.
const mountedAt = (covers, pkg, rel) => covers.some((c) => c.pkg === pkg && !c.at.startsWith('/opt/node_modules/') && (rel === c.rel || rel.startsWith(c.rel + '/') || c.rel === '.'));

// Map an installed absolute path to its workshop path via the row's declared roots,
// falling back to the /opt/<pkg>/ convention (installed dir name == tools/<name>).
function toWorkshop(installed, covers) {
  // The longest installed root a declared entry covers (its `at` plus one of its `paths`) names the workshop folder
  // that root is: an entry whose `at` is a subfolder of the package maps through its own paths, not the package root.
  let best = null;
  for (const c of covers) {
    const root = c.at + '/' + c.rel;
    if ((installed === root || installed.startsWith(root + '/')) && (!best || root.length > best.root.length)) best = { ...c, root };
  }
  if (best) return { pkg: best.pkg, ws: path.posix.join('tools', best.pkg, best.rel, installed.slice(best.root.length)), declared: true };
  const m = installed.match(/^\/opt\/([^/]+)\/(.*)$/);
  if (m) return { pkg: m[1], ws: path.posix.join('tools', m[1], m[2]), declared: false };
  return null;
}

function resolveRel(fromInstalled, spec) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromInstalled), spec));
}

// Function-level door reach: does the row's entry export reach a call on the records door through the call graph? A call
// is a name called in a function's own body: a function of the same file, or a named import of a relative module. A dynamic
// call the walk cannot name is not followed; that fails safe, because the row then runs without a records descriptor and is
// refused, never with broader rights.
const DOOR_TOUCH = /context\.door|openRecordsDoor\(|\bdoor\.(read|write|list|files|readRecord)\(|\breadRecord\(/;
const FN_DEF = /(?:^|[\s;{}])(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|[\s;{}])(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g;

// The balanced block that starts at the first '{' at or after `from` (approximate: strings and regexes are not skipped).
function blockFrom(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

function doorReachFor(desc, files, text, fileSet) {
  const nodes = new Map();
  const fnsOf = new Map();
  const importsOf = new Map();
  for (const file of files) {
    const src = text(file);
    if (src === null) continue;
    const local = new Map();
    for (const m of src.matchAll(FN_DEF)) {
      const name = m[1] ?? m[2];
      let body;
      if (m[1]) {
        const close = src.indexOf(')', m.index + m[0].length);
        body = blockFrom(src, close < 0 ? m.index : close);
      } else {
        const after = src.slice(m.index + m[0].length).match(/^\s*/)[0].length;
        const at = m.index + m[0].length + after;
        body = src[at] === '{' ? blockFrom(src, at) : src.slice(at, src.indexOf('\n', at) < 0 ? src.length : src.indexOf('\n', at));
      }
      if (body === null || body === undefined) body = '';
      const key = `${file}#${name}`;
      nodes.set(key, { file, name, body });
      local.set(name, key);
    }
    fnsOf.set(file, local);
    const imports = new Map();
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
      const target = [base, base + '.mjs', base + '.js', base + '.ts', base + '/index.mjs'].find(c => fileSet.has(c));
      if (!target) continue;
      for (const part of m[1].split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/).map(x => x.trim());
        if (name) imports.set(alias ?? name, `${target}#${name}`);
      }
    }
    importsOf.set(file, imports);
  }
  const edges = key => {
    const node = nodes.get(key);
    if (!node) return [];
    const out = [];
    // Over-approximation: any identifier the body names (called, passed as a value, or in an object) is an edge.
    for (const m of node.body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\b/g)) {
      const local = fnsOf.get(node.file);
      const target = local?.get(m[1]) ?? importsOf.get(node.file)?.get(m[1]);
      if (target && nodes.has(target) && target !== key) out.push(target);
    }
    return out;
  };
  // The entry: the export a run-an-export runner names, else the whole file of a direct script.
  const argv = (desc.invoke?.argv || []).filter(a => typeof a === 'string');
  const runner = argv.findIndex(a => a.endsWith('/records-door/do-work/run-an-export.mjs'));
  let start = [];
  if (runner >= 0 && argv[runner + 1] && argv[runner + 2]) {
    const file = argv[runner + 1].replace(/^\/opt\//, 'tools/');
    const name = argv[runner + 2];
    const key = `${file}#${name}`;
    // An export named as a property of an exported object (`export const tools = { name: async (...) => ... }`).
    if (!nodes.has(key) && text(file) !== null) {
      const src = text(file);
      const at = src.match(new RegExp(`(?<![\\w$.])${name}\\s*:\\s*(?:async\\s*)?(?:function\\b[^(]*)?\\(|(?<![\\w$.])${name}\\s*:\\s*(?:async\\s*)?[A-Za-z_$][\\w$]*\\s*=>`));
      if (at) {
        const from = at.index + at[0].length;
        const body = src.slice(from, from + 1).match(/[{]/) ? blockFrom(src, from) : src.slice(from, src.indexOf('\n', from) < 0 ? src.length : src.indexOf('\n', from));
        nodes.set(key, { file, name, body: body ?? '' });
      }
    }
    if (nodes.has(key)) start = [key];
    else return false;
  }
  if (start.length === 0) {
    // A direct script runs its top-level code: that is the entry, with every function body it defines left out (a function
    // runs only when a call reaches it, which the edges follow).
    const entry = argv.find(a => a.startsWith('/opt/') && /\.(mjs|js|cjs|ts|py|sh)$/.test(a));
    const file = entry ? entry.replace(/^\/opt\//, 'tools/') : null;
    const src = file ? text(file) : null;
    if (src === null) return false;
    if (!/\.(mjs|js|cjs)$/.test(file)) return DOOR_TOUCH.test(src);
    const bodies = [...nodes.values()].filter(n => n.file === file).map(n => n.body);
    let top = src;
    for (const body of bodies) if (body) top = top.replace(body, '');
    const key = `${file}#<top>`;
    nodes.set(key, { file, name: '<top>', body: top });
    fnsOf.get(file) ?? fnsOf.set(file, new Map());
    start = [key];
  }
  const seen = new Set(start);
  const queue2 = [...start];
  while (queue2.length) {
    const key = queue2.shift();
    // Taint: the door, or the context it comes from, named anywhere on the path, counts as a reach.
    if (/(?<![\w$])door(?![\w$])|(?<![\w$])context(?![\w$])/.test(nodes.get(key).body)) return true;
    for (const next of edges(key)) if (!seen.has(next)) { seen.add(next); queue2.push(next); }
  }
  return false;
}

// Each place in the run's folder is laid once. The engine never replaces a file it already laid (container.rs copy_file), and
// the files it lays are read-only, so a folder laid whole and a file inside it laid again by another item stops every run of the
// row: 17dedb039 laid formula-engine and build-a-screen-from-patches folders whole beside hand-declared files in them, and from
// Nov 19 2026 6:55 PM CST every workflow run on the Mac failed (Failure::Unavailable at copy). A path whose place is already
// laid, by itself or by a folder holding it, is dropped from the later item; an item left with no paths is dropped.
function layOnce(items) {
  const placeOf = (item, rel) => path.posix.join(item.at, rel === '.' ? '' : rel);
  const laid = [];
  for (const item of items) for (const rel of item.paths ?? []) laid.push(placeOf(item, rel));
  const held = (place, self) => laid.some((other, i) => i !== self && (place === other ? i < self : place.startsWith(other + '/')));
  let index = 0;
  const out = [];
  for (const item of items) {
    if (!item.paths) { out.push(item); continue; }
    const paths = item.paths.filter(() => !held(laid[index], index++));
    if (paths.length) out.push(paths.length === item.paths.length ? item : { ...item, paths });
  }
  return out;
}

function checkRow(rowFile, desc) {
  const rawFiles = desc.invoke?.files;
  const shape = rawFiles === undefined ? "no-files" : Array.isArray(rawFiles.package_files) ? "array" : rawFiles.package_files && typeof rawFiles.package_files === "object" ? "single-object" : "other";
  shapes[shape] = (shapes[shape] || 0) + 1;
  const pf = rawFiles?.package_files;
  const files = Array.isArray(pf) ? pf : pf && typeof pf === "object" ? [pf] : [];
  const { covers, modules } = coverageOf(files);
  // The module names the row declares by name: its invoke.packages, and the lockfile keys of its package_files packages items.
  const declared = new Set([
    ...Object.keys(desc.invoke?.packages ?? {}),
    ...files.flatMap(item => item.packages ?? []).map(key => key.startsWith(MODULES) ? key.slice(MODULES.length) : key),
  ]);
  const findings = [];
  const seen = new Set();
  const queue = [];
  // Roots: every code file inside a declared directory or file, plus argv scripts.
  for (const c of covers) {
    const dir = path.posix.join('tools', c.pkg, c.rel);
    // A Python file of a declared folder is packed with it; it is walked only where a program loads or imports it.
    const hits = fileSet.has(dir) ? [dir] : codeFiles.filter((f) => f.startsWith(dir + '/') && !PY.test(f));
    for (const h of hits) queue.push({ ws: h, from: 'declared' });
  }
  for (const a of desc.invoke?.argv || []) {
    if (typeof a !== 'string' || !a.startsWith('/opt/')) continue;
    const w = toWorkshop(a, covers);
    if (w && fileSet.has(w.ws)) queue.push({ ws: w.ws, from: 'argv' });
    else if (w && !w.declared) findings.push({ kind: 'argv-target-not-in-tree', target: a });
    // An entry program is a code file in the tree; an output or input path (out, sealed.bin) is not packed.
    if (w && fileSet.has(w.ws) && /\.(mjs|js|cjs|py|sh)$/.test(w.ws) && !mountedAt(covers, w.pkg, w.ws.split('/').slice(2).join('/'))) findings.push({ kind: 'argv-not-declared', target: a, pkg: w.pkg, needs: w.ws });
  }
  const visited = new Set();
  const readFiles = new Set();
  const needed = new Map();
  const ownFolders = new Map();
  // Python: the packages a row's Python files import, each at the folder its entry program runs from (Python finds a module in the
  // folder of its script), and the files a Python file reaches by name in the tree (reachPy).
  // The Python program the row runs: its first argv word ending in .py, relative to the row's workdir (else its own folder).
  const entryWord = (desc.invoke?.argv || []).find((a) => typeof a === 'string' && a.endsWith('.py') && !a.startsWith('-'));
  const entryPy = entryWord && (entryWord.startsWith('/') ? entryWord : path.posix.join(desc.invoke?.workdir ?? `/opt/${toolOf(rowFile).split('/')[1]}`, entryWord));
  const pyNeeds = new Map(); // `${at}|${package}` -> {at, package}
  const needPython = (name, ws, spec) => {
    const at = entryPy ? path.posix.dirname(entryPy) : '/opt/' + path.posix.dirname(ws.replace(/^tools\//, ''));
    for (const pkg of pythonClosure(name)) {
      if (!pinnedPackages[pkg]) {
        const key = `refused|${ws}|${pkg}`;
        if (!seen.has(key)) { seen.add(key); findings.push({ kind: 'module-tree-refused', from: ws, spec, why: `${pkg} is not pinned in pinned-files.json` }); }
        continue;
      }
      pyNeeds.set(`${at}|${pkg}`, { at, package: pkg });
    }
  };
  // A Python package a file imports by name: every code file under its folder is reached.
  const reachPackage = (ws, spec, dir) => {
    for (const f of codeFiles) if (f.startsWith(dir + '/')) reachPy(ws, spec, f);
  };
  const reachPy = (ws, spec, hit) => {
    const [, pkg, ...rest] = hit.split('/');
    // A file of the importing file's own tool that the row does not declare is packed (below) without a finding: only a file of
    // another tool is a cross-tool load the row must name.
    if (!mountedAt(covers, pkg, rest.join('/')) && toolOf(hit) !== toolOf(ws)) {
      const key = `cross|${ws}|${hit}`;
      if (!seen.has(key)) { seen.add(key); findings.push({ kind: 'cross-tool-load-not-declared', from: ws, spec, needs: hit, pkg }); }
    }
    if (/\.(mjs|js|cjs|ts|py)$/.test(hit)) { if (!visited.has(hit)) queue.push({ ws: hit, from: ws }); }
    else readFiles.add(hit);
  };
  while (queue.length) {
    const { ws, from } = queue.shift();
    if (visited.has(ws)) continue;
    visited.add(ws);
    const src = text(ws);
    if (src === null) continue;
    const installed = '/opt/' + ws.replace(/^tools\//, '');
    const pyFile = PY.test(ws);
    for (const spec of pyFile ? pySpecsOf(src) : specsOf(src)) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = spec.startsWith('/') ? spec : resolveRel(installed.replace(/^\/opt\//, '/opt/'), spec);
        const w = toWorkshop(target, covers);
        if (!w) continue;
        const candidates = [w.ws, w.ws + '.mjs', w.ws + '.js', w.ws + '.ts', w.ws + '.py', w.ws + '/index.mjs', w.ws + '/index.js'];
        const hit = candidates.find((c) => fileSet.has(c));
        if (!hit) { findings.push({ kind: 'dangling-in-tree', from: ws, spec, target: w.ws }); continue; }
        const rel = hit.split('/').slice(2).join('/');
        if (pyFile) { reachPy(ws, spec, hit); continue; }
        if (!mountedAt(covers, w.pkg, rel)) {
          const key = `${ws}|${spec}`;
          if (!seen.has(key)) { seen.add(key); findings.push({ kind: 'missing-relative-import', from: ws, spec, needs: hit, pkg: w.pkg, declared_pkg: w.declared }); }
          // Keep walking the missing file so chains show up.
        }
        if (!/\.(mjs|js|cjs|ts)$/.test(hit)) readFiles.add(hit);
        else if (!visited.has(hit)) queue.push({ ws: hit, from: ws });
      } else if (pyFile) {
        if (PYTHON_STDLIB.has(spec)) continue;
        const sibling = path.posix.join(path.posix.dirname(ws), `${spec}.py`);
        const siblingPackage = path.posix.join(path.posix.dirname(ws), spec, '__init__.py');
        if (fileSet.has(sibling)) { reachPy(ws, spec, sibling); continue; }
        if (fileSet.has(siblingPackage)) { reachPackage(ws, spec, path.posix.dirname(siblingPackage)); continue; }
        if (PYTHON_PACKAGES[spec]) { needPython(PYTHON_PACKAGES[spec], ws, spec); continue; }
        // A module another tool's folder holds is not on this program's path (only a literal load names it, below): a name is
        // looked up in the importing file's own tool, and is that module when the tool holds it once.
        const named = (codeByBase.get(`${spec}.py`) ?? []).filter((f) => toolOf(f) === toolOf(ws));
        const packages = (codeByBase.get('__init__.py') ?? []).filter((f) => path.posix.basename(path.posix.dirname(f)) === spec && toolOf(f) === toolOf(ws));
        const pick = (candidates) => (candidates.length === 1 ? candidates[0] : null);
        const file = pick(named);
        if (file) { reachPy(ws, spec, file); continue; }
        const init = pick(packages);
        if (init) { reachPackage(ws, spec, path.posix.dirname(init)); continue; }
        const key = `pyimport|${ws}|${spec}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push(named.length + packages.length > 1
            ? { kind: 'python-import-ambiguous', from: ws, spec, candidates: [...named, ...packages] }
            : { kind: 'python-import-unresolved', from: ws, spec });
        }
      } else if (!isBuiltin(spec)) {
        const top = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        const own = top === selfName ? spec.slice(top.length + 1).match(/^tools\/([^/]+)\/(.+)$/) : null;
        if (own) {
          const [, pkg, rel] = own;
          if (!fileSet.has(`tools/${pkg}/${rel}`)) { findings.push({ kind: 'dangling-in-tree', from: ws, spec, target: `tools/${pkg}/${rel}` }); continue; }
          const dir = path.posix.dirname(rel);
          const at = `/opt/${MODULES}${selfName}/tools/${pkg}`;
          if (!covers.some((c) => c.pkg === pkg && c.at === at && (dir === c.rel || dir.startsWith(c.rel + '/') || c.rel === '.'))) {
            if (!ownFolders.has(pkg)) ownFolders.set(pkg, new Set());
            ownFolders.get(pkg).add(dir);
          }
          continue;
        }
        if (systemNames.has(top) || modules.has(top) || modules.has(spec)) continue;
        const key = `bare|${ws}|${top}`;
        const resolves = resolvesToModule(top, declared);
        if (resolves) needed.set(top, resolves);
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ kind: 'bare-import-not-declared', from: ws, spec: top, resolves_to: resolves });
          if (resolves?.refused) findings.push({ kind: 'module-tree-refused', from: ws, spec: top, why: resolves.refused });
        }
      }
    }
    // A literal that names another tool's file or folder is a load of it: an absolute /opt path (a folder: its code files), or a
    // code file's name in a call (`call`: module("x.py", ...), path.join(HERE, '..', 'do-work', 'x.py')), which is the file in its own
    // folder, else the one the tree holds once.
    for (const { literal, call } of loadsOf(src)) {
      if (literal.startsWith('/opt/')) {
        const w = toWorkshop(literal, covers);
        if (!w) continue;
        if (fileSet.has(w.ws)) {
          if (/\.(mjs|js|cjs|ts|py)$/.test(w.ws)) { if (!visited.has(w.ws)) queue.push({ ws: w.ws, from: ws }); }
          else readFiles.add(w.ws);
        } else {
          // A folder is the place the program loads its files from by name: the files load as laid out, and the files those
          // named loads reach are walked where the literal names them (a basename below), not every file of the folder.
          const inside = codeFiles.filter((c) => c.startsWith(w.ws + '/') && !/\/(test|tests|__tests__)\//.test(c));
          if (!inside.length) continue;
          if (!mountedAt(covers, w.pkg, w.ws.split('/').slice(2).join('/'))) {
            const key = `folder|${ws}|${literal}`;
            if (!seen.has(key)) { seen.add(key); findings.push({ kind: 'cross-tool-load-not-declared', from: ws, spec: literal, needs: w.ws, pkg: w.pkg }); }
          }
          for (const f of inside) readFiles.add(f);
        }
      } else if (call && /^[\w.-]+\.(py|mjs|js|cjs|ts)$/.test(literal)) {
        // A Python file names another tool's module by its name (the one file the tree holds); a JavaScript file names its own
        // tool's file (path.join(HERE, '..', 'do-work', 'x.py')).
        // A file's own name (argparse's prog="x.py") is not a load of another file.
        if (literal === path.posix.basename(ws)) continue;
        const named = (codeByBase.get(literal) ?? []).filter((f) => f !== ws && (PY.test(ws) || toolOf(f) === toolOf(ws)));
        const hit = named.find((f) => path.posix.dirname(f) === path.posix.dirname(ws)) ?? (named.length === 1 ? named[0] : null);
        if (hit && !PY.test(ws)) { if (!visited.has(hit)) queue.push({ ws: hit, from: ws }); }
        else if (hit) reachPy(ws, literal, hit);
        else if (PY.test(ws)) {
          const key = `load|${ws}|${literal}`;
          if (!seen.has(key)) {
            seen.add(key);
            findings.push(named.length > 1
              ? { kind: 'cross-tool-load-ambiguous', from: ws, literal, candidates: named }
              : { kind: 'cross-tool-load-unresolved', from: ws, literal });
          }
        }
      }
    }
    // A file the module reads at run time (read-data/whole-file.mjs reads large-file.json) is laid out beside it, as an import is.
    for (const read of readsOf(src)) {
      const file = path.posix.normalize(path.posix.join(path.posix.dirname(ws), read));
      if (!fileSet.has(file) || /\.(mjs|js|cjs|ts)$/.test(file)) continue;
      const [, pkg, ...rest] = file.split('/');
      if (!mountedAt(covers, pkg, rest.join('/'))) {
        const key = `read|${ws}|${read}`;
        if (!seen.has(key)) { seen.add(key); findings.push({ kind: 'read-file-not-packed', from: ws, read, needs: file, pkg }); }
      }
      readFiles.add(file);
    }
  }
  const items = [...files];
  const extra = new Map();
  for (const ws of [...visited, ...readFiles].sort()) {
    const [, pkg, ...rest] = ws.split('/');
    const rel = rest.join('/');
    if (!fileSet.has(ws) || mountedAt(covers, pkg, rel)) continue;
    if (!extra.has(pkg)) extra.set(pkg, new Set());
    extra.get(pkg).add(rel);
  }
  for (const pkg of [...extra.keys()].sort()) items.push({ package: pkg, paths: [...extra.get(pkg)], at: `/opt/${pkg}` });
  for (const pkg of [...ownFolders.keys()].sort()) items.push({ package: pkg, paths: [...ownFolders.get(pkg)].sort(), at: `/opt/${MODULES}${selfName}/tools/${pkg}` });
  // Each package of a module's tree is placed once at the folder its lockfile key names: two modules that need one package
  // share its item, and a package a declared item already places is not placed again. Placed is judged by the folder (`at`),
  // never the spelling: a row declares `split2` where the lockfile key is `node_modules/split2`, and laying both at
  // /opt/node_modules/split2 made the engine refuse every run of the row (it never replaces a file it already laid out,
  // container.rs copy_file): all four noticer wakes stopped on Nov 19 2026 at 5:27 PM CST.
  const placed = new Set(files.filter(item => item.packages).map(item => item.at));
  for (const [name, resolves] of [...needed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (modules.has(name)) continue;
    for (const key of resolves.keys) {
      const at = `/opt/${key}`;
      if (placed.has(at)) continue;
      placed.add(at);
      items.push({ packages: [key], at });
    }
  }
  // A row whose entry export reaches a records door call (function level, through the call graph) needs invoke.records;
  // a row that declares invoke.records with no such call holds rights it never uses. Both are gate findings.
  const touches = doorReachFor(desc, visited, text, fileSet);
  const declares = Boolean(desc.invoke?.records) || (Array.isArray(desc.stored) && desc.stored.length > 0);
  if (!declares && touches && !doorExceptions.has(desc.id)) findings.push({ kind: 'door-without-records' });
  if (declares && !touches) findings.push({ kind: 'records-without-door' });
  // Python packages: one packages item per folder (a row may place a folder once, layoutProblems). The names a declared item at that
  // folder already lays are left out; the rest join it, or make the item.
  for (const at of [...new Set([...pyNeeds.values()].map((need) => need.at))].sort()) {
    const names = [...pyNeeds.values()].filter((need) => need.at === at).map((need) => need.package).sort();
    const existing = items.find((item) => item.packages && item.at === at);
    const missing = names.filter((name) => !(existing?.packages ?? []).includes(name));
    if (!missing.length) continue;
    if (existing) items[items.indexOf(existing)] = { ...existing, packages: [...existing.packages, ...missing] };
    else items.push({ packages: missing, at });
  }
  return { findings, items: layOnce(items) };
}

const results = [];
const shapes = {};
for (const rf of toolRowFiles) {
  let rows;
  try { rows = rowsOfToolFile(rf); } catch (e) { results.push({ row_file: rf, error: 'json-parse ' + e.message }); continue; }
  for (const d of rows) {
    if (!d.invoke) { if (d.kind === ROW_KIND) results.push({ row_file: rf, id: d.id, status: d.status, note: 'no invoke' }); continue; }
    const { findings, items } = checkRow(rf, d);
    results.push({ row_file: rf, id: d.id, status: d.status, kind: d.invoke.kind, workdir: d.invoke.workdir ?? null, argv: d.invoke.argv ?? [], package_files: (d.invoke.files?.package_files || []).length, findings, items });
  }
}
const byRow = {};
for (const row of results) {
  if (!row.items) continue;
  if (row.id in byRow) throw new Error(`two tool rows named ${row.id}`);
  byRow[row.id] = row.items;
}
return { results, shapes, byRow };
}


export const packageFilesByRow = (args) => toolRowFindings(args).byRow;

// The modules a tool row imports whose tree cannot be laid out (an install script the row does not declare, a dependency the
// lockfile does not install), one line each: the row, the module and why. The row runs without the module, so this is printed.
export const refusedModules = (args) => toolRowFindings(args).results.flatMap(row => (row.findings || [])
  .filter(f => f.kind === 'module-tree-refused')
  .map(f => `${row.id} ${f.spec}: ${f.why}`));
