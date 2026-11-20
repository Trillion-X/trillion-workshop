// scripts/advance-shared-checkout.mjs in real repositories with a real origin and the reference-transaction hook
// installed: HEAD moves to origin/main by compare-and-swap, files equal to HEAD get main's bytes, and every local
// version (edited, staged, untracked in main's way) is kept, listed and saved under refs/rescue/advance-*.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { advanceCheckout } from '../scripts/advance-shared-checkout.mjs';
import { fixtureGitEnv } from './support/fixture-git-env.mjs';

const ADVANCE = new URL('../scripts/advance-shared-checkout.mjs', import.meta.url).pathname;
const SCRIPTS = new URL('../scripts', import.meta.url).pathname;
const HOOK = new URL('../scripts/git-hooks/reference-transaction', import.meta.url).pathname;
const env = fixtureGitEnv();
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
/** Write each file; a value { text, exec: true } is an executable file. */
const write = (dir, files) => {
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), value.text ?? value);
    if (value.exec) chmodSync(join(dir, path), 0o755);
  }
};

/** An origin whose main moves from `before` to `after`, and a shared checkout cloned at `before` carrying the hook. */
function repos(before, after) {
  const root = tempFolder(join(tmpdir(), 'advance-shared-checkout-'));
  const origin = join(root, 'origin.git'), work = join(root, 'work'), other = join(root, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, other]);
  write(other, before); git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'before'); git(other, 'push', '-q', 'origin', 'HEAD:main');
  execFileSync('git', ['clone', '-q', origin, work]);
  // This checkout's scripts/ (what the hook runs: its check list, the one-checkout and current-main checks), with only
  // the reference-transaction hook installed, so the move is judged as in the shared checkout and nothing else runs.
  cpSync(SCRIPTS, join(work, 'scripts'), { recursive: true, filter: source => !source.startsWith(join(SCRIPTS, 'git-hooks')) });
  mkdirSync(join(work, 'scripts/git-hooks'), { recursive: true });
  copyFileSync(HOOK, join(work, 'scripts/git-hooks/reference-transaction'));
  chmodSync(join(work, 'scripts/git-hooks/reference-transaction'), 0o755);
  git(work, 'config', 'core.hooksPath', 'scripts/git-hooks');
  writeFileSync(join(work, '.git/info/exclude'), 'scripts/\n');
  for (const [path, text] of Object.entries(after)) {
    if (text === null) rmSync(join(other, path));
    else write(other, { [path]: text });
  }
  git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'after'); git(other, 'push', '-q', 'origin', 'HEAD:main');
  const advance = (...args) => spawnSync('node', [ADVANCE, '--checkout', work, ...args], { encoding: 'utf8', env });
  const status = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: work, encoding: 'utf8', env }).split('\n').filter(Boolean).sort();
  const rescues = () => git(work, 'for-each-ref', '--format=%(refname)', 'refs/rescue/').split('\n').filter(Boolean);
  return { root, origin, work, other, advance, status, rescues, main: () => git(other, 'rev-parse', 'HEAD') };
}

