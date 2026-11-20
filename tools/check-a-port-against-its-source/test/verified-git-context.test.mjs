// Real Git history controls; these do not establish native reader-context admission.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {registerHooks} from 'node:module';
import {gitReaders} from '../do-work/read-from-repositories.mjs';

let explicitGetterFixture;
export function readVerifiedGitContext() {
  if (!explicitGetterFixture || explicitGetterFixture.closed) throw new Error('explicit fixture owner lifetime ended');
  explicitGetterFixture.reads += 1;
  return structuredClone(explicitGetterFixture.context);
}

function fixture(t) {
  const root = tempFolder(join(tmpdir(), 'reader-context-history-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', root, ...args],
    {env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Synthetic reader');
  git('config', 'user.email', 'reader@example.invalid');
  const commit = (path, content) => {
    if (path) { mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), content); }
    git('add', '-A'); git('commit', '--allow-empty', '-qm', 'synthetic reader history');
    return git('rev-parse', 'HEAD');
  };
  return {root, git, commit, name: basename(root)};
}

test('publication is the actual remote-tracking main, never local HEAD or local main', t => {
  const {root, git, commit, name} = fixture(t);
  const first = commit('source.mjs', 'export const value = 1;\n');
  const reader = gitReaders({root});
  assert.equal(reader.publishedCommit(name), null);
  assert.equal(reader.mainOf(name), first, 'ordinary search fallback remains unchanged');
  git('update-ref', 'refs/remotes/origin/main', first);
  assert.equal(reader.publishedCommit(name), first);
  const second = commit('source.mjs', 'export const value = 2;\n');
  assert.equal(reader.publishedCommit(name), first, 'an unpublished local commit grants no publication');
  git('update-ref', 'refs/remotes/origin/main', second);
  assert.equal(reader.publishedCommit(name), second, 'the publication-only API rechecks its actual ref');
  git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.equal(reader.publishedCommit(name), null);
});

test('content introduced exactly at the baseline has no earlier content event', t => {
  const {root, commit} = fixture(t);
  const baseline = commit('source.mjs', 'export const baseline = true;\n');
  commit('source.mjs', 'export const baseline = true;\nexport const adapted = true;\n');
  const history = gitReaders({root}).baselineHistory(baseline, ['source.mjs']);
  assert.equal(history.ancestor, true);
  assert.equal(history.targets[0].contentBeforeBaseline, false);
});

test('earlier content remains visible through real rename and rename-back cycles', t => {
  const {root, git, commit} = fixture(t);
  commit('original.mjs', 'export const original = true;\n');
  git('mv', 'original.mjs', 'renamed.mjs'); commit();
  git('mv', 'renamed.mjs', 'original.mjs'); const baseline = commit();
  git('mv', 'original.mjs', 'current.mjs'); commit();
  const history = gitReaders({root}).baselineHistory(baseline, ['current.mjs']);
  assert.equal(history.ancestor, true);
  assert.equal(history.targets[0].contentBeforeBaseline, true);
});

test('content on a parallel parent counts even when its final bytes return to the baseline', t => {
  const {root, git, commit} = fixture(t);
  const common = commit('shared.txt', 'shared history before the target exists\n');
  git('branch', 'parallel', common);
  const baseline = commit('source.mjs', 'export const value = 1;\n');
  git('checkout', '-q', 'parallel');
  commit('source.mjs', 'export const value = 2;\n');
  commit('source.mjs', 'export const value = 1;\n');
  git('checkout', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'join genuine parallel history', 'parallel');
  const history = gitReaders({root}).baselineHistory(baseline, ['source.mjs']);
  assert.equal(history.targets[0].contentBeforeBaseline, true);
  assert.ok(history.targets[0].parallel.length);
});

test('explicit getter fixture binds real private-index reads and ordered parents; it is not native admission', async t => {
  const {root, git, commit} = fixture(t);
  const first = commit('target.mjs', 'export const before = true;\n');
  const tip = commit('target.mjs', 'export const after = true;\n');
  const index = join(root, '.git', 'fixture.index'), admin = join(root, '.git', 'fixture-admin');
  execFileSync('git', ['-C', root, 'read-tree', first], {env: {...process.env, GIT_INDEX_FILE: index}});
  mkdirSync(admin);
  writeFileSync(join(admin, 'HEAD'), `${tip}\n`);
  writeFileSync(join(admin, 'commondir'), `${join(root, '.git')}\n`);
  writeFileSync(join(admin, 'MERGE_HEAD'), `${first}\n`);
  explicitGetterFixture = {closed: false, reads: 0, context: {root, admin, common: join(root, '.git'), index,
    parents: [tip, first], hooks: {'reference-transaction': {path: join(root, '.git', 'fixture-hooks', 'reference-transaction')}}}};
  const oldMode = process.env.QUALIFIED_COMMITTED_READER_PROBE;
  process.env.QUALIFIED_COMMITTED_READER_PROBE = 'fixed-reader-comparison-v1';
  const hook = registerHooks({resolve(specifier, context, next) {
    if (specifier === 'trillion:verified-git-context') return {url: import.meta.url, shortCircuit: true};
    return next(specifier, context);
  }});
  t.after(() => {
    hook.deregister(); explicitGetterFixture = undefined;
    if (oldMode === undefined) delete process.env.QUALIFIED_COMMITTED_READER_PROBE;
    else process.env.QUALIFIED_COMMITTED_READER_PROBE = oldMode;
  });
  const {gitReaders: withFixtureGetter} = await import(new URL('../do-work/read-from-repositories.mjs?explicit-getter-fixture', import.meta.url));
  const readers = withFixtureGetter({root, tree: ':'});
  assert.deepEqual(readers.snapshotSpan({staged: true}).parents, [tip, first]);
  assert.equal(readers.readTarget('target.mjs').toString(), 'export const before = true;\n');
  assert.equal(readers.targetAtCommit(tip, 'target.mjs').toString(), 'export const after = true;\n');
  assert.throws(() => withFixtureGetter({root: dirname(root), tree: ':'}), /root|scope/);
  assert.throws(() => withFixtureGetter({root, tree: tip}), /staged tree/);
  const beforeCachedRead = explicitGetterFixture.reads;
  assert.equal(readers.readTarget('target.mjs').toString(), 'export const before = true;\n');
  assert.ok(explicitGetterFixture.reads > beforeCachedRead, 'cached bytes still recheck the fresh getter');
  explicitGetterFixture.closed = true;
  assert.throws(() => readers.readTarget('target.mjs'), /lifetime ended/);
  explicitGetterFixture.closed = false;
  explicitGetterFixture.context.parents.reverse();
  assert.throws(() => readers.mainOf(readers.self), /scope changed/);
  explicitGetterFixture.context.parents.reverse();
  execFileSync('git', ['-C', root, 'read-tree', tip], {env: {...process.env, GIT_INDEX_FILE: index}});
  assert.throws(() => readers.readTarget('target.mjs'), /staged index changed/);
  assert.equal(git('rev-parse', 'HEAD'), tip);
  delete process.env.QUALIFIED_COMMITTED_READER_PROBE;
  assert.equal(gitReaders({root, tree: ':', context: {index}}).readTarget('target.mjs').toString(),
    'export const after = true;\n', 'a caller context dictionary does not select an index in the ordinary reader');
});
