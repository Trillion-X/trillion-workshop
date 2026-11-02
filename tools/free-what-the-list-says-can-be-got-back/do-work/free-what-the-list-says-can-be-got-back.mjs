// tools/free-what-the-list-says-can-be-got-back/do-work/free-what-the-list-says-can-be-got-back.mjs
//
// Purpose: Judge, row by row, which files or folders on the person's computer can go because their own list says how to
// get them back, check that way back NOW, and (only when asked) move them to the Trash. Mechanism only: the list's field
// names, its state words and how a source is asked are DATA (read-data/); no folder, film, tool or person is named here.
//
// Invariants:
// - Dry run is the default. Nothing moves unless the request says dry_run: false.
// - A row is freed only if every one of these holds at run time: its state is the saved word; no hold is written;
//   it names a removable path (frees is file or folder, not none); the path is inside the granted folder, is not a link,
//   and no file under it is tracked by git; at least one proof exists and every proof holds: each source address answers,
//   and each recipe file is tracked, unchanged since its last commit, and pushed; nothing under the path changed in the
//   quiet hours. Anything else stays, with the reason.
// - Removal is a move into the Trash of the path's own volume (a same-volume rename, never a copy and never rm). A refused
//   move is reported; there is no fallback.
// - Each freed answer row carries `next_value`: the row's value with its state set to the freed word, for the caller to
//   write back after reading the move back as gone. The tool does not write the list.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SHAPE = JSON.parse(readFileSync(join(HERE, '..', 'read-data', 'kept-file-shape.json'), 'utf8'));
const URL_CHECKS = JSON.parse(readFileSync(join(HERE, '..', 'read-data', 'url-checks.json'), 'utf8'));
const MAX_ROWS = 100;
const GIT_TIMEOUT_MS = 60000;
const ASK_TIMEOUT_MS = 25000;

export class Refusal extends Error {}

export function shapeOf(override = {}) {
  return {
    fields: { ...DEFAULT_SHAPE.fields, ...(override.fields ?? {}) },
    states: { ...DEFAULT_SHAPE.states, ...(override.states ?? {}) },
    frees_words: { ...DEFAULT_SHAPE.frees_words, ...(override.frees_words ?? {}) },
    quiet_hours: override.quiet_hours ?? DEFAULT_SHAPE.quiet_hours,
  };
}

function git(cwd, ...args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

/** `path` made absolute with its parent resolved, if it sits inside `folder` (the granted folder); otherwise null. */
export function insideFolder(folder, path) {
  const root = realpathSync(folder);
  const target = resolve(path);
  const real = join(realpathSync(dirname(target)), basename(target));
  return real.startsWith(root + sep) ? real : null;
}

function walk(path, visit) {
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      visit(stat);
      if (stat.isDirectory()) stack.push(full);
    }
  }
}

export function newestChange(path) {
  const top = lstatSync(path);
  let newest = top.mtimeMs;
  if (top.isDirectory()) walk(path, stat => { newest = Math.max(newest, stat.mtimeMs); });
  return newest;
}

export function bytesUnder(path) {
  const top = lstatSync(path);
  let total = top.blocks * 512;
  if (top.isDirectory()) walk(path, stat => { total += stat.blocks * 512; });
  return total;
}

export function askedAddress(url) {
  for (const row of URL_CHECKS.rows) {
    if (new RegExp(row.match).test(url)) return row.ask.replace('{encoded}', encodeURIComponent(url)).replace('{url}', url);
  }
  return null;
}