test('a clean checkout on a branch fast-forwards to origin/main', () => {
  const { work, advance, status, rescues, main } = repos({ 'a.txt': 'a1\n', 'd.txt': 'd\n' }, { 'a.txt': 'a2\n', 'd.txt': null, 'n/new.txt': 'new\n' });
  const ran = advance();
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.equal(git(work, 'rev-parse', 'refs/heads/main'), main(), 'the branch HEAD is on moved');
  assert.equal(git(work, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'a2\n');
  assert.equal(readFileSync(join(work, 'n/new.txt'), 'utf8'), 'new\n');
  assert.equal(existsSync(join(work, 'd.txt')), false);
  assert.deepEqual(status(), []);
  assert.deepEqual(rescues(), [], 'nothing local, nothing to save');
  assert.match(advance().stdout, /Already at origin\/main/);
});

test('a dirty detached checkout keeps every local version, lists it and saves it, and takes main for the rest', () => {
  const before = { 'same.txt': 's1\n', 'edited.txt': 'e1\n', 'staged.txt': 't1\n', 'gone.txt': 'g\n', 'gone-edited.txt': 'h1\n', 'run.sh': 'echo 1\n', 'quiet.txt': 'q\n' };
  const after = { 'same.txt': 's2\n', 'edited.txt': 'e2\n', 'staged.txt': 't2\n', 'gone.txt': null, 'gone-edited.txt': null, 'added.txt': 'main\n', 'added-same.txt': 'x\n', 'run.sh': { text: 'echo 2\n', exec: true } };
  const { work, advance, status, rescues, main } = repos(before, after);
  git(work, 'checkout', '-q', '--detach');
  write(work, { 'edited.txt': 'mine\n', 'gone-edited.txt': 'mine too\n', 'added.txt': 'untracked here\n', 'added-same.txt': 'x\n', 'loose.txt': 'nobody tracks me\n' });
  write(work, { 'staged.txt': 'staged here\n' }); git(work, 'add', 'staged.txt');
  const head = git(work, 'rev-parse', 'HEAD');

  const ran = advance();
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.equal(git(work, 'rev-parse', 'HEAD'), main());
  assert.equal(readFileSync(join(work, 'same.txt'), 'utf8'), 's2\n', 'unmodified: main\'s bytes');
  assert.equal(readFileSync(join(work, 'run.sh'), 'utf8'), 'echo 2\n');
  assert.equal(statSync(join(work, 'run.sh')).mode & 0o111, 0o111, 'main\'s mode too');
  assert.equal(existsSync(join(work, 'gone.txt')), false, 'deleted by main and unmodified: removed');
  assert.equal(readFileSync(join(work, 'edited.txt'), 'utf8'), 'mine\n', 'local edit kept');
  assert.equal(readFileSync(join(work, 'gone-edited.txt'), 'utf8'), 'mine too\n', 'deleted by main but edited here: kept');
  assert.equal(readFileSync(join(work, 'added.txt'), 'utf8'), 'untracked here\n', 'untracked in main\'s way: kept');
  assert.equal(readFileSync(join(work, 'loose.txt'), 'utf8'), 'nobody tracks me\n');
  assert.equal(readFileSync(join(work, 'staged.txt'), 'utf8'), 'staged here\n');
  assert.equal(git(work, 'show', ':staged.txt'), 'staged here', 'the staged entry is kept as it is');
  for (const path of ['edited.txt', 'gone-edited.txt', 'added.txt', 'staged.txt']) assert.match(ran.stdout, new RegExp(`kept ${path.replace('.', '\\.')}`));
  assert.doesNotMatch(ran.stdout, /kept (same|added-same|gone|run)\./);
  assert.deepEqual(status(), ['?? gone-edited.txt', '?? loose.txt', 'M  staged.txt', ' M added.txt', ' M edited.txt'].sort(), 'status shows only the true local versions');

  const [saved] = rescues();
  assert.match(saved, /^refs\/rescue\/advance-\d{4}-\d\d-\d\d-\d{6}-/);
  assert.ok(ran.stdout.includes(saved), 'the saved ref is printed');
  assert.equal(git(work, 'rev-parse', `${saved}^`), head, 'saved on the old HEAD');
  assert.equal(git(work, 'show', `${saved}:edited.txt`), 'mine');
  assert.equal(git(work, 'show', `${saved}:gone-edited.txt`), 'mine too');
  assert.equal(git(work, 'show', `${saved}:added.txt`), 'untracked here');
  assert.equal(git(work, 'show', `${saved}:staged.txt`), 'staged here');
});

test('HEAD moved since the caller looked: refused, nothing written', () => {
  const { work, advance, rescues } = repos({ 'a.txt': 'a1\n' }, { 'a.txt': 'a2\n' });
  const head = git(work, 'rev-parse', 'HEAD');
  write(work, { 'b.txt': 'b\n' }); git(work, 'add', 'b.txt'); git(work, 'commit', '-q', '--no-verify', '-m', 'someone else');
  const ran = advance('--expect-head', head);
  assert.equal(ran.status, 1);
  assert.match(ran.stdout, /someone moved it\. Nothing was changed\./);
  assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'a1\n');
  assert.deepEqual(rescues(), []);
  assert.equal(existsSync(join(work, '.git/index.lock')), false);
});

