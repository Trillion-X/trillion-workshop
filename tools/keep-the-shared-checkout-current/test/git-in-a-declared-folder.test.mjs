import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, workingState } from '../do-work/git-in-a-declared-folder.mjs';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'git-declared-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, 'b.txt'), 'b\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-q', '-m', 'first']);
  return root;
}

test('a failed git call names its arguments and git stderr', () => {
  const root = repo();
  assert.throws(() => git(root, ['rev-parse', '--verify', 'no-such-ref^{commit}']), (error) => {
    assert.match(error.message, /rev-parse --verify no-such-ref\^\{commit\} failed/);
    assert.match(error.message, /fatal|Needed a single revision/);
    return true;
  });
});

test('a path that vanished between the listing and the hash is kept as unreadable; the others hash', () => {
  const root = repo();
  const state = workingState(root, ['a.txt', 'gone.txt', 'b.txt'], new Date(Date.now() + 600_000));
  assert.notEqual(state.get('a.txt').oid, null);
  assert.equal(state.get('gone.txt').oid, null);
  assert.equal(state.get('b.txt').oid, git(root, ['hash-object', 'b.txt']).trim());
});

test('a symbolic link hashes as git hashes its target text', () => {
  const root = repo();
  execFileSync('ln', ['-s', 'a.txt', join(root, 'link')]);
  const state = workingState(root, ['link'], new Date(Date.now() + 600_000));
  assert.equal(state.get('link').oid, execFileSync('git', ['hash-object', '--stdin'], { input: 'a.txt', encoding: 'utf8' }).trim());
});
