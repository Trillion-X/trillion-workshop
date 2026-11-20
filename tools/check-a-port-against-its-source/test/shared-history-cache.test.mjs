// Actual Git histories prove shared work stays bounded without losing paths, branch ancestry or source bytes.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { judgeRepository } from '../do-work/check-a-repository-for-port-contracts.mjs';
import { validateReferenceAdaptationContract } from '../do-work/validate-reference-adaptation-contract.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const SOURCE = Array.from({ length: 12 }, (_, i) => `export function keepHistoricalRowsInOrder${i}(rows) { return rows.slice(${i}); }`).join('\n') + '\n';
const identity = (text) => makeHashCodeHexFromBytes(Buffer.from(text));
function git(root, ...args) { return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof text === 'string' || Buffer.isBuffer(text) ? text : JSON.stringify(text));
  }
}
function commit(root, files = {}) {
  write(root, files); git(root, 'add', '-A');
  git(root, '-c', 'user.name=cache-test', '-c', 'user.email=cache@example.test', 'commit', '-qm', 'synthetic history');
  return git(root, 'rev-parse', 'HEAD');
}
function fixture(t) {
  const base = tempFolder(join(tmpdir(), 'shared-port-history-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'tools-repo'); mkdirSync(root); git(root, 'init', '-q', '-b', 'main');
  const initial = commit(root, { 'README.md': 'Synthetic source history.\n' });
  return { root, base, initial };
}
function traceGit(t) {
  const calls = [], original = childProcess.execFileSync;
  childProcess.execFileSync = function (file, args, options) {
    if (file === 'git') calls.push([...args]);
    return original.call(this, file, args, options);
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
  return calls;
}
function withGitEnvironment(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try { return run(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('many targets and repeated proofs share one immutable history scan and copied source bytes', (t) => {
  const { root } = fixture(t);
  const old = Array.from({ length: 8 }, (_, index) => `tools/rows/do-work/old-${index}.mjs`);
  const texts = old.map((_, index) => `${SOURCE}export const sourceNumber = ${index};\n`);
  const copy = commit(root, Object.fromEntries(old.map((path, index) => [path, texts[index]])));
  const active = old.map((path, index) => index < 2 ? path.replace('old-', 'renamed-') : path);
  for (let index = 0; index < 2; index += 1) git(root, 'mv', old[index], active[index]);
  commit(root);
  const tip = commit(root, Object.fromEntries(active.map((path, index) => [path, `${texts[index]}export const adaptedAfterTheCopy = true;\n`])));
  const calls = traceGit(t), reader = gitReaders({ root, tree: tip });
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const history = reader.baselineHistory(copy, active);
    assert.equal(history.ancestor, true);
    for (let index = 0; index < active.length; index += 1) {
      assert.equal(history.targets[index].introductionsOrdered, true);
      assert.equal(history.targets[index].atBaseline.toString(), texts[index]);
      assert.equal(history.targets[index].before[0].toString(), texts[index]);
      assert.equal(reader.targetAtCommit(copy, active[index]).toString(), texts[index]);
      assert.match(reader.readTarget(active[index]).toString(), /adaptedAfterTheCopy/);
      history.targets[index].atBaseline.fill(0);
      history.targets[index].before[0].fill(0);
    }
  }
  const logs = calls.filter((args) => args.includes('log'));
  assert.equal(logs.length, 1, JSON.stringify(logs));
  assert.ok(!logs[0].includes('--follow'), 'the shared scan must not restart per-path Git history walks');
  assert.ok(calls.length <= active.length * 2 + 20, `unexpected per-target command growth: ${calls.length}`);
});

test('a fresh reader sees a later merged sibling introduction and never reuses another tip\'s ancestry', (t) => {
  const { root, initial } = fixture(t);
  const path = 'tools/rows/do-work/core.mjs', bad = 'tools/rows/do-work/sibling.mjs';
  const copy = commit(root, { [path]: SOURCE });
  const tip = commit(root, { [path]: `${SOURCE}export const adaptedCore = true;\n` });
  const calls = traceGit(t), earlier = gitReaders({ root, tree: tip });
  assert.equal(earlier.baselineHistory(copy, [path]).ancestor, true);
  assert.equal(earlier.readTarget(bad), null);
  write(root, { [bad]: SOURCE }); git(root, 'add', '-A');
  const tree = git(root, 'write-tree');
  const sibling = git(root, '-c', 'user.name=cache-test', '-c', 'user.email=cache@example.test', 'commit-tree', tree, '-p', initial, '-m', 'unrelated source introduction');
  const merge = git(root, '-c', 'user.name=cache-test', '-c', 'user.email=cache@example.test', 'commit-tree', tree, '-p', tip, '-p', sibling, '-m', 'merge sibling');
  git(root, 'update-ref', 'refs/heads/main', merge);
  assert.equal(earlier.readTarget(bad), null, 'the original immutable reader keeps its exact judged tip');
  const current = gitReaders({ root, tree: merge });
  assert.equal(current.baselineHistory(copy, [bad]).targets[0].introductionsOrdered, false);
  assert.equal(calls.filter((args) => args.includes('log')).length, 2);
});

test('cached history keeps fresh graft/shallow refusal and NUL-safe rename evidence', (t) => {
  const { root } = fixture(t);
  const old = 'tools/rows/do-work/old\tπ.mjs', active = 'tools/rows/do-work/current-π.mjs';
  const copy = commit(root, { [old]: SOURCE });
  git(root, 'mv', old, active); const tip = commit(root, { [active]: `${SOURCE}export const adaptedUnicodeName = true;\n` });
  const reader = gitReaders({ root, tree: tip });
  assert.equal(reader.targetAtCommit(copy, active).toString(), SOURCE);
  assert.equal(reader.baselineHistory(copy, [active]).targets[0].atBaseline.toString(), SOURCE);
  for (const file of ['info/grafts', 'shallow']) {
    const path = join(root, '.git', file); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${copy}\n`);
    assert.equal(reader.baselineHistory(copy, [active]), null);
    rmSync(path);
    assert.equal(reader.baselineHistory(copy, [active]).ancestor, true);
  }
});

test('code searches share published snapshots, return copies and stay isolated by repository and reader', (t) => {
  const { root, base } = fixture(t);
  const other = join(base, 'other-owner'); mkdirSync(other); git(other, 'init', '-q', '-b', 'main');
  commit(other, { 'src/unrelated.mjs': 'export const anotherOwner = true;\n' });
  const tip = commit(root, { 'src/original.mjs': 'export const sourceCoverage = true;\n', 'src/sourceCoverage-name.txt': 'A filename match.\n' });
  git(root, 'update-ref', 'refs/remotes/origin/main', tip);
  const calls = traceGit(t), reader = gitReaders({ root, tree: tip });
  const expected = ['src/original.mjs', 'src/sourceCoverage-name.txt'];
  const first = reader.searchCode('tools-repo', 'sourceCoverage'); assert.deepEqual(first, expected); first.push('forged');
  assert.deepEqual(reader.searchCode('tools-repo', 'sourceCoverage'), expected);
  assert.deepEqual(reader.searchCode('other-owner', 'sourceCoverage'), []);
  const next = commit(root, { 'src/another.mjs': 'export const sourceCoverage = true;\n' });
  git(root, 'update-ref', 'refs/remotes/origin/main', next);
  assert.deepEqual(reader.searchCode('tools-repo', 'sourceCoverage'), expected);
  assert.deepEqual(gitReaders({ root, tree: next }).searchCode('tools-repo', 'sourceCoverage'), ['src/another.mjs', ...expected]);
  assert.equal(calls.filter((args) => args.includes('grep')).length, 3);
});

test('one complete contract validates once for two claimed features without admitting an unclaimed third feature', (t) => {
  const { root } = fixture(t), marker = 'uniqueMechanismForWholeContractMemo';
  const source = `${SOURCE}export const ${marker} = true;\n`;
  const sourceCommit = commit(root, { 'legacy/original.mjs': source });
  const one = 'tools/rows/do-work/one.mjs', two = 'tools/rows/do-work/two.mjs', unclaimed = 'tools/rows/do-work/three.mjs';
  const copy = commit(root, { [one]: source });
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-WHOLE-CONTRACT-MEMO', status: 'ADAPTED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'port the original row functions', message_multihash: identity('port the original row functions') },
    sources: [{ repository: 'tools-repo', commit: sourceCommit, path: 'legacy/original.mjs', multihash: identity(source), ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-03T00:00:00Z' } }],
    targets: [{ path: one }, { path: two }], preserve: ['the original ordering functions'], allowed_deltas: ['a helper'], banned_substitutions: ['rewriting the source'],
    baseline: { commit: copy, recorded_at: '2026-01-01T00:00:00Z', copied_before_adaptation: true, source_multihash: identity(source), target_multihash_at_baseline: identity(source) },
    proof: { minimum_meaningful_line_retention: 0.8, required_mechanisms: [marker], test_refs: [] },
  };
  commit(root, { [one]: `${source}export const adaptedCore = true;\n`, [two]: 'export const additionalHelperForRows = true;\n', [unclaimed]: 'export const unrelatedFeatureStillNeedsAnOwner = true;\n', 'tools/rows/ports/core.json': contract });
  const rules = { schema: 'port-contracts/feature-files', since: sourceCommit, feature_files: [{ matches: '^tools/[^/]+/do-work/[^/]+\\.mjs$', added: true }], contracts_match: '^tools/[^/]+/ports/[^/]+\\.json$', modes: ['SOURCE_FIRST_PORT'], retention_at_least: 0.6, old_copy_days_at_most: 3 };
  let validations = 0;
  const original = String.prototype.includes;
  String.prototype.includes = function (needle, ...rest) { if (needle === marker) validations += 1; return original.call(this, needle, ...rest); };
  let result;
  try { result = judgeRepository({ root, span: { from: sourceCommit, to: 'HEAD' }, rules, now: '2026-01-02T00:00:00Z' }); }
  finally { String.prototype.includes = original; }
  assert.equal(validations, 1, 'the required mechanism is checked once by the complete contract validation');
  assert.equal(result.valid, false);
  assert.deepEqual(result.judged.find((entry) => entry.path === one).errors, []);
  assert.deepEqual(result.judged.find((entry) => entry.path === two).errors, []);
  assert.match(result.judged.find((entry) => entry.path === unclaimed).errors.join('\n'), /no contract/);
});

test('inherited Git directory variables cannot retire or search a different declared source repository', (t) => {
  const { root, base } = fixture(t), old = 'legacy/original.mjs', active = 'tools/rows/do-work/core.mjs';
  const sourceCommit = commit(root, { [old]: SOURCE });
  const external = join(base, 'other-owner');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', root, external]);
  const copy = commit(root, { 'proofs/source.mjs': SOURCE });
  commit(root, { [active]: `${SOURCE}export const adaptedCore = true;\n` });
  git(root, 'rm', old); const candidate = commit(root); git(root, 'update-ref', 'refs/remotes/origin/main', candidate);
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-EXTERNAL-ENVIRONMENT-SCOPE', status: 'VERIFIED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'port the original row functions', message_multihash: identity('port the original row functions') },
    sources: [{ repository: 'other-owner', commit: sourceCommit, path: old, multihash: identity(SOURCE), ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-03T00:00:00Z' } }],
    targets: [{ path: active }], preserve: ['ordering'], allowed_deltas: ['one export'], banned_substitutions: ['a rewrite'],
    baseline: { path: 'proofs/source.mjs', commit: copy, recorded_at: '2026-01-01T00:00:00Z', copied_before_adaptation: true, source_multihash: identity(SOURCE), target_multihash_at_baseline: identity(SOURCE) },
    proof: { minimum_meaningful_line_retention: 0.8, required_mechanisms: ['keepHistoricalRowsInOrder3'], test_refs: ['synthetic-source.test.mjs'] },
  };
  withGitEnvironment({ GIT_DIR: join(root, '.git'), GIT_WORK_TREE: root, GIT_COMMON_DIR: join(root, '.git') }, () => {
    const reader = gitReaders({ root, tree: candidate });
    const result = validateReferenceAdaptationContract(contract, { readers: reader, repository: 'tools-repo', activeTargetPaths: [active], stage: 'completion', now: '2026-01-04T00:00:00Z' });
    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join('\n'), /old copy.*still lives/);
    assert.equal(reader.mainOf('other-owner'), sourceCommit);
    assert.ok(reader.searchCode('other-owner', 'keepHistoricalRowsInOrder').includes(old));
  });
});

test('the judge cannot hide a declared repository\'s changed features behind an inherited foreign Git directory', (t) => {
  const { root, base, initial } = fixture(t);
  const foreign = join(base, 'foreign'); execFileSync('git', ['clone', '--quiet', '--no-hardlinks', root, foreign]);
  const active = 'tools/rows/do-work/unclaimed.mjs'; commit(root, { [active]: SOURCE });
  const rules = { schema: 'port-contracts/feature-files', since: initial, feature_files: [{ matches: '^tools/[^/]+/do-work/[^/]+\\.mjs$', added: true }], contracts_match: '^tools/[^/]+/ports/[^/]+\\.json$', modes: ['SOURCE_FIRST_PORT'] };
  withGitEnvironment({ GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_COMMON_DIR: join(foreign, '.git') }, () => {
    const result = judgeRepository({ root, span: { from: initial, to: 'HEAD' }, rules });
    assert.equal(result.valid, false, JSON.stringify(result));
    assert.equal(result.judged[0].path, active);
    assert.match(result.judged[0].errors.join('\n'), /no contract/);
  });
});

test('declared self reads ignore foreign Git directories while staged reads keep the caller\'s private index', (t) => {
  const { root, base } = fixture(t), path = 'tools/rows/do-work/core.mjs';
  const published = 'export const publishedSelfBytes = true;\n', staged = 'export const callerPrivateIndexBytes = true;\n';
  commit(root, { [path]: published });
  const foreign = join(base, 'foreign'); execFileSync('git', ['clone', '--quiet', '--no-hardlinks', root, foreign]);
  commit(foreign, { [path]: 'export const foreignRepositoryBytes = true;\n' });
  const index = join(base, 'caller.index'), env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync('git', ['--no-replace-objects', '-C', root, 'read-tree', 'HEAD'], { env });
  write(root, { [path]: staged });
  execFileSync('git', ['--no-replace-objects', '-C', root, 'add', '--', path], { env });
  withGitEnvironment({ GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_COMMON_DIR: join(foreign, '.git'), GIT_INDEX_FILE: index }, () => {
    assert.equal(gitReaders({ root, tree: 'HEAD' }).readTarget(path)?.toString(), published);
    assert.equal(gitReaders({ root, tree: ':' }).readTarget(path)?.toString(), staged);
    const rules = { schema: 'port-contracts/feature-files', feature_files: [{ matches: '^tools/[^/]+/do-work/[^/]+\\.mjs$', grown_lines_over: 0 }], contracts_match: '^tools/[^/]+/ports/[^/]+\\.json$', modes: ['SOURCE_FIRST_PORT'] };
    const result = judgeRepository({ root, span: { staged: true }, rules });
    assert.equal(result.valid, false, JSON.stringify(result));
    assert.equal(result.judged[0].path, path);
    assert.match(result.judged[0].errors.join('\n'), /no contract/);
  });
});

test('a judgment freezes both diff endpoints when branch refs move after its tree reads begin', (t) => {
  const { root, initial } = fixture(t), path = 'tools/rows/do-work/unclaimed.mjs';
  const tip = commit(root, { [path]: SOURCE });
  git(root, 'update-ref', 'refs/heads/start', initial);
  const rules = { schema: 'port-contracts/feature-files', since: initial, feature_files: [{ matches: '^tools/[^/]+/do-work/[^/]+\\.mjs$', added: true }], contracts_match: '^tools/[^/]+/ports/[^/]+\\.json$', modes: ['SOURCE_FIRST_PORT'] };
  const original = childProcess.execFileSync;
  let moved = false, result;
  childProcess.execFileSync = function (file, args, options) {
    const out = original.call(this, file, args, options);
    if (!moved && file === 'git' && args.includes('ls-tree')) {
      moved = true;
      original('git', ['-C', root, 'update-ref', 'refs/heads/main', initial]);
      original('git', ['-C', root, 'update-ref', 'refs/heads/start', tip]);
    }
    return out;
  };
  syncBuiltinESMExports();
  try { result = judgeRepository({ root, span: { from: 'refs/heads/start', to: 'HEAD' }, rules }); }
  finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
  assert.equal(moved, true);
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.equal(result.judged[0].path, path);
  const fixed = judgeRepository({ root, span: { from: initial, to: tip }, rules });
  assert.equal(fixed.valid, false);
  assert.deepEqual(result.judged, fixed.judged);
});

test('a staged judgment refuses an index generation changed during discovery and judges an unchanged index', (t) => {
  const { root, initial } = fixture(t), path = 'tools/rows/do-work/unclaimed.mjs';
  write(root, { [path]: SOURCE }); git(root, 'add', '--', path);
  const rules = { schema: 'port-contracts/feature-files', since: initial, feature_files: [{ matches: '^tools/[^/]+/do-work/[^/]+\\.mjs$', added: true }], contracts_match: '^tools/[^/]+/ports/[^/]+\\.json$', modes: ['SOURCE_FIRST_PORT'] };
  const original = childProcess.execFileSync;
  let changed = false;
  childProcess.execFileSync = function (file, args, options) {
    const out = original.call(this, file, args, options);
    if (!changed && file === 'git' && args.includes('ls-files')) {
      changed = true;
      original('git', ['-C', root, 'read-tree', 'HEAD']);
    }
    return out;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => judgeRepository({ root, span: { staged: true }, rules }), /staged index changed/); }
  finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
  assert.equal(changed, true);
  git(root, 'add', '--', path);
  const stable = judgeRepository({ root, span: { staged: true }, rules });
  assert.equal(stable.valid, false);
  assert.equal(stable.judged[0].path, path);
  assert.match(stable.judged[0].errors.join('\n'), /no contract/);
});

test('targetState preserves absent, regular and unreadable modes across disk, index and committed views', (t) => {
  const { root } = fixture(t);
  write(root, { 'src/regular.mjs': SOURCE, 'src/executable.mjs': SOURCE, 'src/other-executable.mjs': SOURCE, 'src/folder/child.mjs': SOURCE });
  chmodSync(join(root, 'src/executable.mjs'), 0o755);
  chmodSync(join(root, 'src/other-executable.mjs'), 0o645);
  symlinkSync('regular.mjs', join(root, 'src/alias.mjs'));
  symlinkSync('folder', join(root, 'src/alias-folder'));
  const tip = commit(root);
  for (const tree of [undefined, ':', tip]) {
    const reader = gitReaders({ root, tree });
    for (const [path, mode] of [['src/regular.mjs', '100644'], ['src/executable.mjs', '100755'], ['src/other-executable.mjs', '100644']]) {
      const state = reader.targetState(path);
      assert.equal(state.state, 'regular'); assert.equal(state.mode, mode); assert.equal(state.bytes.toString(), SOURCE);
      state.bytes.fill(0); state.state = 'absent';
      assert.equal(reader.targetState(path).bytes.toString(), SOURCE, 'public state bytes cannot alter cached evidence');
    }
    assert.deepEqual(reader.targetState('src/absent.mjs'), { state: 'absent' });
    assert.deepEqual(reader.targetState('src/alias.mjs'), { state: 'unreadable', mode: '120000' });
    assert.deepEqual(reader.targetState('src/folder'), { state: 'unreadable', mode: '040000' });
    assert.deepEqual(reader.targetState('src/alias-folder/child.mjs'), { state: 'unreadable' });
    assert.deepEqual(reader.targetState('../outside.mjs'), { state: 'unreadable' });
    assert.equal(reader.readTarget('src/alias.mjs'), null, 'the existing collapsed API stays compatible');
  }
  assert.deepEqual(gitReaders({ root, tree: 'f'.repeat(40) }).targetState('src/regular.mjs'), { state: 'unreadable' });
});

test('targetState keeps unreadable Git blobs distinct from absent paths and preserves their known mode', (t) => {
  const { root } = fixture(t);
  const tip = commit(root, { 'src/core.mjs': SOURCE });
  const original = childProcess.execFileSync;
  childProcess.execFileSync = function (file, args, options) {
    if (file === 'git' && args.includes('cat-file') && args.includes('blob')) throw new Error('synthetic object read failure');
    return original.call(this, file, args, options);
  };
  syncBuiltinESMExports();
  try {
    for (const tree of [':', tip]) assert.deepEqual(gitReaders({ root, tree }).targetState('src/core.mjs'), { state: 'unreadable', mode: '100644' });
  } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
});

test('targetState refuses an index changed during blob reading and keeps committed reads bound when HEAD moves', (t) => {
  const { root, initial } = fixture(t);
  const tip = commit(root, { 'src/core.mjs': SOURCE });
  const staged = gitReaders({ root, tree: ':' }); staged.snapshotSpan({ staged: true });
  const committed = gitReaders({ root, tree: tip });
  const original = childProcess.execFileSync;
  let changed = false;
  childProcess.execFileSync = function (file, args, options) {
    const out = original.call(this, file, args, options);
    if (!changed && file === 'git' && args.includes('cat-file') && args.includes('blob')) {
      changed = true;
      original('git', ['-C', root, 'read-tree', initial]);
      original('git', ['-C', root, 'update-ref', 'refs/heads/main', initial]);
    }
    return out;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => staged.targetState('src/core.mjs'), /staged index changed/); }
  finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
  assert.equal(changed, true);
  assert.throws(() => staged.targetState('src/core.mjs'), /staged index changed/);
  assert.equal(committed.targetState('src/core.mjs').bytes.toString(), SOURCE);
  assert.deepEqual(gitReaders({ root, tree: 'HEAD' }).targetState('src/core.mjs'), { state: 'absent' });
});

test('an unpinned targetState read returns unreadable for a changing index and refreshes on its next read', (t) => {
  const { root, initial } = fixture(t);
  commit(root, { 'src/core.mjs': SOURCE });
  const staged = gitReaders({ root, tree: ':' });
  const original = childProcess.execFileSync;
  let changed = false;
  childProcess.execFileSync = function (file, args, options) {
    const out = original.call(this, file, args, options);
    if (!changed && file === 'git' && args.includes('cat-file') && args.includes('blob')) {
      changed = true;
      original('git', ['-C', root, 'read-tree', initial]);
    }
    return out;
  };
  syncBuiltinESMExports();
  try { assert.deepEqual(staged.targetState('src/core.mjs'), { state: 'unreadable' }); }
  finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
  assert.equal(changed, true);
  assert.deepEqual(staged.targetState('src/core.mjs'), { state: 'absent' });
  assert.equal(gitReaders({ root }).targetState('src/core.mjs').bytes.toString(), SOURCE);
});


test('prepared searches preserve exact per-pattern Git semantics and scan all source paths only once', (t) => {
  const {root} = fixture(t);
  const paths = ['src/a.mjs', 'src/[literal]*.mjs', 'src/tab\tline\n.mjs', 'src/filename_only.mjs'];
  const tip = commit(root, {
    [paths[0]]: 'export const alpha = "aa";\n',
    [paths[1]]: 'export const beta = "bb";\n',
    [paths[2]]: 'export const both = "alpha beta";\n',
    [paths[3]]: 'export const unrelated = true;\n',
    'src/binary.bin': Buffer.from([0, 97, 108, 112, 104, 97]),
    'src/duplicate-a.txt': 'alpha\nalpha\n',
    'src/duplicate-b.txt': 'alpha\n',
  });
  const patterns = ['alpha', 'beta', '(a)\\1', '(b)\\1', 'filename_only', '.*', '^export const alpha', 'true;$', 'alpha.*beta'];
  const ordinary = gitReaders({root, tree: tip});
  const expected = patterns.map(pattern => ordinary.searchCode('tools-repo', pattern));
  const calls = traceGit(t), prepared = gitReaders({root, tree: tip});
  prepared.prepareCodeSearch(['tools-repo'], patterns);
  for (let index = 0; index < patterns.length; index += 1) {
    assert.deepEqual(prepared.searchCode('tools-repo', patterns[index]), expected[index]);
  }
  const greps = calls.filter(args => args.includes('grep'));
  assert.equal(greps.filter(args => args.at(-1) === '--').length, 1, 'only the union scans every path');
  assert.ok(greps.filter(args => args.includes('--no-index')).length === patterns.length, 'Git itself classifies the retained complete lines');
  assert.deepEqual(prepared.searchCode('tools-repo', 'unrelated'), ordinary.searchCode('tools-repo', 'unrelated'),
    'a pattern outside the prepared set keeps the original full search');
  const copy = prepared.searchCode('tools-repo', 'alpha'); copy.length = 0;
  assert.deepEqual(prepared.searchCode('tools-repo', 'alpha'), expected[0]);
});


test('the judge warms only contracts that claim an actual declared feature change', (t) => {
  const {root} = fixture(t), active = 'tools/rows/do-work/core.mjs', unused = 'tools/rows/do-work/unchanged.mjs';
  const initial = commit(root, {[active]: 'export const before = true;\n', [unused]: 'export const stable = true;\n'});
  const contract = (path, pattern) => ({schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-' + pattern, status: 'ADAPTED', mode: 'NO_PRIOR_OWNER', targets: [{path}],
    proof: {search: {job: pattern, phrasings: [pattern], code_patterns: [pattern], repositories: []}}});
  const tip = commit(root, {[active]: 'export const marker_active = true;\n',
    'tools/rows/ports/active.json': contract(active, 'marker_active'),
    'tools/rows/ports/unused.json': contract(unused, 'must_never_be_warmed')});
  const rules = {schema: 'port-contracts/feature-files', feature_files: [{matches: '^tools/[^/]+/do-work/[^/]+[.]mjs$', added: true, grown_lines_over: 0}],
    contracts_match: '^tools/[^/]+/ports/[^/]+[.]json$', modes: ['NO_PRIOR_OWNER']};
  const calls = traceGit(t);
  const result = judgeRepository({root, span: {from: initial, to: tip}, rules, searchRepositories: ['tools-repo']});
  assert.deepEqual(result.judged.map(change => change.path), [active]);
  const greps = calls.filter(args => args.includes('grep'));
  assert.ok(greps.some(args => args.includes('marker_active')), 'the claimed change is searched');
  assert.ok(greps.every(args => !args.includes('must_never_be_warmed')), 'an unchanged unjudged contract adds no search work');
});


test('immutable target batches keep byte-exact copied blobs without per-contract subprocesses', t => {
  const {root} = fixture(t);
  const files = {'ports/first.json': '{"id":"one"}\n', 'ports/tab\tline\n.json': '{"id":"two"}\n',
    'ports/binary.json': Buffer.from([0, 255, 10, 65])};
  const tip = commit(root, files), calls = traceGit(t), reader = gitReaders({root, tree: tip});
  reader.prepareTargetReads([...Object.keys(files), 'ports/missing.json']);
  for (const [path, bytes] of Object.entries(files)) assert.deepEqual(reader.readTarget(path), Buffer.from(bytes));
  reader.readTarget('ports/first.json').fill(0);
  assert.equal(reader.readTarget('ports/first.json').toString(), files['ports/first.json']);
  assert.equal(calls.filter(args => args.includes('--batch')).length, 1);
  assert.equal(calls.filter(args => args.includes('cat-file') && args.includes('blob')).length, 0);
  const staged = gitReaders({root, tree: ':'});
  staged.prepareTargetReads(Object.keys(files));
  assert.equal(calls.filter(args => args.includes('--batch')).length, 1, 'private index generation stays on its fresh read route');
});

test('a malformed optional batch seeds no partial target cache and falls back to original blob reads', t => {
  const {root} = fixture(t), files = {'ports/a.json': '{"id":"a"}\n', 'ports/b.json': '{"id":"b"}\n'};
  const tip = commit(root, files), original = childProcess.execFileSync;
  let batches = 0, singles = 0;
  childProcess.execFileSync = function (file, args, options) {
    const out = original.call(this, file, args, options);
    if (file === 'git' && args.includes('--batch')) { batches++; return out.subarray(0, out.length - 1); }
    if (file === 'git' && args.includes('cat-file') && args.includes('blob')) singles++;
    return out;
  };
  syncBuiltinESMExports();
  try {
    const reader = gitReaders({root, tree: tip}); reader.prepareTargetReads(Object.keys(files));
    for (const [path, bytes] of Object.entries(files)) assert.equal(reader.readTarget(path).toString(), bytes);
    assert.equal(batches, 1); assert.equal(singles, 2);
  } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
});
