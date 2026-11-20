// Independent source-continuity opponents for mixed branch witnesses and a reused original spelling.
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

const OLD = 'src/original.mjs', CURRENT = 'src/current.mjs', INTERMEDIATE = 'src/copied-intermediate.mjs';
const CYCLE_MIDDLE = 'src/round-trip.mjs';
const EARLIER = 'export const originalDevelopmentBeforeSnapshot = true;\n';
const SOURCE = Array.from({ length: 12 }, (_, index) =>
  `export function preserveWitnessRows${index}(rows) { return rows.slice(${index}); }`).join('\n') + '\n';
const ADAPTED = `${SOURCE}export const currentAdapter = true;\n`;
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

function fixture(t) {
  const home = tempFolder(join(tmpdir(), 'same-file-witness-opponents-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'same-file-owner');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'rename-opponent-test');
  git(root, 'config', 'user.email', 'opponent@example.test');
  const initial = commit(root, { [OLD]: EARLIER }, 'original pre-policy development');
  const baseline = commit(root, { [OLD]: SOURCE }, 'capture complete original before policy');
  git(root, 'branch', 'other-history', baseline);
  return { root, initial, baseline };
}

function rename(root, from, to, message) {
  git(root, 'mv', from, to);
  const revision = commit(root, {}, message);
  assert.equal(git(root, 'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', `${revision}^`, revision),
    `R100\t${from}\t${to}`, 'the fixture has one actual, exact raw rename');
  return revision;
}

function evaluate({ root, baseline }) {
  commit(root, { [CURRENT]: ADAPTED }, 'adapt the final retained target');
  const declaration = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-SYNTHETIC-MIXED-RENAME-WITNESS', status: 'VERIFIED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'Synthetic fixture: preserve the original file through a proven rename', message_multihash: digest },
    sources: [{ repository: basename(root), commit: baseline, path: OLD, multihash: digest,
      ownership: 'repository-owned', old_copy: 'same-file' }],
    targets: [{ path: CURRENT }], preserve: ['the twelve original row functions'],
    allowed_deltas: ['one adapter export'], banned_substitutions: ['an equal-byte copy claimed as file identity'],
    baseline: { commit: baseline, copied_before_adaptation: true, source_multihash: digest,
      target_multihash_at_baseline: digest, recorded_at: '2026-01-01T00:00:00Z' },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['preserveWitnessRows11'],
      test_refs: ['tools/check-a-port-against-its-source/test/same-file-rename-opponents-review.test.mjs'] },
  };
  const readers = gitReaders({ root, tree: 'HEAD' });
  const identity = readers.sameFileIdentity(baseline, OLD, CURRENT);
  const result = validateReferenceAdaptationContract(declaration, {
    readers, repository: readers.self, stage: 'completion', policySince: baseline, activeTargetPaths: [CURRENT],
    retentionAtLeast: 0.6, oldCopyDaysAtMost: 3, now: '2026-01-04T00:00:00Z',
  });
  assert.deepEqual(readers.targetState(OLD), { state: 'absent' }, 'final source absence alone cannot establish continuity');
  assert.deepEqual(result.deferred, []);
  assert.equal(result.measurements.meaningfulLineRetention, 1);
  return { identity, result, readers };
}

