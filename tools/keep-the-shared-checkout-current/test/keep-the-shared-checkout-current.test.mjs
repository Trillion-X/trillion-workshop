import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { keepCurrent } from '../do-work/keep-the-shared-checkout-current.mjs';

const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@localhost'];
const git = (cwd, args) => execFileSync('git', [...IDENTITY, '-C', cwd, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } }).trim();
const OLD = new Date(Date.now() - 10 * 60_000);
const LATER = () => new Date(Date.now() + 10 * 60_000);

// A bare origin, a publisher that pushes to it, and the shared checkout that follows it.
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'keep-current-'));
  const origin = join(base, 'origin.git');
  const publisher = join(base, 'publisher');
  const shared = join(base, 'shared');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, publisher], { stdio: 'pipe' });
  git(publisher, ['checkout', '-q', '-b', 'main']);
  const files = { 'a.txt': 'a one\n', 'b.txt': 'b one\n', 'gone.txt': 'gone\n', 'clean-gone.txt': 'clean gone\n', 'dirty-gone.txt': 'dirty gone\n' };
  write(publisher, files);
  git(publisher, ['add', '-A']);
  git(publisher, ['commit', '-q', '-m', 'first']);
  git(publisher, ['push', '-q', 'origin', 'main']);
  execFileSync('git', ['clone', '-q', origin, shared], { stdio: 'pipe' });
  git(shared, ['checkout', '-q', 'main']);
  for (const p of Object.keys(files)) age(join(shared, p));
  return { base, origin, publisher, shared };
}

function write(root, files) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    if (text === null) continue;
    writeFileSync(join(root, p), text);
  }
}

function age(path) {
  utimesSync(path, OLD, OLD);
}

function publish(env, changes, message) {
  for (const [p, text] of Object.entries(changes)) {
    if (text === null) git(env.publisher, ['rm', '-q', p]);
    else write(env.publisher, { [p]: text });
  }
  git(env.publisher, ['add', '-A']);
  git(env.publisher, ['commit', '-q', '-m', message]);
  git(env.publisher, ['push', '-q', 'origin', 'main']);
  return git(env.publisher, ['rev-parse', 'HEAD']);
}

const read = (env, p) => readFileSync(join(env.shared, p), 'utf8');

test('a dirty file that origin also changes is kept, and the rest moves to origin', () => {
  const env = setup();
  publish(env, { 'a.txt': 'a origin\n', 'b.txt': 'b origin\n' }, 'change a and b');
  write(env.shared, { 'a.txt': 'a mine\n' });
  const result = keepCurrent(env.shared, { now: LATER() });
  assert.equal(result.outcome, 'ran');
  assert.equal(read(env, 'a.txt'), 'a mine\n');
  assert.equal(read(env, 'b.txt'), 'b origin\n');
  assert.deepEqual(result.updated, ['b.txt']);
  assert.equal(result.kept.find((k) => k.path === 'a.txt').why, 'changed here; origin changed it too');
  assert.equal(result.behind_after, 0);
  assert.equal(result.rescue_ref !== null, true);
  assert.equal(git(env.shared, ['rev-parse', 'HEAD']), git(env.shared, ['rev-parse', 'origin/main']));
});

test('an untracked file that origin now adds is kept and origin version is not written over it', () => {
  const env = setup();
  publish(env, { 'new.txt': 'origin new\n' }, 'add new');
  write(env.shared, { 'new.txt': 'my new\n' });
  const result = keepCurrent(env.shared, { now: LATER() });
  assert.equal(read(env, 'new.txt'), 'my new\n');
  const kept = result.kept.find((k) => k.path === 'new.txt');
  assert.match(kept.why, /origin adds this path too/);
  assert.equal(result.behind_after, 0);
});

test('a dirty file that origin deletes is kept', () => {
  const env = setup();
  publish(env, { 'dirty-gone.txt': null }, 'delete dirty-gone');
  write(env.shared, { 'dirty-gone.txt': 'my edit\n' });
  const result = keepCurrent(env.shared, { now: LATER() });
  assert.equal(read(env, 'dirty-gone.txt'), 'my edit\n');
  assert.equal(result.kept.find((k) => k.path === 'dirty-gone.txt').why, 'changed here; origin deleted it');
  assert.equal(result.removal_entries.length, 0);
});

