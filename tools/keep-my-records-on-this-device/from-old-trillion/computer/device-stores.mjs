// computer/device-stores.mjs
//
// PURPOSE
//   One list of everything the Trillion programs keep on this computer (computer/device-stores.json), and one engine that
//   audits it and puts it right: who may read each file, how long it may stay, whether content is sealed, and whether
//   anything lies under a Trillion root that no row accounts for. It is the install layout's self-repair: a drifted mode,
//   a missing folder, a changed link or an expired file is found and fixed at the start, with a receipt, not discovered
//   when a tool later fails or a stranger reads a file.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no store is named here. A row is a path, a kind (file, dir or link), what it holds, its mode, its
//      child_mode, its retention_days, and whether it is sealed ("sealed": true for content kept by computer/sealed-log.mjs).
//   2. Nothing is read: audit and repair look at names, modes, links and dates only, never at what a file holds.
//   3. Repair never deletes what no row names, never follows a link out of a root, and deletes only what a row's
//      retention_days says has expired. An unlisted path is reported, not touched.
//   4. Every repair is written to the receipt, so what changed can be read afterwards.
//
import { chmodSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, workerData } from 'node:worker_threads';

const HERE = dirname(fileURLToPath(import.meta.url));
export const storeSettings = () => JSON.parse(readFileSync(join(HERE, 'device-stores.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const modeText = mode => (mode & 0o777).toString(8).padStart(4, '0');
const loose = (have, want) => (have & ~parseInt(want, 8) & 0o777) !== 0;
const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

/** The rows that cover `path` (home-relative): its own, or the folder it is beneath, or a name-prefix sibling. */
function coveredBy(rows, relative) {
  return rows.filter(row => relative === row.path || (row.kind === 'dir' && relative.startsWith(`${row.path}${sep}`))
    || (row.name_prefix && dirname(relative) === dirname(row.path) && basename(relative).startsWith(basename(row.path)))).sort((a, b) => b.path.length - a.path.length)[0];
}

function* walk(path, relative) {
  const found = stat(path);
  if (!found) return;
  yield { path, relative, stats: found };
  if (found.isDirectory() && !found.isSymbolicLink()) for (const name of readdirSync(path)) yield* walk(join(path, name), join(relative, name));
}

export function makeDeviceStores({ settings = storeSettings(), home = homedir(), now = () => Date.now() } = {}) {
  const abs = relative => join(home, relative);
  const entries = row => {
    const base = abs(row.path);
    const prefixed = row.name_prefix ? readdirSync(dirname(base)).filter(name => name.startsWith(basename(row.path))).map(name => join(dirname(row.path), name)) : [row.path];
    return prefixed.flatMap(relative => [...walk(abs(relative), relative)]);
  };
  const wantedMode = (row, entry) => {
    if (entry.relative === row.path || (row.name_prefix && dirname(entry.relative) === dirname(row.path))) return row.mode ?? (entry.stats.isDirectory() ? settings.defaults.dir_mode : settings.defaults.file_mode);
    return entry.stats.isDirectory() ? (row.mode ?? settings.defaults.dir_mode) : row.child_mode;
  };

  /** What differs from the list, and what lies under a root that no row names. Looks at names, modes, links and dates. */
  function audit() {
    const problems = [];
    for (const row of settings.rows) {
      const top = stat(abs(row.path));
      if (row.kind === 'link') {
        if (!top || !top.isSymbolicLink() || readlinkSync(abs(row.path)) !== abs(row.link_target ?? '')) problems.push({ id: row.id, problem: 'wrong_link', path: abs(row.path), want: abs(row.link_target ?? ''), said: fill(settings.words.wrong_link, { path: abs(row.path), want: abs(row.link_target ?? '') }) });
        continue;
      }
      if (!top && !row.name_prefix) { if (row.create) problems.push({ id: row.id, problem: 'missing', path: abs(row.path), said: fill(settings.words.missing, { path: abs(row.path) }) }); continue; }
      const kept = entries(row);
      if (row.holds === 'content' && row.sealed !== true && kept.length) problems.push({ id: row.id, problem: 'plaintext_content', path: abs(row.path), said: fill(settings.words.plaintext_content, { id: row.id }) });
      for (const entry of kept) {
        const want = wantedMode(row, entry);
        if (want && !entry.stats.isSymbolicLink() && loose(entry.stats.mode, want)) problems.push({ id: row.id, problem: 'wrong_mode', path: entry.path, have: modeText(entry.stats.mode), want, said: fill(settings.words.wrong_mode, { path: entry.path, have: modeText(entry.stats.mode), want }) });
        if (row.retention_days && !entry.stats.isDirectory() && now() - entry.stats.mtimeMs > row.retention_days * 86_400_000) problems.push({ id: row.id, problem: 'expired', path: entry.path, said: fill(settings.words.expired, { path: entry.path, days: row.retention_days }) });
      }
    }
    for (const root of settings.roots) {
      const top = stat(abs(root));
      if (!top?.isDirectory()) continue;
      for (const name of readdirSync(abs(root))) {
        const relative = join(root, name);
        if (!coveredBy(settings.rows, relative)) problems.push({ id: null, problem: 'unlisted', path: abs(relative), said: fill(settings.words.unlisted, { path: abs(relative) }) });
      }
    }
    const counts = {};
    for (const { problem } of problems) counts[problem] = (counts[problem] ?? 0) + 1;
    return { ok: problems.length === 0, counts, problems };
  }

  /** Puts right what a row says: folders made, modes tightened, links remade, expired files deleted; writes the receipt. */
  function repair({ only = null } = {}) {
    const before = audit();
    const done = [];
    for (const row of settings.rows) {
      if (only && !only.includes(row.id)) continue;
      if (row.kind === 'link') {
        const target = abs(row.link_target ?? ''), top = stat(abs(row.path));
        if (top && !top.isSymbolicLink()) continue;
        if (top && readlinkSync(abs(row.path)) === target) continue;
        if (top) unlinkSync(abs(row.path));
        mkdirSync(dirname(abs(row.path)), { recursive: true, mode: 0o700 });
        symlinkSync(target, abs(row.path));
        done.push({ id: row.id, did: 'link', path: abs(row.path) });
        continue;
      }
      if (!stat(abs(row.path)) && row.create && row.kind === 'dir') { mkdirSync(abs(row.path), { recursive: true, mode: parseInt(row.mode ?? settings.defaults.dir_mode, 8) }); done.push({ id: row.id, did: 'made', path: abs(row.path) }); }
      for (const entry of entries(row)) {
        if (row.retention_days && !entry.stats.isDirectory() && now() - entry.stats.mtimeMs > row.retention_days * 86_400_000) {
          rmSync(entry.path, { force: true }); done.push({ id: row.id, did: 'deleted', path: entry.path }); continue;
        }
        const want = wantedMode(row, entry);
        if (want && !entry.stats.isSymbolicLink() && loose(entry.stats.mode, want)) { chmodSync(entry.path, parseInt(want, 8)); done.push({ id: row.id, did: 'mode', path: entry.path, from: modeText(entry.stats.mode), to: want }); }
      }
    }
    const receipt = { at: new Date(now()).toISOString(), repaired: done, still: audit().problems.filter(problem => ['unlisted', 'plaintext_content'].includes(problem.problem)) };
    mkdirSync(dirname(abs(settings.receipt)), { recursive: true, mode: 0o700 });
    writeFileSync(abs(settings.receipt), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    return { repaired: done, before: before.problems.length, said: fill(settings.words.repaired, { count: done.length }) };
  }

  return { audit, repair };
}

let shared = null;
const storesHere = () => (shared ??= makeDeviceStores());

/** Looks at every store in a worker of its own (a walk of a large folder must not stop the host), writes counts and the first
 *  problems to `audit_file`, and repairs only the rows `repair_at_start` names (none by default: a repair of every file runs only
 *  when asked for by name). Answers at once; the worker's summary is read from the file. */
function startAudit(settings = storeSettings(), home = homedir()) {
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { audit_at_start: true, home } });
  worker.on('error', () => {});
  worker.unref();
  return { started: true, audit_file: join(home, settings.audit_file) };
}

if (!isMainThread && workerData?.audit_at_start) {
  const settings = storeSettings();
  const stores = makeDeviceStores({ settings, home: workerData.home });
  const only = settings.repair_at_start ?? [];
  const repaired = only.length ? stores.repair({ only }) : null;
  const found = stores.audit();
  const file = join(workerData.home, settings.audit_file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ok: found.ok, counts: found.counts, first: found.problems.slice(0, settings.audit_sample), ...(repaired ? { repaired: repaired.repaired.length } : {}) }, null, 2) + '\n', { mode: 0o600 });
}

/** One tool for the person's files: { action: audit | repair, only?: [row ids] }. A repair with no `only` repairs every row (it is asked for by name, never at start). */
async function manage({ action = 'audit', only } = {}) {
  if (action === 'audit') return storesHere().audit();
  if (action === 'repair') return storesHere().repair({ only: Array.isArray(only) && only.length ? only : null });
  throw Object.assign(new Error(`There is no files action named ${action}. Use audit or repair.`), { status: 400, retry: false });
}

export const deviceStoreTools = { manage, audit: () => storesHere().audit(), repair: input => storesHere().repair(input ?? {}), start: () => startAudit() };