test('HEAD moved during the advance: the move is refused and every file written is put back', () => {
  const { work, main, other } = repos({ 'a.txt': 'a1\n', 'd.txt': 'd\n' }, { 'a.txt': 'a2\n', 'd.txt': null });
  git(work, 'checkout', '-q', '--detach');
  git(work, 'fetch', '-q', 'origin');
  const head = git(work, 'rev-parse', 'HEAD');
  const elsewhere = git(other, 'commit-tree', `${main()}^{tree}`, '-p', main(), '-m', 'a concurrent commit on main');
  const result = advanceCheckout(work, { beforeMove: () => {
    assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'a2\n', 'files were written before the move');
    git(other, 'push', '-q', 'origin', `${elsewhere}:main`); git(work, 'fetch', '-q', 'origin');
    git(work, 'update-ref', '--no-deref', 'HEAD', git(work, 'rev-parse', 'origin/main'));
  } });
  assert.equal(result.ok, false);
  assert.match(result.lines.at(-1), /files written were put back\. Nothing was changed\./);
  assert.notEqual(git(work, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'a1\n');
  assert.equal(readFileSync(join(work, 'd.txt'), 'utf8'), 'd\n');
  assert.equal(existsSync(join(work, '.git/index.lock')), false);
});

test('a HEAD that is not an ancestor of origin/main is refused, nothing written', () => {
  const { work, advance, rescues } = repos({ 'a.txt': 'a1\n' }, { 'a.txt': 'a2\n' });
  git(work, 'checkout', '-q', '--detach');
  write(work, { 'side.txt': 'side\n' }); git(work, 'add', 'side.txt'); git(work, 'commit', '-q', '-m', 'old line');
  git(work, 'fetch', '-q', 'origin');
  write(work, { 'side.txt': 'edited\n' });
  const ran = advance();
  assert.equal(ran.status, 1);
  assert.match(ran.stdout, /is not an ancestor of origin\/main.*Nothing was changed\./);
  assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'a1\n');
  assert.equal(readFileSync(join(work, 'side.txt'), 'utf8'), 'edited\n');
  assert.deepEqual(rescues(), []);
});

/** A detached checkout whose HEAD is a commit main does not have, an uncommitted edit, a stash, and that commit pushed to origin as `side`. */
function sideWork() {
  const fixture = repos({ 'a.txt': 'a1\n', 'keep.txt': 'k1\n' }, { 'a.txt': 'a2\n' });
  const { work } = fixture;
  git(work, 'checkout', '-q', '--detach');
  write(work, { 'side.txt': 'side\n' }); git(work, 'add', 'side.txt'); git(work, 'commit', '-q', '-m', 'side work');
  write(work, { 'stashed.txt': 'stashed\n' }); git(work, 'add', 'stashed.txt'); git(work, 'stash', 'push', '-q', '-m', 'someone\'s stash');
  write(work, { 'keep.txt': 'edited here\n', 'loose.txt': 'nobody tracks me\n' });
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/side');
  git(work, 'fetch', '-q', 'origin');
  return fixture;
}

test('a HEAD held by a pushed origin branch advances, keeping uncommitted files and stashes, and the branch is named and left alone', () => {
  const { work, advance, main } = sideWork();
  const head = git(work, 'rev-parse', 'HEAD');
  const ran = advance('--preserved-by', 'origin/side');
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /is not on origin\/main; every commit of it is held by origin\/side \(/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), main());
  assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'a2\n', 'main\'s bytes for what was not edited');
  assert.equal(readFileSync(join(work, 'keep.txt'), 'utf8'), 'edited here\n', 'the uncommitted edit is kept');
  assert.equal(readFileSync(join(work, 'loose.txt'), 'utf8'), 'nobody tracks me\n');
  assert.match(git(work, 'stash', 'list'), /someone's stash/, 'the stash is untouched');
  assert.equal(git(work, 'rev-parse', 'origin/side'), head, 'the preserving branch still holds the old HEAD');
});