test('a clean file that origin deletes is named with its removal proof and left on disk', () => {
  const env = setup();
  publish(env, { 'clean-gone.txt': null }, 'delete clean-gone');
  const result = keepCurrent(env.shared, { now: LATER() });
  assert.equal(readFileSync(join(env.shared, 'clean-gone.txt'), 'utf8'), 'clean gone\n');
  assert.equal(result.removal_entries.length, 1);
  const entry = result.removal_entries[0];
  assert.equal(entry.path, join(env.shared, 'clean-gone.txt'));
  assert.equal(entry.size, 'clean gone\n'.length);
  assert.equal(entry.proof.samples[0].length, entry.size);
  assert.equal(entry.proof.samples[0].sha256, createHash('sha256').update('clean gone\n').digest('hex'));
});

test('HEAD moving during the pass stops it, and the rescue ref keeps the working state', () => {
  const env = setup();
  publish(env, { 'b.txt': 'b origin\n' }, 'change b');
  write(env.shared, { 'a.txt': 'a mine\n' });
  const result = keepCurrent(env.shared, {
    now: LATER(),
    beforeReset: () => git(env.shared, ['commit', '-q', '--allow-empty', '-m', 'someone else']),
  });
  assert.equal(result.outcome, 'stopped');
  assert.equal(read(env, 'a.txt'), 'a mine\n');
  assert.equal(read(env, 'b.txt'), 'b one\n');
  assert.notEqual(git(env.shared, ['rev-parse', 'HEAD']), git(env.shared, ['rev-parse', 'origin/main']));
  assert.equal(git(env.shared, ['show', `${result.rescue_ref}:a.txt`]), 'a mine');
});

test('commits not on origin are saved in the rescue ref and reported', () => {
  const env = setup();
  write(env.shared, { 'local.txt': 'local\n' });
  git(env.shared, ['add', 'local.txt']);
  git(env.shared, ['commit', '-q', '-m', 'local only']);
  const local = git(env.shared, ['rev-parse', 'HEAD']);
  const result = keepCurrent(env.shared, { now: LATER() });
  assert.deepEqual(result.local_commits, [local]);
  assert.equal(result.outcome, 'ran');
  git(env.shared, ['merge-base', '--is-ancestor', local, result.rescue_ref]);
  assert.equal(git(env.shared, ['rev-parse', 'origin/main']), git(env.shared, ['rev-parse', 'HEAD']));
});

test('a file edited in the last 120 seconds is skipped, then written by the next pass', () => {
  const env = setup();
  publish(env, { 'b.txt': 'b origin\n' }, 'change b');
  write(env.shared, { 'b.txt': 'b one\n' });
  const first = keepCurrent(env.shared, { });
  assert.deepEqual(first.skipped.map((s) => s.path), ['b.txt']);
  assert.equal(read(env, 'b.txt'), 'b one\n');
  const second = keepCurrent(env.shared, { now: LATER() });
  assert.deepEqual(second.updated, ['b.txt']);
  assert.equal(read(env, 'b.txt'), 'b origin\n');
  assert.equal(second.behind_after, 0);
});

test('an index.lock present makes the pass a no-op', () => {
  const env = setup();
  publish(env, { 'b.txt': 'b origin\n' }, 'change b');
  writeFileSync(join(env.shared, '.git', 'index.lock'), '');
  const head = git(env.shared, ['rev-parse', 'HEAD']);
  const result = keepCurrent(env.shared, { now: LATER() });
  assert.equal(result.outcome, 'refused');
  assert.equal(git(env.shared, ['rev-parse', 'HEAD']), head);
  assert.equal(read(env, 'b.txt'), 'b one\n');
});

const rescueRefs = (env) => git(env.shared, ['for-each-ref', '--format=%(refname)', 'refs/rescue/']).split('\n').filter(Boolean);

