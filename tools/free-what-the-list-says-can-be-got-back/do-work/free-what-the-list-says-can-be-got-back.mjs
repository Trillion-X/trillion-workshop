// tools/free-what-the-list-says-can-be-got-back/do-work/free-what-the-list-says-can-be-got-back.mjs
//
// Purpose: Judge, row by row, which files or folders on the person's computer can go because their own list says how to
// get them back, check that way back NOW, and (only when asked) remove them. Mechanism only: the list's field
// names, its state words and how a source is asked are DATA (read-data/); no folder, film, tool or person is named here.
//
// Invariants:
// - Dry run is the default. Nothing moves unless the request says dry_run: false.
// - A row is freed only if every one of these holds at run time: its state is the saved word; no hold is written;
//   it names a removable path (frees is file or folder, not none); the path is inside the granted folder, is not a link,
//   and no file under it is tracked by git; at least one proof exists and every proof holds: each source address answers,
//   and each recipe file is tracked, unchanged since its last commit, and pushed; nothing under the path changed in the
//   quiet hours. Anything else stays, with the reason.
// - Disposal asks this run's authenticated native parent once. Unknown stops further disposal; no CLI fallback.
//   Moving to Trash keeps recovery and does not establish that any physical disk space was freed.
// - Each successful answer carries `next_value`, with the moved-to-Trash state. The tool does not write the list.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openParentActions } from '../../records-door/read-data/records-door.mjs';

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
  // -C alone does not bind a read: inherited GIT_DIR, index, config, namespace, shallow or object selectors can
  // silently point it elsewhere. Keep only non-Git environment, then supply our own read-only process controls.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  try {
    const out = execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.replace(/\n$/, '') };
  } catch (error) {
    return { ok: false, out: '', status: error.status, stderr: String(error.stderr ?? '').trim() };
  }
}

// A failed rev-parse is not permission to dispose. Only Git's exact non-repository result AND a readable ancestor
// walk without a repository marker establish outside-Git. A corrupt/inaccessible .git, gitfile or bare repository
// stays unknown, even if Git prints the same non-repository diagnostic. No config ownership bypass is supplied.
function repositoryAt(dir) {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (top.ok) {
    try {
      const root = realpathSync(top.out);
      const from = relative(root, realpathSync(dir));
      if (from === '..' || from.startsWith('..' + sep) || resolve(root, from) !== realpathSync(dir)) throw new Error('outside root');
      return { root };
    } catch { return { problem: 'git returned a repository root that does not contain this path' }; }
  }
  if (top.status !== 128 || top.stderr !== 'fatal: not a git repository (or any of the parent directories): .git') {
    return { problem: 'git could not establish the repository for this path' };
  }
  try {
    for (let at = realpathSync(dir); ; at = dirname(at)) {
      if (pathExists(join(at, '.git')) || (pathExists(join(at, 'HEAD')) && (pathExists(join(at, 'objects')) || pathExists(join(at, 'refs'))))) {
        return { problem: 'git repository metadata is present but could not be read as a working repository' };
      }
      // lstat's ENOENT is the only absence result accepted by pathExists; denial or another I/O failure throws.
      if (dirname(at) === at) return { root: null };
    }
  } catch { return { problem: 'git repository discovery could not read the path and its ancestors' }; }
}

