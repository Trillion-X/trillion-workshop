// test-helpers/tool-row-imports.mjs
//
// Purpose: for every ai-tool-descriptor row in a Workshop tree, follow the static and dynamic relative imports from the
// row's declared files and entry programs (invoke.argv under /opt), and report what the row's invoke.files.package_files
// does not cover. Findings: missing-relative-import (a file the program reaches is not packed), argv-not-declared (the
// entry program is not packed), bare-import-not-declared (a module name with no module entry), dangling-in-tree (a
// relative import whose target is not in the tree). Read-only; the tree is read from git at `ref`.
//
// Non-Negotiable Invariants:
//   1. A row's package_files covers every file the walk reaches through a relative import. A gap is a row the engine would
//      start without a module it needs (ERR_MODULE_NOT_FOUND on the installed snapshot).
//   2. Read from git objects at `ref`, never the working tree, so a gate judges the commit being pushed.
//
//   toolRowFindings({ repo, ref }) → { results: [{ row_file, id, status, package_files, findings, items }], shapes, byRow }
//   packageFilesByRow({ repo, ref }) → { "<row id>": [package_files items] }: the row's declared items, then a package item for
//   each file its walk reaches that no declared item covers (at /opt/<package>), then a module item (`module` with paths
//   ["."] at /opt/node_modules/<name>, or `module_tree` {name, version}) for each bare npm name it imports that the Workshop
//   lockfile pins. The publish step writes it into the archive; the walker writes nothing.
//
// Bare imports: a name in test-helpers/tool-row-imports.json `provided_by_the_system` is the system's and is skipped. Any
// other bare name is resolved through the Workshop's own lockfile (package-lock.json at ref): a package with dependencies
// there is a module_tree entry, one without is a module entry (`resolves_to` on its finding).
//
// Origin: the sweep's check-imports.mjs (inventory in the sweep lane's folder), moved here as the owner.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const SYSTEM_DATA = 'test-helpers/tool-row-imports.json';
const LOCKFILE = 'package-lock.json';

export function toolRowFindings({ repo, ref = 'HEAD' }) {
  const REF = ref;
// Read-only: for every ai-tool-descriptor row in trillion-workshop origin/main,
// follow static relative imports from the row's declared files and report any
// reached file that the row's invoke.files.package_files does not list.
// Usage: node check-imports.mjs <workshop-repo> <out.json>

const git = (args, opts = {}) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 30, ...opts });

const allFiles = git(['ls-tree', '-r', '--name-only', REF]).toString().split('\n').filter(Boolean);
const fileSet = new Set(allFiles);
const toolRowFiles = allFiles.filter((f) => /^tools\/[^/]+\/tool-rows\.json$/.test(f));
const codeFiles = allFiles.filter((f) => /^tools\/.+\.(mjs|js|cjs)$/.test(f));

// Batch-read the blobs we need (tool rows + all tool code files) in one git call.
const want = [...new Set([...toolRowFiles, ...codeFiles, SYSTEM_DATA, LOCKFILE])];
const req = Buffer.from(want.map((f) => `${REF}:${f}`).join('\n') + '\n');
const raw = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], { input: req, maxBuffer: 2 ** 31 });
const blobs = new Map();
{
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
}
const text = (f) => (blobs.get(f) ? blobs.get(f).toString('utf8') : null);
const systemNames = new Set(JSON.parse(text(SYSTEM_DATA)).provided_by_the_system);
const lockPackages = JSON.parse(text(LOCKFILE)).packages ?? {};

// The Workshop module a bare name resolves to: the lockfile's pinned version, as a module_tree when it has dependencies.
const resolvesToModule = (name) => {
  const entry = lockPackages[`node_modules/${name}`];
  if (!entry) return null;
  const kind = Object.keys(entry.dependencies ?? {}).length ? 'module_tree' : 'module';
  return { kind, name, version: entry.version };
};

// Static import specifiers (relative and bare) from JS source.
const IMPORT_RE = /(?:import\s+(?:[\w*{}\s,$]+\s+from\s+)?|export\s+[\w*{}\s,$]+\s+from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
const specsOf = (src) => {
  const out = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) out.add(m[1]);
  return [...out];
};

const isBuiltin = (s) => s.startsWith('node:') || ['fs', 'path', 'crypto', 'child_process', 'os', 'url', 'util', 'http', 'https', 'net', 'stream', 'events', 'zlib', 'buffer', 'readline', 'assert', 'worker_threads', 'module', 'tty', 'process'].includes(s);

// Expand one row's package_files into the set of workshop files it covers.
function coverageOf(entries) {
  const covers = []; // {pkg, rel, at}
  const modules = new Set();
  for (const e of entries) {
    if (e.module) { modules.add(e.module); continue; }
    if (!e.package || !e.at) continue;
    for (const p of e.paths || []) covers.push({ pkg: e.package, rel: p.replace(/\/$/, ''), at: e.at });
  }
  return { covers, modules };
}

const coveredBy = (covers, pkg, rel) => covers.some((c) => c.pkg === pkg && (rel === c.rel || rel.startsWith(c.rel + '/') || c.rel === '.' ));

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