test('the same dirty state makes one rescue ref, not one per pass', () => {
  const env = setup();
  write(env.shared, { 'a.txt': 'a mine\n' });
  const first = keepCurrent(env.shared, { });
  const second = keepCurrent(env.shared, { });
  assert.ok(first.rescue_ref);
  assert.equal(second.rescue_ref, first.rescue_ref);
  assert.equal(rescueRefs(env).length, 1);
});

test('a changed dirty state makes a new rescue ref, and a ref with bytes of its own is kept', () => {
  const env = setup();
  write(env.shared, { 'a.txt': 'a mine\n' });
  const first = keepCurrent(env.shared, { });
  write(env.shared, { 'a.txt': 'a mine again\n' });
  const second = keepCurrent(env.shared, { now: LATER() });
  assert.notEqual(second.rescue_ref, first.rescue_ref);
  assert.equal(rescueRefs(env).length, 2);
  assert.equal(git(env.shared, ['show', `${first.rescue_ref}:a.txt`]), 'a mine');
});

test('an older rescue ref whose files a newer one holds is removed; the newest is kept', () => {
  const env = setup();
  write(env.shared, { 'a.txt': 'a mine\n' });
  const first = keepCurrent(env.shared, { });
  write(env.shared, { 'b.txt': 'b mine\n' });
  const second = keepCurrent(env.shared, { now: LATER() });
  assert.deepEqual(rescueRefs(env), [second.rescue_ref]);
  assert.notEqual(second.rescue_ref, first.rescue_ref);
  assert.equal(git(env.shared, ['show', `${second.rescue_ref}:a.txt`]), 'a mine');
});

test('an origin-deleted file a pass kept, later back at its old bytes, is named for removal', () => {
  const env = setup();
  publish(env, { 'dirty-gone.txt': null }, 'delete dirty-gone');
  write(env.shared, { 'dirty-gone.txt': 'my edit\n' });
  keepCurrent(env.shared, { now: LATER() });
  assert.equal(read(env, 'dirty-gone.txt'), 'my edit\n');
  write(env.shared, { 'dirty-gone.txt': 'dirty gone\n' });
  const result = keepCurrent(env.shared, { now: LATER() });
  assert.equal(read(env, 'dirty-gone.txt'), 'dirty gone\n');
  assert.deepEqual(result.removal_entries.map((e) => e.path), [join(env.shared, 'dirty-gone.txt')]);
});

test('a dirty file holding old HEAD bytes after an origin move gets origin version; a new edit stays', () => {
  const env = setup();
  publish(env, { 'a.txt': 'a origin\n' }, 'change a');
  git(env.shared, ['fetch', '-q', 'origin']);
  git(env.shared, ['reset', '-q', '--mixed', 'origin/main']);
  assert.equal(read(env, 'a.txt'), 'a one\n');
  const stale = keepCurrent(env.shared, { now: LATER() });
  assert.equal(read(env, 'a.txt'), 'a origin\n');
  assert.deepEqual(stale.updated, ['a.txt']);
  assert.ok(stale.rescue_ref, 'the stale bytes are saved in the rescue ref first');
  assert.equal(git(env.shared, ['show', `${stale.rescue_ref}:a.txt`]), 'a one');
  write(env.shared, { 'a.txt': 'a brand new edit\n' });
  const edit = keepCurrent(env.shared, { now: LATER() });
  assert.equal(read(env, 'a.txt'), 'a brand new edit\n');
  assert.equal(edit.kept.find((k) => k.path === 'a.txt').why, 'changed here');
});

test('an unreadable file is kept and reported, and the rest of the pass still runs', () => {
  const env = setup();
  publish(env, { 'b.txt': 'b origin\n' }, 'change b');
  write(env.shared, { 'secret.txt': 'hidden\n' });
  chmodSync(join(env.shared, 'secret.txt'), 0o000);
  try {
    const result = keepCurrent(env.shared, { now: LATER() });
    assert.equal(result.outcome, 'ran');
    assert.deepEqual(result.updated, ['b.txt']);
    assert.match(result.kept.find((k) => k.path === 'secret.txt').why, /untracked/);
  } finally {
    chmodSync(join(env.shared, 'secret.txt'), 0o600);
  }
});
