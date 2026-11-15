#!/usr/bin/env node
// scripts/hooks-from-main.mjs
//
// Purpose
//   Git runs this repository's hooks (scripts/git-hooks) and the check scripts they start from a read-only export of
//   origin/main's tree kept inside .git, never from the working folder. Many chats edit the one shared checkout; while
//   core.hooksPath named the working folder, any half-written edit of a hook or a check went live for every agent at once
//   and hung their pushes (twice on 2026-10-27, the second at 6:12 PM PDT). Now a hook or a check changes only when the
//   change lands on main.
//     node scripts/hooks-from-main.mjs [--no-wait]
//   exports origin/main's tree to <git common dir>/hooks-from-main/<tree id>/ when that tree has no export yet, points
//   core.hooksPath at its scripts/git-hooks folder, removes exports no hook can still be running from, and prints the
//   hooks folder. npm install runs it (package.json prepare); scripts/advance-shared-checkout.mjs runs it after a push;
//   the reference-transaction hook runs it with --no-wait when a fetch or a push moves origin/main; scripts/commit-paths.sh
//   pushes through the folder it prints.
//
// Non-negotiable invariants
//   1. An export holds exactly the files of one tree, read from git's objects (`git cat-file --batch`), never from the
//      working folder. It is built in a folder of its own and renamed to its tree id only when complete, so a folder
//      named by a tree id is always whole. Its files are read-only (0444, 0555 when executable).
//   2. A new export starts as a copy-on-write clone of the newest existing one (APFS clonefile through
//      COPYFILE_FICLONE; a plain copy elsewhere) and only the files that differ between the two trees are written.
//      The first export writes every file.
//   3. A hook runs in the checkout git runs it in (its working directory); a check's code, and the policy it reads from
//      beside itself, come from the export. A check runs git in that working directory, never in its own folder: git hands
//      a pre-commit hook GIT_INDEX_FILE=.git/index, relative, so git run inside the export reads no index and finds nothing
//      staged. A check that reads the checkout's files asks checkoutJudged() for it. node_modules in an export is a link to
//      the checkout's own.
//   4. One build at a time (a lock folder; one older than 10 minutes was left by a stopped run). --no-wait returns at once,
//      changing nothing, while another build holds the lock. The export a hook may still be running from (the newest
//      earlier one, and any made in the last hour) is kept; older ones are removed.
//   5. No origin/main (a repository with no origin) changes nothing. A hosted build (WORKERS_CI) never commits or
//      pushes, so it exports nothing.
//   6. Only this script's own checkout is changed: git's top level must be the folder this script's scripts/ sits in.
//      A copy or export of this repository inside another repository (a lane's scratch folder) changes nothing there;
//      on 2026-10-30 a relative core.hooksPath written into trillion-rust switched off its hook chain from 08:14 to 09:20.
//      No other script sets core.hooksPath (test/hooks-from-main.test.mjs reads them). The store of invariant 7 sets no
//      core.hooksPath, and is the one way another repository asks for an export.
//   7. One owner for every repository whose hooks run only committed code. `--ref <ref> --only <folder> --no-hooks-path
//      --into <name>` exports just that folder of that ref (named by the folder's tree id) into <git common dir>/<name>/,
//      leaves core.hooksPath alone and points <git common dir>/<name>/current at the export in one rename.
//      ai-command-center runs it after each commit for HEAD's .claude/hooks (--into committed-claude-hooks, from
//      after-commit-export-the-committed-hooks.py); its loaders read committed bytes from there while every hook keeps
//      its checkout path (.claude/hooks/lib/committed_hooks.py).
//   8. A store may follow its remote: `--fetch-seconds <n>` with a `refs/remotes/<remote>/<branch>` ref first fetches that
//      branch into that ref (git objects and the one ref only: never the index or the working tree), waiting at most n
//      seconds, then exports what the ref holds. A fetch that fails (offline, a timeout, a ref lock) is loud, exits 3, and
//      still exports the last fetched ref, so `current` never goes backwards and never points at a half-written folder.
//      This is how the Workshop's tools export (committed-workshop-tools) follows origin/main with no local commit.
//
import { spawnSync } from 'node:child_process';
import { chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = 'refs/remotes/origin/main';
const EXPORTS = 'hooks-from-main';
const OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const LOCK_STALE_MS = 600_000;
const KEEP_RECENT_MS = 3_600_000;
const BLOBS_PER_READ = 1000;
const TREE_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The checkout a check judges, with no trailing separator: the one git runs the hook in when `root` (the check's own
 * repository folder) is an export, and `root` itself anywhere else.
 */
export function checkoutJudged(root) {
  const folder = resolve(root);
  return basename(dirname(folder)) === EXPORTS && TREE_ID.test(basename(folder)) ? process.cwd() : folder;
}

/** Invariant 6: the checkout this script belongs to, the folder its scripts/ sits in or, for an export, the one whose
 * git folder holds it. */
function ownCheckout(top, gitDir) {
  const folder = realpathSync(OWN_ROOT);
  if (basename(dirname(folder)) === EXPORTS && TREE_ID.test(basename(folder))) return dirname(dirname(folder)) === gitDir;
  return top === folder;
}

function git(gitDir, args, input) {
  const run = spawnSync('git', [`--git-dir=${gitDir}`, ...args], { input, maxBuffer: 1 << 30 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(run.stderr).trim()}`);
  return run.stdout;
}

/** The files of `to` that differ from `from`: [{ path, mode, blob, gone }]. */
function changes(gitDir, from, to) {
  const fields = git(gitDir, ['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', from, to]).toString('utf8').split('\0');
  const rows = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [, mode, , blob, status] = fields[at].split(' ');
    rows.push({ path: fields[at + 1], mode, blob, gone: status === 'D' || mode === '160000' });
  }
  return rows;
}

/** Removes `path`, a symlink itself and never what it points at. rmSync asks whether a path exists through its link, so
 * a link that does not resolve where the export sits (a relative link one folder deeper) was left in place and the
 * next write of that path failed EEXIST (2026-10-30). */
function removePath(path) {
  let found;
  try { found = lstatSync(path); } catch { return; }
  if (found.isSymbolicLink()) unlinkSync(path);
  else rmSync(path, { force: true, recursive: true });
}

/** Writes rows into `folder`, the blobs read by `git cat-file --batch` a thousand at a time; files are made read-only. */
function apply(gitDir, folder, rows) {
  for (const row of rows) removePath(join(folder, row.path));
  const kept = rows.filter(row => !row.gone);
  for (let from = 0; from < kept.length; from += BLOBS_PER_READ) {
    const part = kept.slice(from, from + BLOBS_PER_READ);
    const out = git(gitDir, ['cat-file', '--batch'], `${part.map(row => row.blob).join('\n')}\n`);
    let at = 0;
    for (const row of part) {
      const end = out.indexOf(10, at);
      const size = Number(out.toString('utf8', at, end).split(' ')[2]);
      const bytes = out.subarray(end + 1, end + 1 + size);
      at = end + 1 + size + 1;
      const file = join(folder, row.path);
      mkdirSync(dirname(file), { recursive: true });
      if (row.mode === '120000') symlinkSync(bytes.toString('utf8'), file);
      else { writeFileSync(file, bytes); chmodSync(file, row.mode === '100755' ? 0o555 : 0o444); }
    }
  }
}

/** The first path of `tree` that `folder` does not hold (a symlink counts as held), or null when it holds them all. */
function missingFrom(gitDir, folder, tree) {
  for (const row of git(gitDir, ['ls-tree', '-r', '-z', tree]).toString('utf8').split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    if (row.startsWith('160000')) continue;
    try { lstatSync(join(folder, row.slice(tab + 1))); } catch { return row.slice(tab + 1); }
  }
  return null;
}

/** Takes the build lock; false when `wait` is off and another build holds it. */
function lock(path, wait) {
  for (let waited = 0; ; waited += 200) {
    try { mkdirSync(path); return true; } catch {
      try { if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) { rmdirSync(path); continue; } } catch { continue; }
      if (!wait) return false;
      if (waited >= LOCK_STALE_MS) throw new Error(`another build has held ${path} for 10 minutes`);
      sleep(200);
    }
  }
}

/** Points <exports>/current at `name` in one rename, so a reader sees the old export or the new one, never neither. */
function pointCurrent(exports, name) {
  const next = join(exports, `.current-${process.pid}`);
  rmSync(next, { force: true });
  symlinkSync(name, next);
  renameSync(next, join(exports, 'current'));
}

/** Builds (when missing) the export of `tree` under `exports`, and removes the ones no hook can still be running from. */
function exportTree({ gitDir, exports, tree, checkout, wait, whole = true, current = false }) {
  const folder = join(exports, tree);
  const held = join(exports, '.lock');
  mkdirSync(exports, { recursive: true });
  if (!lock(held, wait)) return null;
  try {
    const built = readdirSync(exports).filter(name => TREE_ID.test(name)).map(name => ({ name, at: statSync(join(exports, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    if (!existsSync(folder)) {
      const building = join(exports, `.building-${process.pid}`);
      // A new export is copied from the newest earlier one, so its files are only as whole as that one was. It is checked
      // against the tree's own file list before it takes a tree id's name, and one that is short is rebuilt from nothing:
      // a partial export can never become `current` (2026-11-03: two stores were left with 11 and 22 files).
      for (const seed of [built[0]?.name, undefined]) {
        rmSync(building, { force: true, recursive: true });
        if (seed) cpSync(join(exports, seed), building, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
        else mkdirSync(building);
        apply(gitDir, building, changes(gitDir, seed ?? EMPTY_TREE, tree));
        const missing = missingFrom(gitDir, building, tree);
        if (missing === null) break;
        if (!seed) throw new Error(`the export of ${tree} is missing ${missing} after a full write`);
      }
      if (whole) {
        rmSync(join(building, 'node_modules'), { force: true, recursive: true });
        if (existsSync(join(checkout, 'node_modules'))) symlinkSync(join(checkout, 'node_modules'), join(building, 'node_modules'));
      }
      renameSync(building, folder);
    }
    if (current) pointCurrent(exports, tree);
    const now = Date.now();
    const previous = built.find(one => one.name !== tree)?.name;
    for (const name of readdirSync(exports)) {
      const old = join(exports, name);
      const removable = TREE_ID.test(name) ? name !== tree && name !== previous && now - statSync(old).mtimeMs > KEEP_RECENT_MS
        : (name.startsWith('.building-') || name.startsWith('.removing-')) && now - statSync(old).mtimeMs > LOCK_STALE_MS;
      if (!removable) continue;
      // A folder named by a tree id is always whole (invariant 1) and the next build copies the newest one. Finder writes
      // a .DS_Store into a folder while it is being removed and fails the removal part way, which left an emptied
      // tree-id folder that seeded an export with almost no files (2026-11-03). So the name goes first, in one rename.
      const going = TREE_ID.test(name) ? join(exports, `.removing-${name}`) : old;
      if (going !== old) renameSync(old, going);
      try { rmSync(going, { force: true, recursive: true }); } catch { /* left under its dotted name; the next build retries */ }
    }
  } finally { rmdirSync(held); }
  return folder;
}

/**
 * Exports `ref`'s tree, points core.hooksPath at its hooks folder and returns that folder. Returns null with no `ref`,
 * or when `wait` is off and another build holds the lock.
 *
 * With `only` (a folder of the tree) the export holds just that folder's committed files, named by its tree id, and with
 * `hooks` null core.hooksPath is left alone: the export is a store of committed bytes that the caller's own loaders read,
 * found through <git common dir>/<into>/current (ai-command-center: HEAD's .claude/hooks in committed-claude-hooks, read
 * by .claude/hooks/lib/committed_hooks.py, so its hooks keep their checkout paths and run only committed code).
 */
export function hooksFromMain({ wait = true, ref = MAIN, only = '', hooks = 'scripts/git-hooks', into = EXPORTS } = {}) {
  const facts = spawnSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-path',
    'hooks', only ? `${ref}:${only}` : `${ref}^{tree}`], { encoding: 'utf8' });
  const [top, common, configured, tree] = facts.stdout.trim().split('\n');
  if (facts.status !== 0 || !TREE_ID.test(tree ?? '')) return null;
  const gitDir = realpathSync(common);
  if (hooks !== null && !ownCheckout(realpathSync(top), gitDir)) return null;
  const folder = exportTree({ gitDir, exports: join(gitDir, into), tree, checkout: dirname(gitDir), wait,
    whole: !only, current: hooks === null });
  if (!folder || hooks === null) return folder;
  const hooksFolder = join(folder, hooks);
  if (configured !== hooksFolder) git(gitDir, ['config', '--local', 'core.hooksPath', hooksFolder]);
  return hooksFolder;
}

/** Fetches `ref`'s branch from its remote into `ref`; null when it worked, else what went wrong. */
function fetchRef(ref, seconds) {
  const named = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
  if (!named) return `--fetch-seconds needs a refs/remotes/<remote>/<branch> ref, not ${ref}`;
  const [, remote, branch] = named;
  const run = spawnSync('git', ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remote, `+refs/heads/${branch}:${ref}`],
    { encoding: 'utf8', timeout: seconds * 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (run.status === 0) return null;
  return `fetch of ${remote} ${branch} ${run.error?.code === 'ETIMEDOUT' ? `took more than ${seconds} seconds` : `failed: ${String(run.stderr).trim().replace(/\s+/g, ' ')}`}`;
}

/** The value after `name` in `argv`, or undefined. */
const option = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && !process.env.WORKERS_CI) {
  try {
    const argv = process.argv.slice(2);
    const ref = option(argv, '--ref');
    const seconds = Number(option(argv, '--fetch-seconds') ?? 0);
    const fetchFailure = seconds > 0 ? fetchRef(ref ?? MAIN, seconds) : null;
    const hooks = hooksFromMain({ wait: !argv.includes('--no-wait'), ref: ref ?? MAIN, only: option(argv, '--only') ?? '',
      hooks: argv.includes('--no-hooks-path') ? null : 'scripts/git-hooks', into: option(argv, '--into') ?? EXPORTS });
    if (hooks) process.stdout.write(`${hooks}\n`);
    if (fetchFailure) {
      process.stderr.write(`hooks-from-main: ${fetchFailure}; exported ${ref ?? MAIN} as last fetched, which may be behind the remote\n`);
      process.exitCode = 3;
    } else if (!hooks) process.stderr.write(`hooks-from-main: not this script's own checkout, no ${ref ?? 'origin/main'} here, or another build is running; core.hooksPath is left as it is.\n`);
  } catch (error) {
    process.stderr.write(`hooks-from-main: ${error.message}\n`);
    process.exitCode = 1;
  }
}
