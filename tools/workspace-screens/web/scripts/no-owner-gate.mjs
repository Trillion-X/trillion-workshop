// scripts/no-owner-gate.mjs
//
// PURPOSE
//   Every address a screen reads at the account's door must be a door address (/work/api/door/<method>, account-door.json
//   `form`). Any other /work/api/... address is answered no-owner (src/workspace/account-door.ts), so the screen says its
//   part is not in this version. This gate walks the code the workspace build bundles (the signed-in shell,
//   src/workspace/account-workspace.ts, and every tool's screen module) with every file those import, lists each /work/api/
//   address that is not a door address, and writes the counts per tool folder and address family to the DATA report
//   (web/dist/no-owner-report.json, or NO_OWNER_REPORT).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a tool, a screen or an address family: the walk and the scan are the same for every folder.
//   2. The baseline (scripts/no-owner-baseline.json) is the set of addresses known when the gate was written. It may only
//      shrink: an address not in it is added (refused), and an address in it that is gone is also refused until the
//      baseline is shrunk (`--shrink`). Ports remove addresses; nothing adds one.
//   3. The check is the same in the build (build-workspace.mjs) and in the test (test/no-owner-gate.test.mjs).
//
// Usage: node scripts/no-owner-gate.mjs [--shrink | --write-baseline]

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedModules, workshopRoot } from './installed-modules.mjs';
import { toolFolders } from './tool-folders.mjs';
import { screenModuleSpecs } from './screen-modules.mjs';
import { offeredRows } from '../../../../tools/keep-and-wake-ai-sessions-on-this-computer/src/workspace/offered-screens.mjs';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(WEB, 'scripts/no-owner-baseline.json');
const REPORT = process.env.NO_OWNER_REPORT ?? join(WEB, 'dist/no-owner-report.json');
const PAGE_ENTRY = join(WEB, 'src/workspace/account-workspace.ts');
const CODE = /\.(m?[jt]sx?|json)$/;
const IMPORT = /\b(?:from|import)\s*\(?\s*['"]([^'"\n]+)['"]/g;
const ADDRESS = /\/work\/api\/([^\s'"`?#)]*)/g;
const DOOR = 'door';

const isFile = path => existsSync(path) && statSync(path).isFile();

/** The file an import names, for the imports this repository's code makes: relative paths, the package's own `imports`
 *  (`#workspace/*`), and `trillion-workshop/...`. Null for an installed package, which is not this code. */
function resolveImport(spec, from, aliases, workshop) {
  let base;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('#')) {
    const alias = Object.entries(aliases).find(([name]) => name === spec || (name.endsWith('*') && spec.startsWith(name.slice(0, -1))));
    if (!alias) return null;
    base = resolve(WEB, alias[1].replace('*', spec.slice(alias[0].length - 1)));
  } else if (spec.startsWith('trillion-workshop/')) base = join(workshop, spec.slice('trillion-workshop/'.length));
  else return null;
  const bare = base.replace(/\.js$/, '');
  const candidates = [base, bare + '.ts', bare + '.tsx', bare + '.mjs', bare + '.js', bare + '.json', join(base, 'index.ts'), join(base, 'index.mjs')];
  return candidates.find(isFile) ?? null;
}

/** Every code file the entries reach through imports (each once). */
export function reachableFiles(entries, workshop) {
  const aliases = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')).imports ?? {};
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !isFile(file) || !CODE.test(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const target = resolveImport(match[1], file, aliases, workshop);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen];
}

/** The screen modules the build bundles, as files: the same specs and offered rows the build reads (build-workspace.mjs). */
export function screenModuleFiles(workshop = workshopRoot(WEB)) {
  const folders = toolFolders(undefined, WEB, installedModules(WEB), { 'trillion-workshop': workshop });
  const offered = offeredRows(workshop).filter(row => { try { return folders.packageDir(row.screen?.module?.package ?? ''); } catch { return false; } });
  return screenModuleSpecs(folders.rowFiles, offered).map(spec => join(folders.packageDir(spec.package), spec.entry));
}

/** The address a `/work/api/` string names: its path up to a query or a `${` (a part only known when the page runs, named
 *  (dynamic)), without the punctuation a sentence puts after it. The prefix alone is a constant, not a read: null. */
function addressOf(raw) {
  if (raw === '') return null;
  const path = raw.startsWith('${') ? '(dynamic)' : raw.split('${')[0].replace(/[,.;:]+$/, '');
  return `/work/api/${path}`;
}

/** The text without comments: an address in a comment is documentation, not a read the screen makes. */
const withoutComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** Each non-door address one file names: `{ address, family }` per occurrence. */
export function noOwnerAddressesIn(text) {
  const found = [];
  for (const match of withoutComments(text).matchAll(ADDRESS)) {
    const address = addressOf(match[1]);
    if (!address) continue;
    const family = address.split('/')[3] || '(dynamic)';
    if (family === DOOR) continue;
    found.push({ address, family });
  }
  return found;
}

/** The tool folder a file belongs to: the folder under tools/ it sits in ('ui' for the shared parts). */
export function folderOf(file, workshop) {
  const parts = relative(workshop, file).split(sep);
  return parts[0] === 'tools' && parts.length > 1 ? parts[1] : '(root)';
}

/** Scans the build's screen code and returns the report plus the addresses added to, or gone from, the baseline. */
export function scanNoOwnerAddresses({ workshop = workshopRoot(WEB), entries = [PAGE_ENTRY, ...screenModuleFiles(workshop)] } = {}) {
  const files = reachableFiles(entries, workshop);
  const occurrences = [];
  for (const file of files) {
    const rel = relative(workshop, file);
    for (const hit of noOwnerAddressesIn(readFileSync(file, 'utf8'))) occurrences.push({ file: rel, folder: folderOf(file, workshop), ...hit });
  }
  const folders = {};
  for (const hit of occurrences) {
    const folder = (folders[hit.folder] ??= { occurrences: 0, families: {} });
    const family = (folder.families[hit.family] ??= { count: 0, addresses: {} });
    folder.occurrences++;
    family.count++;
    family.addresses[hit.address] = (family.addresses[hit.address] ?? 0) + 1;
  }
  const keys = [...new Set(occurrences.map(hit => `${hit.file} ${hit.address}`))].sort();
  const known = JSON.parse(readFileSync(BASELINE, 'utf8')).addresses;
  const present = new Set(keys);
  const registered = new Set(known);
  const added = keys.filter(key => !registered.has(key));
  const gone = known.filter(key => !present.has(key));
  const report = {
    generated_at: new Date().toISOString(),
    _what: 'Non-door /work/api/ addresses that screens the workspace build bundles read, per tool folder and address family. The check refuses any address not in scripts/no-owner-baseline.json and any baseline address that is gone (shrink the baseline).',
    entries: entries.map(file => relative(workshop, file)),
    files_scanned: files.length,
    occurrences: occurrences.length,
    distinct_file_addresses: keys.length,
    baseline_known: known.length,
    added,
    gone,
    folders,
  };
  return { report, added, gone, keys };
}

/** Writes the DATA report; `scan` is what scanNoOwnerAddresses returned. */
export function writeReport(scan, path = REPORT) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(scan.report, null, 2)}\n`);
  return path;
}

/** Throws with the names of the addresses that must not be there. A baseline address that is gone (a port removed it)
 *  never stops a build: it is said, and `--shrink` takes it out of the baseline. */
export function assertNoOwnerGate(scan) {
  if (scan.gone.length) console.log(`no-owner: ${scan.gone.length} baseline addresses are gone from the screens; shrink scripts/no-owner-baseline.json (node scripts/no-owner-gate.mjs --shrink):\n  ${scan.gone.join('\n  ')}`);
  if (!scan.added.length) return;
  throw new Error(`New /work/api/ addresses that are not door addresses (use a tool run or the owner's own SQL, never a new route):\n  ${scan.added.join('\n  ')}`);
}

// The command line: the report, and the baseline's shrink or first write.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const scan = scanNoOwnerAddresses();
  if (mode === '--write-baseline') writeFileSync(BASELINE, `${JSON.stringify({ _what: 'The non-door /work/api/ addresses known when the no-owner gate was written. Shrink only (scripts/no-owner-gate.mjs).', addresses: scan.keys }, null, 2)}\n`);
  else if (mode === '--shrink') {
    const known = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const present = new Set(scan.keys);
    writeFileSync(BASELINE, `${JSON.stringify({ ...known, addresses: known.addresses.filter(key => present.has(key)) }, null, 2)}\n`);
  }
  const path = writeReport(scan);
  console.log(`no-owner: ${scan.report.occurrences} addresses in ${scan.report.files_scanned} files, ${scan.keys.length} distinct; report ${path}`);
  if (mode === '--shrink' || mode === '--write-baseline') process.exit(0);
  try { assertNoOwnerGate(scan); console.log('no-owner: gate passes'); }
  catch (error) { console.error(error.message); process.exit(1); }
}
