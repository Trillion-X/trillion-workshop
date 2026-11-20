// Git's actual rename edges, rather than equal file bytes, establish same-file source continuity.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from '../do-work/validate-reference-adaptation-contract.mjs';
import { judgeRepository } from '../do-work/check-a-repository-for-port-contracts.mjs';

const OLD = 'src/old.mjs', MIDDLE = 'src/middle.mjs', CURRENT = 'src/current.mjs', TWIN = 'src/twin.mjs';
const SOURCE = Array.from({ length: 12 }, (_, index) =>
  `export function preserveRenamedRows${index}(rows) { return rows.slice(${index}); }`).join('\n') + '\n';
const ADAPTED = `${SOURCE}export const currentRenamedAdapter = true;\n`;
const EARLIER = 'export const earlierDevelopmentOfTheOriginal = true;\n';
const UNRELATED = 'export const unrelatedPriorOwnerOfCurrentPath = true;\n';
const identity = bytes => makeHashCodeHexFromBytes(Buffer.from(bytes));
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const NOW = '2026-01-04T00:00:00Z';

function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root, path, contents) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`);
}

function commit(root, files = {}, message = 'synthetic identity event') {
  for (const [path, contents] of Object.entries(files)) write(root, path, contents);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(t, { reusedCurrent = false, sourceAfterPolicy = false } = {}) {
  const home = tempFolder(join(tmpdir(), 'same-file-rename-identity-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'same-file-owner');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'same-file-identity-test');
  git(root, 'config', 'user.email', 'identity@example.test');
  const initial = commit(root, { [OLD]: EARLIER, ...(reusedCurrent ? { [CURRENT]: UNRELATED } : {}) }, 'pre-policy development');
  if (reusedCurrent) git(root, 'rm', '-q', CURRENT);
  const snapshot = commit(root, { [OLD]: SOURCE }, 'complete original source snapshot');
  return { root, initial, snapshot, since: sourceAfterPolicy ? initial : snapshot };
}

function declaration(f, { targets = [CURRENT], sources = [OLD] } = {}) {
  const digest = identity(SOURCE);
  return {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-SYNTHETIC-SAME-FILE-RENAME', status: 'VERIFIED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'Preserve the original row functions while renaming this same file', message_multihash: identity('synthetic same-file rename') },
    sources: sources.map(path => ({ repository: basename(f.root), commit: f.snapshot, path, multihash: digest,
      ownership: 'repository-owned', old_copy: 'same-file' })),
    targets: targets.map(path => ({ path })), preserve: ['the twelve original row functions'],
    allowed_deltas: ['rename and one adapter export'], banned_substitutions: ['a byte copy claimed as file identity'],
    baseline: { commit: f.snapshot, copied_before_adaptation: true, source_multihash: digest,
      target_multihash_at_baseline: digest, recorded_at: '2026-01-01T00:00:00Z' },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['function preserveRenamedRows11'],
      test_refs: ['tools/check-a-port-against-its-source/test/same-file-rename-identity.test.mjs'] },
  };
}

function finish(f, contract = declaration(f)) {
  const rules = {
    schema: 'port-contracts/feature-files', since: f.since,
    feature_files: [{ matches: '^src/.+\\.mjs$', added: true, grown_lines_over: 0 }],
    contracts_match: '^ports/.+\\.json$', modes: ['SOURCE_FIRST_PORT'], retention_at_least: 0.6, old_copy_days_at_most: 3,
  };
  commit(f.root, { [CURRENT]: ADAPTED, 'ports/rename.json': contract, 'ports/feature-files.json': rules }, 'adapt after source continuity');
  const readers = gitReaders({ root: f.root, tree: 'HEAD' });
  const direct = validateReferenceAdaptationContract(contract, {
    readers, repository: readers.self, stage: 'completion', policySince: f.since,
    activeTargetPaths: [...new Set(contract.targets.map(one => one.path))], retentionAtLeast: 0.6,
    oldCopyDaysAtMost: 3, now: NOW,
  });
  const repository = judgeRepository({ root: f.root, span: { from: f.since, to: 'HEAD' }, now: NOW });
  return { direct, repository, readers };
}

function rename(f, from = OLD, to = CURRENT) {
  git(f.root, 'mv', from, to);
  const revision = commit(f.root, {}, `actual rename ${from} to ${to}`);
  assert.match(git(f.root, 'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', `${revision}^`, revision),
    new RegExp(`R100\\s+${from.replaceAll('.', '\\.')}\\s+${to.replaceAll('.', '\\.')}`));
  return revision;
}

function assertPass(result) {
  assert.deepEqual(result.direct.errors, [], JSON.stringify(result.direct));
  assert.deepEqual(result.direct.deferred, []);
  assert.equal(result.direct.valid, true);
  assert.equal(result.direct.measurements.meaningfulLineRetention, 1);
  assert.equal(result.repository.valid, true, JSON.stringify(result.repository));
  assert.deepEqual(result.repository.judged.map(one => one.path), [CURRENT]);
  assert.deepEqual(result.repository.judged[0].deferred, []);
}

function assertRefused(result) {
  assert.equal(result.direct.valid, false, JSON.stringify(result.direct));
  assert.deepEqual(result.direct.deferred, []);
  assert.match(result.direct.errors.join('\n'), /same-file|baseline.*history|baseline must precede|identity|bijection/);
  assert.equal(result.direct.measurements.meaningfulLineRetention, 1, 'identity refusal keeps all original source lines');
  assert.equal(result.repository.valid, false, JSON.stringify(result.repository));
}

for (const multihop of [false, true]) {
  test(`a genuine pre-policy source survives ${multihop ? 'multiple actual renames' : 'one actual rename'} and adaptation`, t => {
    const f = fixture(t);
    if (multihop) { rename(f, OLD, MIDDLE); rename(f, MIDDLE, CURRENT); }
    else rename(f);
    const result = finish(f);
    assert.deepEqual(result.readers.targetAtCommit(f.snapshot, CURRENT), Buffer.from(SOURCE), 'historical rename bytes alone already resolve');
    assert.deepEqual(result.readers.readSource({ repository: basename(f.root), commit: f.initial, path: OLD }), Buffer.from(EARLIER));
    assertPass(result);
  });
}

test('a merge-parent diff repeating a genuine rename preserves the same-file identity', t => {
  const f = fixture(t);
  git(f.root, 'branch', 'unrelated-side', f.snapshot);
  const moved = rename(f);
  commit(f.root, { [CURRENT]: ADAPTED }, 'adapt the renamed file on main');
  git(f.root, 'checkout', '-q', 'unrelated-side');
  const side = commit(f.root, { 'unrelated-side.txt': 'independent side-branch work\n' }, 'side branch keeps original source spelling');
  assert.equal(git(f.root, 'show', `${side}:${OLD}`), SOURCE.trimEnd());
  git(f.root, 'checkout', '-q', 'main');
  git(f.root, 'merge', '--no-ff', '-qm', 'merge side branch after main rename and adaptation', side);
  const merged = git(f.root, 'rev-parse', 'HEAD');
  assert.notEqual(merged, moved);
  const perParent = git(f.root, 'diff-tree', '-m', '--no-commit-id', '-r', '-M', '--name-status', merged);
  assert.match(perParent, /R\d+\s+src\/old\.mjs\s+src\/current\.mjs/, 'the merge repeats the original move against its side parent');
  const fullHistory = git(f.root, 'log', '--root', '--full-history', '-m', '-M', '--name-status', '--format=%H', merged);
  const reportedMoves = fullHistory.match(/R\d+\s+src\/old\.mjs\s+src\/current\.mjs/g) ?? [];
  assert.ok(reportedMoves.length >= 2, `the real per-parent history must contain repeated rename reports: ${fullHistory}`);
  assertPass(finish(f));
});

test('an equal-byte copy retaining the original path cannot claim same-file identity', t => {
  const f = fixture(t);
  const copied = commit(f.root, { [CURRENT]: SOURCE }, 'copy while original remains');
  assert.match(git(f.root, 'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', `${copied}^`, copied), /A\s+src\/current\.mjs/);
  const result = finish(f);
  assert.deepEqual(result.readers.readTarget(OLD), Buffer.from(SOURCE));
  assertRefused(result);
});

for (const declareBoth of [false, true]) {
  test(`identical split outputs cannot establish ${declareBoth ? 'two targets from one source' : 'an unambiguous chosen target'}`, t => {
    const f = fixture(t);
    git(f.root, 'mv', OLD, CURRENT);
    const split = commit(f.root, { [TWIN]: SOURCE }, 'delete source into two identical outputs');
    const changes = git(f.root, 'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', `${split}^`, split);
    assert.match(changes, /R100/);
    assert.match(changes, /A\s+/);
    assertRefused(finish(f, declaration(f, { targets: declareBoth ? [CURRENT, TWIN] : [CURRENT] })));
  });
}

test('a reused destination with unrelated pre-baseline history cannot inherit the source exception', t => {
  const f = fixture(t, { reusedCurrent: true });
  rename(f);
  assertRefused(finish(f));
});

test('a reused destination on an incomparable branch cannot inherit the source exception', t => {
  const f = fixture(t);
  const shared = f.snapshot;
  const baseline = commit(f.root, { 'baseline-marker.txt': 'declared pre-policy source\n' }, 'declare unchanged source snapshot');
  f.snapshot = baseline;
  f.since = baseline;
  git(f.root, 'checkout', '-q', '--detach', shared);
  commit(f.root, { [CURRENT]: UNRELATED }, 'unrelated parallel destination owner');
  git(f.root, 'rm', '-q', CURRENT);
  const deleted = commit(f.root, {}, 'retire unrelated parallel destination');
  git(f.root, 'checkout', '-q', '--detach', baseline);
  git(f.root, 'merge', '--no-ff', '-qm', 'merge deleted destination history', deleted);
  rename(f);
  assertRefused(finish(f));
});

test('an actual rename cannot grandfather a source snapshot pinned after policy', t => {
  const f = fixture(t, { sourceAfterPolicy: true });
  rename(f);
  assertRefused(finish(f));
});

test('parallel source adaptation and raw reversion remain refused across a later rename', t => {
  const f = fixture(t);
  const shared = f.snapshot;
  const baseline = commit(f.root, { 'baseline-marker.txt': 'declared original source\n' }, 'declare unchanged source snapshot');
  f.snapshot = baseline;
  f.since = baseline;
  git(f.root, 'checkout', '-q', '--detach', shared);
  commit(f.root, { [OLD]: ADAPTED }, 'parallel source adaptation');
  const reverted = commit(f.root, { [OLD]: SOURCE }, 'parallel revert to exact source');
  git(f.root, 'checkout', '-q', '--detach', baseline);
  git(f.root, 'merge', '--no-ff', '-qm', 'merge reverted raw source', reverted);
  rename(f);
  const result = finish(f);
  assert.equal(result.readers.baselineHistory(baseline, [CURRENT]).targets[0].introductionsOrdered, true);
  assertRefused(result);
});

for (const duplicate of ['source', 'target', 'both']) {
  test(`duplicate ${duplicate} entries cannot form a same-file bijection`, t => {
    const f = fixture(t);
    rename(f);
    const sources = duplicate === 'source' || duplicate === 'both' ? [OLD, OLD] : [OLD];
    const targets = duplicate === 'target' || duplicate === 'both' ? [CURRENT, CURRENT] : [CURRENT];
    assertRefused(finish(f, declaration(f, { sources, targets })));
  });
}