function checkRow(rowFile, desc) {
  const rawFiles = desc.invoke?.files;
  const shape = rawFiles === undefined ? "no-files" : Array.isArray(rawFiles.package_files) ? "array" : rawFiles.package_files && typeof rawFiles.package_files === "object" ? "single-object" : "other";
  shapes[shape] = (shapes[shape] || 0) + 1;
  const pf = rawFiles?.package_files;
  const files = Array.isArray(pf) ? pf : pf && typeof pf === "object" ? [pf] : [];
  const { covers, modules } = coverageOf(files);
  const findings = [];
  const seen = new Set();
  const queue = [];
  // Roots: every code file inside a declared directory or file, plus argv scripts.
  for (const c of covers) {
    const dir = path.posix.join('tools', c.pkg, c.rel);
    const hits = fileSet.has(dir) ? [dir] : codeFiles.filter((f) => f.startsWith(dir + '/'));
    for (const h of hits) queue.push({ ws: h, from: 'declared' });
  }
  for (const a of desc.invoke?.argv || []) {
    if (typeof a !== 'string' || !a.startsWith('/opt/')) continue;
    const w = toWorkshop(a, covers);
    if (w && fileSet.has(w.ws)) queue.push({ ws: w.ws, from: 'argv' });
    else if (w && !w.declared) findings.push({ kind: 'argv-target-not-in-tree', target: a });
    // An entry program is a code file in the tree; an output or input path (out, sealed.bin) is not packed.
    if (w && fileSet.has(w.ws) && /\.(mjs|js|cjs|py|sh)$/.test(w.ws) && !coveredBy(covers, w.pkg, w.ws.split('/').slice(2).join('/'))) findings.push({ kind: 'argv-not-declared', target: a, pkg: w.pkg, needs: w.ws });
  }
  const visited = new Set();
  const needed = new Map();
  while (queue.length) {
    const { ws, from } = queue.shift();
    if (visited.has(ws)) continue;
    visited.add(ws);
    const src = text(ws);
    if (src === null) continue;
    const installed = '/opt/' + ws.replace(/^tools\//, '');
    for (const spec of specsOf(src)) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = spec.startsWith('/') ? spec : resolveRel(installed.replace(/^\/opt\//, '/opt/'), spec);
        const w = toWorkshop(target, covers);
        if (!w) continue;
        const candidates = [w.ws, w.ws + '.mjs', w.ws + '.js', w.ws + '/index.mjs', w.ws + '/index.js'];
        const hit = candidates.find((c) => fileSet.has(c));
        if (!hit) { findings.push({ kind: 'dangling-in-tree', from: ws, spec, target: w.ws }); continue; }
        const rel = hit.split('/').slice(2).join('/');
        if (!coveredBy(covers, w.pkg, rel)) {
          const key = `${ws}|${spec}`;
          if (!seen.has(key)) { seen.add(key); findings.push({ kind: 'missing-relative-import', from: ws, spec, needs: hit, pkg: w.pkg, declared_pkg: w.declared }); }
          // Keep walking the missing file so chains show up.
        }
        if (!visited.has(hit) && /\.(mjs|js|cjs)$/.test(hit)) queue.push({ ws: hit, from: ws });
      } else if (!isBuiltin(spec)) {
        const top = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (systemNames.has(top) || modules.has(top) || modules.has(spec)) continue;
        const key = `bare|${ws}|${top}`;
        const resolves = resolvesToModule(top);
        if (resolves) needed.set(top, resolves);
        if (!seen.has(key)) { seen.add(key); findings.push({ kind: 'bare-import-not-declared', from: ws, spec: top, resolves_to: resolves }); }
      }
    }
  }
  const items = [...files];
  const extra = new Map();
  for (const ws of [...visited].sort()) {
    const [, pkg, ...rest] = ws.split('/');
    const rel = rest.join('/');
    if (!fileSet.has(ws) || coveredBy(covers, pkg, rel)) continue;
    if (!extra.has(pkg)) extra.set(pkg, new Set());
    extra.get(pkg).add(rel);
  }
  for (const pkg of [...extra.keys()].sort()) items.push({ package: pkg, paths: [...extra.get(pkg)], at: `/opt/${pkg}` });
  for (const [name, resolves] of [...needed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (modules.has(name)) continue;
    const at = `/opt/node_modules/${name}`;
    items.push(resolves.kind === 'module_tree' ? { module_tree: { name, version: resolves.version }, at } : { module: name, paths: ['.'], at });
  }
  return { findings, items };
}

const results = [];
const shapes = {};
for (const rf of toolRowFiles) {
  let doc;
  try { doc = JSON.parse(text(rf)); } catch (e) { results.push({ row_file: rf, error: 'json-parse ' + e.message }); continue; }
  for (const rec of doc.records || []) {
    const d = rec.payload;
    if (!d || d.kind !== 'ai-tool-descriptor') continue;
    if (!d.invoke) { results.push({ row_file: rf, id: d.id, status: d.status, note: 'no invoke' }); continue; }
    const { findings, items } = checkRow(rf, d);
    results.push({ row_file: rf, id: d.id, status: d.status, package_files: (d.invoke.files?.package_files || []).length, findings, items });
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