for (const copiedIntermediate of [false, true]) {
  test(`a genuine rename branch cannot certify a parallel ${copiedIntermediate ? 'copied root followed by a later rename' : 'copy followed by original removal'}`, t => {
    const f = fixture(t);
    const left = rename(f.root, OLD, CURRENT, 'one branch genuinely renames the original');
    git(f.root, 'checkout', '-q', 'other-history');
    const copiedPath = copiedIntermediate ? INTERMEDIATE : CURRENT;
    const copy = commit(f.root, { [copiedPath]: SOURCE }, 'copy original while its old name remains');
    assert.equal(git(f.root, 'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', `${copy}^`, copy),
      `A\t${copiedPath}`, 'the other branch began with an addition, not a rename');
    git(f.root, 'rm', '-q', OLD);
    let right = commit(f.root, {}, 'remove the copied original separately');
    if (copiedIntermediate) right = rename(f.root, INTERMEDIATE, CURRENT, 'a later real rename cannot repair a copied origin');
    git(f.root, 'checkout', '-q', 'main');
    const merging = spawnSync('git', ['--no-replace-objects', '-C', f.root, 'merge', '--no-ff', '-m', 'merge the mixed original histories', right], {
      env: environment, encoding: 'utf8',
    });
    assert.ok(merging.status === 0 || merging.status === 1, merging.stderr);
    if (merging.status === 1) {
      assert.notEqual(git(f.root, 'ls-files', '--unmerged'), '', 'only a real conflict requires explicit resolution');
      rmSync(join(f.root, OLD), { force: true });
      rmSync(join(f.root, INTERMEDIATE), { force: true });
      commit(f.root, { [CURRENT]: SOURCE }, 'resolve to the sole raw target');
    }
    const merged = git(f.root, 'rev-parse', 'HEAD');
    assert.equal(git(f.root, 'rev-list', '--parents', '-n', '1', merged), `${merged} ${left} ${right}`);
    assert.equal(git(f.root, 'ls-tree', '-r', '--name-only', merged), CURRENT);
    const { identity, result } = evaluate(f);
    t.diagnostic(JSON.stringify({ copiedIntermediate, identity, result }));
    assert.equal(identity, false, 'every incoming branch needs its own original-file witness');
    assert.equal(result.valid, false, JSON.stringify(result));
    assert.match(result.errors.join('\n'), /same-file|identity|bijection/);
  });
}

test('reintroducing and removing the original spelling after a real rename is not hidden by its final absence', t => {
  const f = fixture(t);
  rename(f.root, OLD, CURRENT, 'genuine original rename');
  const reused = commit(f.root, { [OLD]: SOURCE }, 'reuse the retired original spelling');
  assert.equal(git(f.root, 'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', `${reused}^`, reused), `A\t${OLD}`);
  git(f.root, 'rm', '-q', OLD);
  commit(f.root, {}, 'remove the reused spelling again');
  const { identity, result } = evaluate(f);
  t.diagnostic(JSON.stringify({ identity, result }));
  assert.equal(identity, false);
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.errors.join('\n'), /same-file|identity|bijection/);
});

test('a unique raw rename through the original spelling preserves the captured file and its pre-policy development', t => {
  const f = fixture(t);
  rename(f.root, OLD, CYCLE_MIDDLE, 'move original to middle');
  rename(f.root, CYCLE_MIDDLE, OLD, 'return the same file to its original spelling');
  rename(f.root, OLD, CURRENT, 'move the returned original to current');
  const { identity, result, readers } = evaluate(f);
  assert.deepEqual(readers.readSource({ repository: basename(f.root), commit: f.initial, path: OLD }), Buffer.from(EARLIER));
  assert.ok(readers.baselineHistory(f.baseline, [CURRENT]).targets[0].before.some(bytes => bytes?.equals(Buffer.from(EARLIER))),
    'the earlier development is present in the actual history and is not mistaken for an imported adaptation');
  t.diagnostic(JSON.stringify({ identity, result }));
  assert.equal(identity, true);
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  assert.equal(result.valid, true);
});

test('a copied intermediate cannot authorize a raw rename return into the original spelling', t => {
  const f = fixture(t);
  rename(f.root, OLD, CURRENT, 'genuine original rename');
  const copied = commit(f.root, { [INTERMEDIATE]: SOURCE }, 'copy the current bytes into a separate intermediate');
  assert.equal(git(f.root, 'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', `${copied}^`, copied), `A\t${INTERMEDIATE}`);
  rename(f.root, INTERMEDIATE, OLD, 'rename the copied intermediate into the original spelling');
  git(f.root, 'rm', '-q', OLD);
  commit(f.root, {}, 'remove the copied return while current remains');
  const { identity, result } = evaluate(f);
  t.diagnostic(JSON.stringify({ identity, result }));
  assert.equal(identity, false);
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.errors.join('\n'), /same-file|identity|bijection/);
});
