// The pin of a commit is the engine's manifest identity of exactly the files `git archive` holds: long and non-ASCII names
// read whole, links left out, keys in byte order (a name that looks like a number is not moved first), and only a full
// commit at an https address is pinned.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { duplicateLayouts, layoutProblems, layoutReport, pinOf } from '../do-work/pin-a-commit-by-its-files.mjs';
import { tarFiles } from '../../content-identity/read-data/manifest.mjs';

test('a commit is pinned by exactly its archived files, in the engine\'s identity', () => {
  const repository = tempFolder(join(tmpdir(), 'pin-a-commit-'));
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
  const repository = tempFolder(join(tmpdir(), 'pin-a-layout-'));
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
  const repository = tempFolder(join(tmpdir(), 'pin-a-inside-'));
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
  const repository = tempFolder(join(tmpdir(), 'pin-a-twice-'));
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


test('a container tool row that names package files needs its key in package-files.json, and a row that names none needs none', () => {
  const address = 'https://archives.example.com/{commit}.tar.gz';
  const container = (id, packageFiles) => JSON.stringify({ records: [{ payload: { kind: 'ai-tool-descriptor', id,
    invoke: { kind: 'container', files: packageFiles === undefined ? {} : { package_files: packageFiles } } } }] });
  const laid = [{ package: 'kit', paths: ['do-work/run.mjs'], at: '/opt/kit' }];
  const commitOf = (name, files) => {
    const repository = tempFolder(join(tmpdir(), `pin-a-container-${name}-`));
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(repository, path, '..'), { recursive: true }); writeFileSync(join(repository, path), text); }
    git('add', '-A');
    git('-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-m', name);
    return { repository, commit: git('rev-parse', 'HEAD') };
  };
  const base = { 'tools/kit/do-work/run.mjs': 'export {}' };
  const noKey = commitOf('no-key', { ...base, 'tools/kit/tool-rows.json': container('tool:needs-files', laid), 'package-files.json': '{}' });
  assert.throws(() => pinOf(noKey.repository, noKey.commit, address), (error) =>
    error.problems?.length === 1 && error.problems[0] === 'tool:needs-files is a container tool that names package files, and package-files.json has no key for it');
  const noLayoutFile = commitOf('no-layout-file', { ...base, 'tools/kit/tool-rows.json': container('tool:needs-files', laid) });
  assert.throws(() => pinOf(noLayoutFile.repository, noLayoutFile.commit, address), (error) => error.problems?.[0] === 'tool:needs-files is a container tool that names package files, and package-files.json has no key for it');
  const withKey = commitOf('with-key', { ...base, 'tools/kit/tool-rows.json': container('tool:needs-files', laid),
    'package-files.json': JSON.stringify({ 'tool:needs-files': laid }) });
  assert.equal(pinOf(withKey.repository, withKey.commit, address).files, 3, 'a row with its key is pinned');
  const noPackageFiles = commitOf('no-package-files', { ...base, 'tools/kit/tool-rows.json': container('tool:plain', undefined) });
  assert.equal(pinOf(noPackageFiles.repository, noPackageFiles.commit, address).files, 2, 'a container row that names no package files needs no key');
});

test('a landing is judged by the problems its commit adds against its parent: an origin problem is existing, a new keyless row is added', () => {
  const repository = tempFolder(join(tmpdir(), 'pin-a-report-'));
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const container = id => JSON.stringify({ records: [{ payload: { kind: 'ai-tool-descriptor', id,
    invoke: { kind: 'container', files: { package_files: [{ package: 'kit', paths: ['do-work/run.mjs'], at: '/opt/kit' }] } } } }] });
  const commit = (name, files) => {
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(repository, path, '..'), { recursive: true }); writeFileSync(join(repository, path), text); }
    git('add', '-A');
    git('-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '--allow-empty', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  const base = { 'tools/kit/do-work/run.mjs': 'export {}', 'package-files.json': '{}' };
  const parent = commit('origin', { ...base, 'tools/kit/tool-rows.json': container('tool:already-there') });
  const child = commit('lane', { 'tools/other/tool-rows.json': container('tool:new-one') });
  const archive = (c) => tarFiles(execFileSync('git', ['-C', repository, 'archive', '--format=tar', c], { maxBuffer: 1 << 30 }));
  const origin = 'tool:already-there is a container tool that names package files, and package-files.json has no key for it';
  const added = 'tool:new-one is a container tool that names package files, and package-files.json has no key for it';
  assert.deepEqual(layoutReport(archive(parent)), { added: [origin], existing: [] }, 'with no parent, every problem is added');
  assert.deepEqual(layoutReport(archive(child), archive(parent)), { added: [added], existing: [origin] }, 'the origin problem is existing, the new row is added');
  assert.deepEqual(layoutReport(archive(parent), archive(parent)), { added: [], existing: [origin] }, 'an unchanged origin problem is not counted as new');
  const cli = (c) => spawnSync(process.execPath, [new URL('../do-work/pin-a-commit-by-its-files.mjs', import.meta.url).pathname, repository, c, 'https://archives.example.com/{commit}.tar.gz'], { encoding: 'utf8' });
  const addedRun = cli(child);
  assert.equal(addedRun.status, 1, 'a commit that adds a problem fails the check');
  assert.match(addedRun.stderr, /new in this commit: 1; already on origin: 1/);
  git('checkout', '-q', '--detach', parent);
  const sibling = commit('sibling', { 'README.md': 'a sibling of the lane, adding no problem' });
  const existingRun = cli(sibling);
  assert.equal(existingRun.status, 0, 'an origin-only problem does not fail the lane check');
  assert.match(existingRun.stderr, /new in this commit: 0; already on origin: 1/);
});

test('a container row whose invoke.packages names a package that no package_files item of its own lays is reported; a laid one is not', () => {
  const rowFile = (payload) => Buffer.from(JSON.stringify({ records: [{ payload: { kind: 'ai-tool-descriptor', ...payload } }] }));
  const declared = (packages, packageFiles) => ({ id: 'tool:needs-pg', invoke: { kind: 'container', packages, files: packageFiles ? { package_files: packageFiles } : {} } });
  const check = (payload, layout = { 'tool:needs-pg': [] }) => layoutProblems([['tools/kit/tool-rows.json', rowFile(payload)], ['package-files.json', Buffer.from(JSON.stringify(layout))]]);
  const notLaid = 'tool:needs-pg declares the package pg, and no package_files item of its own lays it';
  assert.deepEqual(check(declared({ pg: { version: '8.23.1' } })), [notLaid], 'the object form of invoke.packages, nothing lays pg');
  assert.deepEqual(check(declared(['pg'], [{ package: 'kit', paths: ['do-work'], at: '/opt/kit' }])), [notLaid], 'a package_files item that lays other paths only');
  const laid = [{ packages: ['pg'], at: '/opt/node_modules/pg' }];
  assert.deepEqual(check(declared(['pg'], laid), { 'tool:needs-pg': laid }), [], 'a laid package is clean');
  assert.deepEqual(check(declared(['node_modules/pg'], laid), { 'tool:needs-pg': laid }), [], 'a declared node_modules/ name is the same package as the laid one');
  assert.deepEqual(check(declared(['pg'], [{ packages: ['node_modules/pg'], at: '/opt/node_modules/pg' }]), { 'tool:needs-pg': [{ packages: ['node_modules/pg'], at: '/opt/node_modules/pg' }] }), [], 'a laid node_modules/ name is the same package as the declared one');
});
