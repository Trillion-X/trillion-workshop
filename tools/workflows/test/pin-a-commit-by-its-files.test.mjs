// The pin of a commit is the engine's manifest identity of exactly the files `git archive` holds: long and non-ASCII names
// read whole, links left out, keys in byte order (a name that looks like a number is not moved first), and only a full
// commit is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { pinOf } from '../do-work/pin-a-commit-by-its-files.mjs';

test('a commit is pinned by exactly its archived files, in the engine\'s identity', () => {
  const repository = mkdtempSync(join(tmpdir(), 'pin-a-commit-'));
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const long = `${'a-folder-with-a-long-name/'.repeat(5)}a-file.json`;
  const files = { 'README.md': 'the tools', 'tools/9/x.json': '{}', 'tools/10/x.json': '[]', [long]: '{"long":true}', 'tools/é.txt': 'non-ascii' };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repository, path, '..'), { recursive: true });
    writeFileSync(join(repository, path), text);
  }
  symlinkSync('README.md', join(repository, 'a-link'));
  git('add', '-A');
  git('-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-m', 'files');
  const commit = git('rev-parse', 'HEAD');
  const hex = bytes => Buffer.from(bytes).toString('hex');
  const entries = Object.entries(files).map(([path, text]) => [path, hex(blake3(Buffer.from(text)))])
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const expected = hex(blake3(Buffer.from(`{${entries.map(([path, digest]) => `"${path}":"${digest}"`).join(',')}}`)));
  assert.deepEqual(pinOf(repository, commit), { commit, manifest_blake3: expected, files: 5 });
  assert.throws(() => pinOf(repository, commit.slice(0, 9)), /full commit/);
  assert.throws(() => pinOf(repository, 'main'), /full commit/);
});
