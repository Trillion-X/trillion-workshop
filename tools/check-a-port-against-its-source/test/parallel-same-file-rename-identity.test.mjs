// Independent actual renames of one captured source converge to one target at a normal merge.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from '../do-work/validate-reference-adaptation-contract.mjs';

const OLD = 'src/old.mjs', CURRENT = 'src/current.mjs', OTHER = 'src/other.mjs';
const LEFT_NAME = 'src/left-name.mjs', RIGHT_NAME = 'src/right-name.mjs';
const SOURCE = Array.from({ length: 12 }, (_, index) =>
  `export function preserveParallelRows${index}(rows) { return rows.slice(${index}); }`).join('\n') + '\n';
const digest = makeHashCodeHexFromBytes(Buffer.from(SOURCE));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit(root, files, message) {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(t, { otherOriginal = false } = {}) {
  const home = tempFolder(join(tmpdir(), 'parallel-same-file-rename-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'same-file-owner');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'parallel-rename-test');
  git(root, 'config', 'user.email', 'parallel@example.test');
  const baseline = commit(root, { [OLD]: SOURCE, ...(otherOriginal ? { [OTHER]: SOURCE } : {}) }, 'complete source snapshot');
  git(root, 'branch', 'right', baseline);
  return { root, baseline };
}

function rename(root, from, to, message) {
  git(root, 'mv', from, to);
  const revision = commit(root, {}, message);
  const report = git(root, 'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', `${revision}^`, revision);
  assert.equal(report, `R100\t${from}\t${to}`, 'the commit contains exactly one byte-preserving actual rename');
  assert.equal(git(root, 'show', `${revision}:${to}`), SOURCE.trimEnd());
  return revision;
}

function assertIncomparable(root, left, right) {
  for (const [before, after] of [[left, right], [right, left]]) {
    const relation = spawnSync('git', ['--no-replace-objects', '-C', root, 'merge-base', '--is-ancestor', before, after], { env: environment });
    assert.equal(relation.status, 1, 'the genuine rename events are incomparable');
  }
}

function evaluate(root, baseline) {
  commit(root, { [CURRENT]: `${SOURCE}export const currentAdapter = true;\n` }, 'adapt after both renames');
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-SYNTHETIC-PARALLEL-SAME-FILE-RENAME',
    status: 'VERIFIED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'Preserve the shared original through parallel genuine renames', message_multihash: digest },
    sources: [{ repository: basename(root), commit: baseline, path: OLD, multihash: digest,
      ownership: 'repository-owned', old_copy: 'same-file' }],
    targets: [{ path: CURRENT }], preserve: ['the twelve source functions'], allowed_deltas: ['one adapter export'],
    banned_substitutions: ['copy claimed as identity'],
    baseline: { commit: baseline, copied_before_adaptation: true, source_multihash: digest,
      target_multihash_at_baseline: digest, recorded_at: '2026-01-01T00:00:00Z' },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['preserveParallelRows11'],
      test_refs: ['tools/check-a-port-against-its-source/test/parallel-same-file-rename-identity.test.mjs'] },
  };
  const readers = gitReaders({ root, tree: 'HEAD' });
  const result = validateReferenceAdaptationContract(contract, {
    readers, repository: readers.self, stage: 'completion', policySince: baseline, activeTargetPaths: [CURRENT],
    retentionAtLeast: 0.6, oldCopyDaysAtMost: 3, now: '2026-01-04T00:00:00Z',
  });
  assert.equal(result.measurements.meaningfulLineRetention, 1);
  assert.deepEqual(result.deferred, []);
  return { result, identity: readers.sameFileIdentity(baseline, OLD, CURRENT) };
}

test('independent exact renames from one source snapshot converge to one same-file target', t => {
  const { root, baseline } = fixture(t);
  const left = rename(root, OLD, CURRENT, 'left genuine rename');
  git(root, 'checkout', '-q', 'right');
  const right = rename(root, OLD, CURRENT, 'right genuine rename');
  assertIncomparable(root, left, right);
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '--no-ff', '-qm', 'merge two exact renamed tips', right);
  const merge = git(root, 'rev-parse', 'HEAD');
  assert.equal(git(root, 'rev-list', '--parents', '-n', '1', merge), `${merge} ${left} ${right}`);
  const { result, identity } = evaluate(root, baseline);
  t.diagnostic(JSON.stringify({ baseline, left, right, merge, sameFileIdentity: identity, result }));
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('independent rename chains with different intermediate names preserve their common captured source', t => {
  const { root, baseline } = fixture(t);
  const leftFirst = rename(root, OLD, LEFT_NAME, 'left original to left intermediate');
  const left = rename(root, LEFT_NAME, CURRENT, 'left intermediate to current');
  git(root, 'checkout', '-q', 'right');
  const rightFirst = rename(root, OLD, RIGHT_NAME, 'right original to right intermediate');
  const right = rename(root, RIGHT_NAME, CURRENT, 'right intermediate to current');
  assertIncomparable(root, leftFirst, rightFirst);
  assertIncomparable(root, left, right);
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '--no-ff', '-qm', 'merge genuinely converged rename chains', right);
  const merge = git(root, 'rev-parse', 'HEAD');
  assert.equal(git(root, 'rev-list', '--parents', '-n', '1', merge), `${merge} ${left} ${right}`);
  assert.equal(git(root, 'ls-tree', '-r', '--name-only', merge), CURRENT, 'the histories converge to exactly one file');
  const { result, identity } = evaluate(root, baseline);
  t.diagnostic(JSON.stringify({ baseline, leftFirst, left, rightFirst, right, merge, sameFileIdentity: identity, result }));
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('identical bytes at two captured paths cannot merge two original identities into one claimed same-file source', t => {
  const { root, baseline } = fixture(t, { otherOriginal: true });
  const left = rename(root, OLD, CURRENT, 'left moves the claimed original');
  git(root, 'checkout', '-q', 'right');
  const right = rename(root, OTHER, CURRENT, 'right moves the distinct byte-identical original');
  assertIncomparable(root, left, right);
  git(root, 'checkout', '-q', 'main');
  const merging = spawnSync('git', ['--no-replace-objects', '-C', root, 'merge', '--no-ff', '-m', 'merge distinct originals into one target', right], {
    env: environment, encoding: 'utf8',
  });
  assert.ok(merging.status === 0 || merging.status === 1, merging.stderr);
  if (merging.status === 1) {
    assert.notEqual(git(root, 'ls-files', '--unmerged'), '', 'a real merge conflict needs an explicit resolution');
    rmSync(join(root, OLD), { force: true });
    rmSync(join(root, OTHER), { force: true });
    commit(root, { [CURRENT]: SOURCE }, 'resolve distinct-original merge to one target');
  }
  const merge = git(root, 'rev-parse', 'HEAD');
  assert.equal(git(root, 'rev-list', '--parents', '-n', '1', merge), `${merge} ${left} ${right}`);
  assert.equal(git(root, 'ls-tree', '-r', '--name-only', merge), CURRENT, 'the resolved tree holds one target and both original names have retired');
  const { result, identity } = evaluate(root, baseline);
  t.diagnostic(JSON.stringify({ baseline, left, right, merge, sameFileIdentity: identity, result }));
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.errors.join('\n'), /same-file|identity|bijection/);
});