test('a HEAD no pushed origin branch holds is refused, whatever branch is named, and nothing is written', () => {
  for (const named of [null, 'origin/main', 'side-local', 'origin/missing']) {
    const { work, advance } = sideWork();
    git(work, 'branch', 'side-local');
    const ran = advance(...(named ? ['--preserved-by', named] : []));
    assert.equal(ran.status, 1, `${named}: ${ran.stdout}`);
    assert.match(ran.stdout, /is not an ancestor of origin\/main.*Nothing was changed\./);
    assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'a1\n');
    assert.equal(readFileSync(join(work, 'keep.txt'), 'utf8'), 'edited here\n');
  }
  // A pushed branch that does not hold HEAD does not preserve it either.
  const { work, advance } = sideWork();
  git(work, 'push', '-q', 'origin', 'refs/heads/main:refs/heads/elsewhere'); git(work, 'fetch', '-q', 'origin');
  const ran = advance('--preserved-by', 'origin/elsewhere');
  assert.equal(ran.status, 1);
  assert.match(ran.stdout, /origin\/elsewhere does not\)/);
});

test('a shallow checkout is refused with the command that repairs it', () => {
  const { origin, root } = repos({ 'a.txt': 'a1\n' }, { 'a.txt': 'a2\n' });
  const shallow = join(root, 'shallow');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${origin}`, shallow]);
  const ran = spawnSync('node', [ADVANCE, '--checkout', shallow], { encoding: 'utf8', env });
  assert.equal(ran.status, 1);
  assert.match(ran.stdout, /shallow repository.*git fetch --unshallow origin.*Nothing was changed\./);
});

test('--if-shared leaves a linked worktree alone', () => {
  const { work, root, main } = repos({ 'a.txt': 'a1\n' }, { 'a.txt': 'a2\n' });
  const lane = join(root, 'lane');
  git(work, 'worktree', 'add', '-q', '--detach', lane, 'HEAD');
  const ran = spawnSync('node', [ADVANCE, '--checkout', lane, '--if-shared'], { encoding: 'utf8', env });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, '');
  assert.notEqual(git(lane, 'rev-parse', 'HEAD'), main());
});

test('--if-idle (the run after a push) refuses at once, writing nothing, while a changed path is staged or index.lock is held', () => {
  const { work, advance, rescues } = repos({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' }, { 'a.txt': 'a2\n', 'b.txt': 'b2\n' });
  git(work, 'checkout', '-q', '--detach');
  const head = git(work, 'rev-parse', 'HEAD');
  write(work, { 'b.txt': 'staged here\n' }); git(work, 'add', 'b.txt');

  const staged = advance('--if-idle');
  assert.equal(staged.status, 1, staged.stdout + staged.stderr);
  assert.match(staged.stdout, /1 path main changed is staged here \(b\.txt\).*Nothing was changed\./);
  assert.equal(git(work, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'a1\n', 'no file written');
  assert.deepEqual(rescues(), []);
  assert.equal(existsSync(join(work, '.git/index.lock')), false, 'its own lock is let go');

  git(work, 'reset', '-q', 'b.txt'); write(work, { 'b.txt': 'b1\n' });
  writeFileSync(join(work, '.git/index.lock'), '');
  const locked = advance('--if-idle');
  assert.equal(locked.status, 1, locked.stdout + locked.stderr);
  assert.match(locked.stdout, /index\.lock is held by another git command/);
  assert.equal(existsSync(join(work, '.git/index.lock')), true, 'another command\'s lock is never removed');
  rmSync(join(work, '.git/index.lock'));
  assert.equal(git(work, 'rev-parse', 'HEAD'), head);

  const idle = advance('--if-idle');
  assert.equal(idle.status, 0, idle.stdout + idle.stderr);
  assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'a2\n');
});