function trackedProblem(path, root) {
  if (!root) return null;
  const tracked = git(root, 'ls-files', '--', relative(root, path));
  if (!tracked.ok) return 'git could not check which files under this path are tracked';
  return tracked.out ? 'git tracks files under this path' : null;
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

// Metadata observation, not a content identity or a proof of the remote bytes. Check again after asynchronous
// source checks and immediately before disposal, so a replacement or newly changed descendant stays in place.
function observePath(path) {
  const rows = [];
  function visit(full) {
    const stat = lstatSync(full, { bigint: true });
    rows.push([relative(path, full), ...['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].map(k => String(stat[k]))]);
    if (stat.isDirectory()) for (const name of readdirSync(full).sort()) visit(join(full, name));
  }
  visit(path);
  return JSON.stringify(rows);
}

function pathExists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
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

function recipeProblem(path, files, expectedRoot) {
  const dir = lstatSync(path).isDirectory() ? path : dirname(path);
  const current = repositoryAt(dir);
  if (current.problem) return current.problem;
  if (!current.root) return 'the path is not inside a git repository, so its recipe files cannot be proved';
  if (current.root !== expectedRoot) return 'the git repository changed while the way back was checked';
  const ahead = git(current.root, 'rev-list', '--count', '@{u}..HEAD');
  if (!ahead.ok || ahead.out !== '0') return 'the repository has commits that are not pushed, or no upstream';
  for (const file of files) {
    const tracked = git(current.root, 'ls-files', '--error-unmatch', '--', file);
    if (!tracked.ok) return `recipe file is not tracked or git could not check it: ${file}`;
    const status = git(current.root, 'status', '--porcelain', '--', file);
    if (!status.ok) return `git could not check whether the recipe file changed: ${file}`;
    if (status.out) return `recipe file changed since its last commit: ${file}`;
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
  if (!stat.isFile() && !stat.isDirectory()) return stay('the path is not a regular file or folder');
  if (![shape.frees_words.file, shape.frees_words.folder].includes(frees)) return stay('the row does not name file or folder disposal');
  if (stat.isDirectory() !== (frees === shape.frees_words.folder)) return stay(`the row says it frees a ${frees} but the path is not one`);
  const observed = observePath(path);
  const dir = stat.isDirectory() ? path : dirname(path);
  const repository = repositoryAt(dir);
  if (repository.problem) return stay(repository.problem);
  const tracked = trackedProblem(path, repository.root);
  if (tracked) return stay(tracked);
  const urls = f.source_urls.flatMap(name => String(value[name] ?? '').split(/\s+/)).filter(Boolean);
  const recipes = String(value[f.recipe_files] ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!urls.length && !recipes.length) return stay('nothing to check: the row has no source address, fetch source or recipe file');
  for (const url of urls) if (!(await answers(url))) return stay(`source does not answer: ${url}`);
  const current = repositoryAt(dir);
  if (current.problem) return stay(current.problem);
  if (current.root !== repository.root) return stay('the git repository changed while the way back was checked');
  const stillTracked = trackedProblem(path, current.root);
  if (stillTracked) return stay(stillTracked);
  if (recipes.length) {
    const problem = recipeProblem(path, recipes, repository.root);
    if (problem) return stay(problem);
  }
  if (now - newestChange(path) < shape.quiet_hours * 3600 * 1000) return stay(`changed in the last ${shape.quiet_hours} hours`);
  if (observePath(path) !== observed) return stay('the path changed while its way back was checked');
  return { id: row.id, free: true, bytes: bytesUnder(path), path, observed };
}

export async function run(folder, request, deps = {}) {
  if (!Array.isArray(request?.rows) || !request.rows.length || request.rows.length > MAX_ROWS) {
    throw new Refusal(`rows must be a list of 1 to ${MAX_ROWS} list rows, each { id, value }; send the list in pages of ${MAX_ROWS}`);
  }
  const dryRun = request.dry_run !== false;
  const shape = shapeOf(request.shape);
  const results = [];
  let trashedBytes = 0;
  let uncertain = false;
  for (const row of request.rows) {
    let verdict;
    try { verdict = await judgeRow(row, { folder, shape, now: deps.now, answers: deps.answers }); }
    catch (error) { verdict = { id: row.id, free: false, bytes: 0, reason: `the path could not be checked: ${error.message}` }; }
    const answer = { id: verdict.id, eligible_for_trash: verdict.free, path_bytes: verdict.free ? verdict.bytes : null };
    if (verdict.reason) answer.reason = verdict.reason;
    if (verdict.free && !dryRun) {
      if (uncertain) {
        answer.trashed = false;
        answer.trash_outcome = 'not_started';
        answer.reason = 'disposal stopped after an earlier unknown move; this path was not attempted';
        results.push(answer);
        continue;
      }
      try {
        if (insideFolder(folder, verdict.path) !== verdict.path || observePath(verdict.path) !== verdict.observed) {
          throw new Refusal('the path changed after its check');
        }
        const parent = deps.parentActions;
        if (!parent || typeof parent.trashSource !== 'function') throw new Refusal('this run has no native parent action descriptor');
        const moved = await parent.trashSource({ path: verdict.path, expected_generation: verdict.observed });
        if (moved?.outcome !== 'moved' || pathExists(verdict.path)) throw new Error('the move was not confirmed');
        answer.trashed = true;
        answer.trash_outcome = 'moved';
        trashedBytes += verdict.bytes;
        answer.next_value = { ...row.value, [shape.fields.state]: shape.states.trashed, [shape.fields.checked]: new Date().toISOString().slice(0, 10) };
      } catch (error) {
        answer.trashed = false;
        answer.trash_outcome = error instanceof Refusal || error?.outcome === 'not_started' ? 'not_started' : 'unknown';
        uncertain ||= answer.trash_outcome === 'unknown';
        answer.reason = error instanceof Refusal ? `the Trash move was not confirmed: ${error.message}`
          : uncertain ? 'the Trash move outcome is unknown; disposal stopped without retrying'
            : 'the native parent refused the Trash move; it was not confirmed';
      }
    }
    results.push(answer);
  }
  const can = results.filter(r => r.eligible_for_trash);
  return { dry_run: dryRun, rows: results, eligible_count: can.length, eligible_path_bytes: can.reduce((n, r) => n + r.path_bytes, 0), trashed_count: results.filter(r => r.trashed).length, trashed_path_bytes: trashedBytes, freed_bytes: null };
}

async function main() {
  try {
    const [folder, ...options] = process.argv.slice(2);
    if (!folder) throw new Refusal('the granted folder is missing from the command line');
    const fd = options.length === 0 ? 3
      : options.length === 2 && options[0] === '--parent-actions-fd' && /^\d+$/.test(options[1]) ? Number(options[1]) : NaN;
    if (!Number.isSafeInteger(fd) || fd < 3) throw new Refusal('the row must name its parent action descriptor');
    let parentActions;
    const deps = { get parentActions() { return parentActions ??= openParentActions({ descriptor: fd }); } };
    process.stdout.write(JSON.stringify({ result: await run(folder, JSON.parse(readFileSync(0, 'utf8')), deps) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Refusal ? error.message : `could not run: ${error.message}` }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