/** Does the source still answer? A 2xx or 3xx is yes; anything else, a refusal or a timeout is no. */
export async function sourceAnswers(url, fetcher = fetch) {
  const asked = askedAddress(url);
  if (!asked) return false;
  try {
    let answer = await fetcher(asked, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
    if (answer.status === 405 || answer.status === 403) answer = await fetcher(asked, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
    return answer.status >= 200 && answer.status < 400;
  } catch {
    return false;
  }
}

function recipeProblem(path, files) {
  const dir = lstatSync(path).isDirectory() ? path : dirname(path);
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (!top.ok) return 'the path is not inside a git repository, so its recipe files cannot be proved';
  const ahead = git(top.out, 'rev-list', '--count', '@{u}..HEAD');
  if (!ahead.ok || ahead.out !== '0') return 'the repository has commits that are not pushed, or no upstream';
  for (const file of files) {
    if (!git(top.out, 'ls-files', '--error-unmatch', '--', file).ok) return `recipe file is not tracked: ${file}`;
    if (git(top.out, 'status', '--porcelain', '--', file).out) return `recipe file changed since its last commit: ${file}`;
  }
  return null;
}

/** One row's verdict. `row` is { id, value }. Returns { id, free, reason?, bytes, path? }. */
export async function judgeRow(row, { folder, shape, now = Date.now(), answers = sourceAnswers }) {
  const f = shape.fields;
  const value = row.value ?? {};
  const stay = reason => ({ id: row.id, free: false, reason, bytes: Number(value[f.bytes]) || 0 });
  if (value[f.state] !== shape.states.saved) return stay('its state does not say the way back is saved');
  if (String(value[f.hold] ?? '').trim()) return stay(`held back: ${String(value[f.hold]).trim()}`);
  const frees = value[f.frees] ?? shape.frees_words.file;
  if (frees === shape.frees_words.none) return stay('the row describes a group, not a path to remove');
  const given = String(value[f.path] ?? '');
  if (!given) return stay('the row names no path');
  let path;
  try {
    path = insideFolder(folder, given);
  } catch {
    return stay('the path is not inside the granted folder or its parent is missing');
  }
  if (!path) return stay('the path is outside the granted folder');
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return stay('the path is already gone');
  }
  if (stat.isSymbolicLink()) return stay('the path is a link');
  if (stat.isDirectory() !== (frees === shape.frees_words.folder)) return stay(`the row says it frees a ${frees} but the path is not one`);
  const top = git(stat.isDirectory() ? path : dirname(path), 'rev-parse', '--show-toplevel');
  if (top.ok && git(top.out, 'ls-files', '--', relative(top.out, path)).out) return stay('git tracks files under this path');
  const urls = f.source_urls.flatMap(name => String(value[name] ?? '').split(/\s+/)).filter(Boolean);
  const recipes = String(value[f.recipe_files] ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!urls.length && !recipes.length) return stay('nothing to check: the row has no source address, fetch source or recipe file');
  for (const url of urls) if (!(await answers(url))) return stay(`source does not answer: ${url}`);
  if (recipes.length) {
    const problem = recipeProblem(path, recipes);
    if (problem) return stay(problem);
  }
  if (now - newestChange(path) < shape.quiet_hours * 3600 * 1000) return stay(`changed in the last ${shape.quiet_hours} hours`);
  return { id: row.id, free: true, bytes: bytesUnder(path), path };
}

/** The Trash folder on the path's own volume, so the move is a rename, never a copy. */
export function trashFor(path) {
  const home = homedir();
  const device = p => statSync(p).dev;
  if (device(path) === device(home)) return join(home, '.Trash');
  let mount = dirname(path);
  while (dirname(mount) !== mount && device(dirname(mount)) === device(path)) mount = dirname(mount);
  return join(mount, '.Trashes', String(process.getuid()));
}

export function moveToTrash(path, stamp = Date.now(), trash = trashFor(path)) {
  mkdirSync(trash, { recursive: true });
  const dest = join(trash, `${basename(path)} ${stamp}`);
  renameSync(path, dest);
  if (existsSync(path)) throw new Refusal(`the move did not take ${path} out of its place`);
  return dest;
}

export async function run(folder, request, deps = {}) {
  if (!Array.isArray(request?.rows) || !request.rows.length || request.rows.length > MAX_ROWS) {
    throw new Refusal(`rows must be a list of 1 to ${MAX_ROWS} list rows, each { id, value }; send the list in pages of ${MAX_ROWS}`);
  }
  const dryRun = request.dry_run !== false;
  const shape = shapeOf(request.shape);
  const results = [];
  let freed = 0;
  for (const row of request.rows) {
    const verdict = await judgeRow(row, { folder, shape, ...deps });
    const answer = { id: verdict.id, free: verdict.free, bytes: verdict.bytes };
    if (verdict.reason) answer.reason = verdict.reason;
    if (verdict.free && !dryRun) {
      try {
        answer.moved_to = moveToTrash(verdict.path, Date.now(), deps.trash);
        answer.freed = true;
        freed += verdict.bytes;
        answer.next_value = { ...row.value, [shape.fields.state]: shape.states.freed, [shape.fields.checked]: new Date().toISOString().slice(0, 10) };
      } catch (error) {
        answer.freed = false;
        answer.reason = `the move to the Trash was refused: ${error.message}`;
      }
    }
    results.push(answer);
  }
  const can = results.filter(r => r.free);
  return { dry_run: dryRun, rows: results, can_free_count: can.length, can_free_bytes: can.reduce((n, r) => n + r.bytes, 0), freed_count: results.filter(r => r.freed).length, freed_bytes: freed };
}

async function main() {
  try {
    const folder = process.argv[2];
    if (!folder) throw new Refusal('the granted folder is missing from the command line');
    process.stdout.write(JSON.stringify({ result: await run(folder, JSON.parse(readFileSync(0, 'utf8'))) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Refusal ? error.message : `could not run: ${error.message}` }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
