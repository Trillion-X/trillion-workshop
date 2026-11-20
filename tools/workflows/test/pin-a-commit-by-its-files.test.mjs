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
import { duplicateLayouts, pinOf } from '../do-work/pin-a-commit-by-its-files.mjs';

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

test('a row that lays one place twice is found by duplicateLayouts: a packages entry spelled two ways, and a paths entry twice', () => {
  const packagesTwoWays = { 'tool:a': [{ packages: ['split2'], at: '/opt/node_modules/split2' }, { packages: ['node_modules/split2'], at: '/opt/split2' }] };
  assert.deepEqual(duplicateLayouts(packagesTwoWays), [{ row: 'tool:a', key: 'package /opt/split2 split2', at: '/opt/split2' }]);
  const pathsTwice = { 'tool:b': [{ package: 'kit', paths: ['do-work/run.mjs'], at: '/opt/kit' }, { package: 'kit', paths: ['do-work/run.mjs/'], at: '/opt/kit/' }] };
  assert.deepEqual(duplicateLayouts(pathsTwice), [{ row: 'tool:b', key: 'path /opt/kit/do-work/run.mjs', at: '/opt/kit/', path: 'do-work/run.mjs/' }]);
  const folderAndPath = { 'tool:c': [{ package: 'media', paths: ['do-work'], at: '/opt/media' }, { packages: ['numpy'], at: '/opt/media/do-work' }] };
  assert.deepEqual(duplicateLayouts(folderAndPath), [], 'a package folder and a path of one folder are two different landings');
  const insideAFolder = { 'tool:d': [{ package: 'shapes', paths: ['.'], at: '/opt/node_modules/trillion-workshop/tools/shapes' },
    { package: 'shapes', paths: ['read-data/one.mjs'], at: '/opt/node_modules/trillion-workshop/tools/shapes' }] };
  assert.deepEqual(duplicateLayouts(insideAFolder), [{ row: 'tool:d', key: 'path /opt/trillion-workshop/tools/shapes/read-data/one.mjs',
    at: '/opt/node_modules/trillion-workshop/tools/shapes', path: 'read-data/one.mjs', inside: '/opt/trillion-workshop/tools/shapes' }]);
  const besideNotInside = { 'tool:e': [{ package: 'kit', paths: ['do-work'], at: '/opt/kit' }, { package: 'kit', paths: ['do-work-two/x.mjs', 'do-workx.mjs'], at: '/opt/kit' }] };
  assert.deepEqual(duplicateLayouts(besideNotInside), [], 'a name that only starts like a laid folder is not inside it');
});

test('a commit that lays a path inside a folder it lays whole is not pinned', () => {
  const repository = mkdtempSync(join(tmpdir(), 'pin-a-inside-'));
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const files = { 'tools/kit/read-data/one.mjs': 'export {}', 'package-files.json': JSON.stringify({ 'tool:a': [
    { package: 'kit', paths: ['read-data'], at: '/opt/kit' }, { package: 'kit', paths: ['read-data/one.mjs'], at: '/opt/kit' }] }) };
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(repository, path, '..'), { recursive: true }); writeFileSync(join(repository, path), text); }
  git('add', '-A');
  git('-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-m', 'inside');
  const commit = git('rev-parse', 'HEAD');
  assert.throws(() => pinOf(repository, commit, 'https://archives.example.com/{commit}.tar.gz'),
    (error) => error.problems?.[0] === 'tool:a lays /opt/kit/read-data/one.mjs inside /opt/kit/read-data, which it lays whole');
});

test('a commit whose paths entry lays one path twice is not pinned', () => {
  const repository = mkdtempSync(join(tmpdir(), 'pin-a-twice-'));
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const files = { 'tools/kit/do-work/run.mjs': 'export {}', 'package-files.json': JSON.stringify({ 'tool:a': [
    { package: 'kit', paths: ['do-work/run.mjs'], at: '/opt/kit' }, { package: 'kit', paths: ['do-work/run.mjs/'], at: '/opt/kit/' }] }) };
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(repository, path, '..'), { recursive: true }); writeFileSync(join(repository, path), text); }
  git('add', '-A');
  git('-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-m', 'twice');
  const commit = git('rev-parse', 'HEAD');
  assert.throws(() => pinOf(repository, commit, 'https://archives.example.com/{commit}.tar.gz'),
    (error) => error.problems?.[0] === 'tool:a lays /opt/kit/do-work/run.mjs twice');
});

