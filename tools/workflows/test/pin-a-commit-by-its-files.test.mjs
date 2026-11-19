// The pin of a commit is the engine's manifest identity of exactly the files `git archive` holds: long and non-ASCII names
// read whole, links left out, keys in byte order (a name that looks like a number is not moved first), and only a full
// commit at an https address is pinned.
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
  const address = 'https://archives.example.com/maker/tools/{commit}.tar.gz';
  assert.deepEqual(pinOf(repository, commit, address), { address: `https://archives.example.com/maker/tools/${commit}.tar.gz`, files_blake3: expected, files: 5 });
  assert.throws(() => pinOf(repository, commit.slice(0, 9), address), /full commit/);
  assert.throws(() => pinOf(repository, 'main', address), /full commit/);
  for (const bad of [undefined, 'http://archives.example.com/{commit}', 'archives.example.com/{commit}']) assert.throws(() => pinOf(repository, commit, bad), /https address/, bad);
});

test('a commit whose layout would stop runs is not pinned: a laid-out file it lacks, or a package folder placed twice', () => {
  const repository = mkdtempSync(join(tmpdir(), 'pin-a-layout-'));
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const commitWith = (layout, extra = {}) => {
    const files = { 'tools/kit/do-work/run.mjs': 'export {}', 'tools/kit/read-data/a.json': '{}', 'package-files.json': JSON.stringify(layout), ...extra };
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(repository, path, '..'), { recursive: true }); writeFileSync(join(repository, path), text); }
    git('add', '-A');
    git('-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '--allow-empty', '-m', 'layout');
    return git('rev-parse', 'HEAD');
  };
  const address = 'https://archives.example.com/{commit}.tar.gz';
  const good = commitWith({ 'tool:a': [{ package: 'kit', paths: ['do-work/run.mjs', 'read-data'], at: '/opt/kit' }, { packages: ['pg'], at: '/opt/node_modules/pg' }] });
  assert.equal(pinOf(repository, good, address).files, 3, 'a file and a folder the commit holds, each package once: pinned');
  const missing = commitWith({ 'tool:a': [{ package: 'kit', paths: ['do-work/run.mjs', 'src/moved-away.mjs'], at: '/opt/kit' }] });
  assert.throws(() => pinOf(repository, missing, address), (error) => error.problems?.[0] === 'tool:a is laid out with tools/kit/src/moved-away.mjs, which this commit does not hold');
  const twice = commitWith({ 'tool:b': [{ packages: ['split2'], at: '/opt/node_modules/split2' }, { packages: ['node_modules/split2'], at: '/opt/node_modules/split2' }] });
  assert.throws(() => pinOf(repository, twice, address), (error) => error.problems?.[0] === 'tool:b places the package folder /opt/node_modules/split2 twice');
});
