import { tempFolder } from '../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { declaredTestSource } from '../test-helpers/declared-test-source.mjs';
import { gitReaders } from '../tools/check-a-port-against-its-source/do-work/read-from-repositories.mjs';
import { makeHashCodeHexFromBytes, makeHashCodeHexFromJson } from '../tools/content-identity/read-data/identity.mjs';

function fixture(t) {
  const folder = realpathSync(tempFolder(join(tmpdir(), 'declared-test-source-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const repo = join(folder, 'fixture-source');
  mkdirSync(join(repo, 'client'), { recursive: true });
  const files = {
    'client/package.json': '{"type":"module"}\n',
    'client/main.ts': "import { value } from './value'; import config from './config.json'; globalThis.fixtureAnswer = value + config.extra;\n",
    'client/value.ts': 'export const value: number = 40;\n',
    'client/config.json': '{"extra":2}\n',
    'client/tool.mjs': 'import { value } from "./module-value.mjs"; export const answer = value;\n',
    'client/module-value.mjs': 'export const value = 42;\n',
    'client/style.css': 'body { color: black; }\n',
    'client/escape.ts': "import '../outside.ts';\n",
    'outside.ts': 'globalThis.outsideSource = true;\n',
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('remote', 'add', 'origin', 'https://example.test/source.git'); git('add', '.'); git('commit', '-qm', 'Synthetic source');
  const declaration = { repository: 'fixture-source', origin: 'https://example.test/source.git', commit: git('rev-parse', 'HEAD'), root: 'client' };
  const manifest = { schema: 'committed-source-manifest/v1', ...declaration,
    files: Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith('client/')).map(([path, text]) => [path, makeHashCodeHexFromBytes(Buffer.from(text))])) };
  const binding = { ...declaration, manifest_identity: makeHashCodeHexFromJson(manifest) };
  const options = { root: repo, repositories: { 'fixture-source': repo } };
  return { repo, files, binding, manifest, options, git, open: () => declaredTestSource(binding, manifest, options) };
}

test('a real bundle resolves normally at its owner and every loaded byte comes from the declared committed source', async t => {
  const f = fixture(t), source = f.open();
  writeFileSync(join(f.repo, 'client/value.ts'), 'throw new Error("uncommitted source must not execute");\n');
  const output = await build({ absWorkingDir: source.root, entryPoints: ['main.ts'], bundle: true, write: false, format: 'iife', plugins: [source.plugin()] });
  assert.match(output.outputFiles[0].text, /var value = 40/);
  assert.doesNotMatch(output.outputFiles[0].text, /uncommitted source/);
  assert.deepEqual(source.json('config.json'), { extra: 2 });
  assert.equal(source.read('style.css').toString(), f.files['client/style.css']);
  const proof = source.proof();
  assert.equal(proof.commit, f.binding.commit);
  assert.equal(proof.manifest_identity, f.binding.manifest_identity);
  assert.deepEqual(proof.files.map(([path]) => path), ['client/config.json', 'client/main.ts', 'client/package.json', 'client/style.css', 'client/value.ts']);
  assert.deepEqual(proof.files.map(([path, identity]) => identity), proof.files.map(([path]) => f.manifest.files[path]));
});

test('missing, stale and wrong-owner declarations never select a different source', t => {
  const f = fixture(t);
  assert.throws(() => declaredTestSource({ ...f.binding, commit: 'a'.repeat(40) }, f.manifest, f.options), /stale|another source/);
  const badManifest = { ...f.manifest, files: { ...f.manifest.files, 'client/value.ts': `1f:${'a'.repeat(64)}` } };
  const bad = declaredTestSource({ ...f.binding, manifest_identity: makeHashCodeHexFromJson(badManifest) }, badManifest, f.options);
  assert.throws(() => bad.read('value.ts'), /identity does not match/);
  const wrongOwner = { ...f.manifest, origin: 'https://example.test/another-owner.git' };
  assert.throws(() => declaredTestSource({ ...f.binding, origin: wrongOwner.origin, manifest_identity: makeHashCodeHexFromJson(wrongOwner) }, wrongOwner, f.options), /repository owner/);
  const readers = gitReaders(f.options);
  assert.equal(readers.sourcePaths({ repository: 'fixture-source', commit: f.binding.commit, path: 'missing' }), null);
  assert.throws(() => declaredTestSource(f.binding, f.manifest, { ...f.options, repositories: { 'fixture-source': join(f.repo, 'missing') } }), /repository owner/);
});

test('undeclared, missing and redirected files are refused before a source byte is accepted', t => {
  const f = fixture(t), source = f.open();
  for (const path of ['../outside.ts', '/outside.ts', 'not-declared.ts']) assert.throws(() => source.read(path), /relative|manifest/);
  unlinkSync(join(f.repo, 'client/value.ts'));
  assert.throws(() => source.read('value.ts'), /ENOENT/);
  symlinkSync(join(f.repo, 'outside.ts'), join(f.repo, 'client/value.ts'));
  assert.throws(() => source.read('value.ts'), /redirected/);
});

test('normal resolution cannot load another source owner through a relative escape', async t => {
  const f = fixture(t), source = f.open();
  await assert.rejects(build({ absWorkingDir: source.root, entryPoints: ['escape.ts'], bundle: true, write: false,
    logLevel: 'silent', plugins: [source.plugin()] }), /leaves the declared source/);
  assert.equal(readFileSync(join(f.repo, 'outside.ts'), 'utf8'), f.files['outside.ts']);
});

test('normal package resolution metadata cannot drift away from the declared source', async t => {
  const f = fixture(t), source = f.open();
  writeFileSync(join(f.repo, 'client/package.json'), '{"type":"commonjs"}\n');
  await assert.rejects(build({ absWorkingDir: source.root, entryPoints: ['main.ts'], bundle: true, write: false,
    logLevel: 'silent', plugins: [source.plugin()] }), /resolution metadata differs/);
});

test('production read methods use the same committed source and refuse undeclared files without mutating disk', t => {
  const f = fixture(t), source = f.open();
  writeFileSync(join(f.repo, 'client/value.ts'), 'uncommitted source');
  writeFileSync(join(f.repo, 'client/untracked.ts'), 'untracked source');
  assert.equal(source.fs.readFileSync(join(f.repo, 'client/value.ts'), 'utf8'), f.files['client/value.ts']);
  assert.equal(source.fs.existsSync(join(f.repo, 'client/untracked.ts')), false);
  assert.throws(() => source.fs.readFileSync(join(f.repo, 'outside.ts')), /does not contain/);
  assert.throws(() => source.fs.readFileSync(join(f.repo, 'client/untracked.ts')), /manifest/);
  assert.ok(source.fs.statSync(join(f.repo, 'client')).isDirectory());
  assert.ok(source.fs.statSync(join(f.repo, 'client/value.ts')).isFile());
  const entries = source.fs.readdirSync(join(f.repo, 'client'), { withFileTypes: true });
  assert.ok(entries.some(entry => entry.name === 'value.ts' && entry.isFile()));
  assert.ok(!entries.some(entry => entry.name === 'untracked.ts'));
  assert.equal(readFileSync(join(f.repo, 'client/value.ts'), 'utf8'), 'uncommitted source');
});

test('an ordinary production module executes only after its complete local import closure matches committed bytes', async t => {
  const f = fixture(t), source = f.open();
  assert.equal((await source.module('tool.mjs')).answer, 42);
  writeFileSync(join(f.repo, 'client/module-value.mjs'), 'export const value = 99;\n');
  await assert.rejects(source.module('tool.mjs'), /differs from its declared committed source/);
});

test('the shared repository APIs retain exact origins and regular-file commit inventories under missing or redirected requests', t => {
  const f = fixture(t), readers = gitReaders(f.options);
  const source = { repository: f.binding.repository, commit: f.binding.commit, path: 'client' };
  const original = Object.keys(f.files).filter(path => path.startsWith('client/')).sort();
  assert.equal(readers.repositoryOrigin(source.repository), f.binding.origin);
  assert.equal(readers.repositoryOrigin('missing-repository'), null);
  assert.deepEqual(readers.sourcePaths(source), original);
  for (const path of ['missing', 'client/value.ts', '../client', '/client']) assert.equal(readers.sourcePaths({ ...source, path }), null, path);
  assert.equal(readers.sourcePaths({ ...source, repository: 'missing-repository' }), null);
  writeFileSync(join(f.repo, 'client/new.ts'), 'export const newer = true;\n');
  symlinkSync('value.ts', join(f.repo, 'client/alias.ts'));
  symlinkSync('.', join(f.repo, 'client/alias-directory'));
  f.git('add', 'client'); f.git('commit', '-qm', 'Advance synthetic source');
  const next = { ...source, commit: f.git('rev-parse', 'HEAD') };
  assert.notEqual(next.commit, source.commit);
  assert.deepEqual(readers.sourcePaths(source), original, 'advancing HEAD never changes the named immutable inventory');
  assert.deepEqual(readers.sourcePaths(next), [...original, 'client/new.ts'].sort(), 'this is a regular-file API, not a raw alias inventory');
  assert.equal(readers.sourcePaths({ ...next, path: 'client/alias-directory' }), null);
  assert.equal(readers.readSource({ ...next, path: 'client/alias.ts' }), null);
  assert.throws(() => declaredTestSource({ ...f.binding, commit: 'HEAD' }, f.manifest, f.options), /exact commit/);
});
