// Real Git proofs exercise reader/validator compatibility, empty-history qualification and the same-file boundary.
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

const SOURCE = Array.from({ length: 12 }, (_, index) =>
  `export function preserveHistoryRows${index}(rows) { return rows.slice(${index}); }`).join('\n') + '\n';
const ADAPTED = `${SOURCE}export const activeHistoryAdapter = true;\n`;
const EARLIER = 'export const implementationBeforeTheSourceSnapshot = true;\n';
const ACTIVE = 'tools/history-rows/do-work/core.mjs';
const ORIGINAL = 'src/history-rows.mjs';
const identity = bytes => makeHashCodeHexFromBytes(Buffer.from(bytes));
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function event(root, parents, contents, message) {
  write(root, ACTIVE, contents);
  git(root, 'add', '-A');
  const tree = git(root, 'write-tree');
  return git(root, '-c', 'user.name=history-proof-test', '-c', 'user.email=history@example.test',
    'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message);
}

function fixture(t, { unborn = false } = {}) {
  const home = tempFolder(join(tmpdir(), 'history-proof-coverage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'receiving-owner'), old = join(home, 'original-owner');
  for (const folder of [root, old]) {
    mkdirSync(folder);
    git(folder, 'init', '-q', '-b', 'main');
  }
  write(old, ORIGINAL, SOURCE);
  git(old, 'add', '-A');
  git(old, '-c', 'user.name=history-proof-test', '-c', 'user.email=history@example.test', 'commit', '-qm', 'original source');
  const sourceCommit = git(old, 'rev-parse', 'HEAD');
  git(old, 'rm', '-q', ORIGINAL);
  git(old, '-c', 'user.name=history-proof-test', '-c', 'user.email=history@example.test', 'commit', '-qm', 'retire original copy');
  git(old, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  let initial = null;
  if (!unborn) {
    initial = event(root, [], EARLIER, 'earlier same-path implementation');
    git(root, 'update-ref', 'refs/heads/main', initial);
  }
  return { root, old, initial, sourceCommit };
}

function contract(f, baseline, { sameFile = false, initialCopy = false } = {}) {
  const digest = identity(SOURCE);
  return {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-SYNTHETIC-HISTORY-PROOF-COVERAGE', status: initialCopy ? 'BASELINED' : 'VERIFIED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'Synthetic fixture: preserve history rows', message_multihash: identity('synthetic history row port') },
    sources: [{
      repository: basename(sameFile ? f.root : f.old), commit: sameFile ? baseline : f.sourceCommit,
      path: sameFile ? ACTIVE : ORIGINAL, multihash: digest, ownership: 'repository-owned',
      old_copy: sameFile ? 'same-file' : { deleted_by: '2026-01-03T00:00:00Z' },
    }],
    targets: [{ path: ACTIVE }], preserve: ['the twelve original history-row functions'],
    allowed_deltas: ['one adapter export'], banned_substitutions: ['lost target history'],
    baseline: {
      ...(baseline ? { commit: baseline } : {}), recorded_at: '2026-01-01T00:00:00Z', copied_before_adaptation: true,
      source_multihash: digest, target_multihash_at_baseline: digest,
    },
    proof: {
      minimum_meaningful_line_retention: 0.6, required_mechanisms: ['function preserveHistoryRows3'],
      test_refs: ['tools/check-a-port-against-its-source/test/history-proof-coverage.test.mjs'],
    },
  };
}

function validate(f, declaration, readers, policySince = f.initial) {
  return validateReferenceAdaptationContract(declaration, {
    readers, repository: basename(f.root), stage: declaration.status === 'BASELINED' ? 'pre-edit' : 'completion',
    activeTargetPaths: [ACTIVE], policySince, retentionAtLeast: 0.6, oldCopyDaysAtMost: 3,
    now: '2026-01-04T00:00:00Z',
  });
}

function assertPass(result) {
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  assert.deepEqual(result.deferred, []);
  assert.equal(result.valid, true);
  assert.equal(result.measurements.meaningfulLineRetention, 1);
}

function assertHistoryRefusal(result, pattern) {
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.deepEqual(result.deferred, []);
  assert.equal(result.errors.length, 1, JSON.stringify(result));
  assert.match(result.errors[0], pattern);
  assert.equal(result.measurements.meaningfulLineRetention, 1);
}

test('a real-reader proof without its coverage marker fails closed in the new validator', t => {
  const f = fixture(t, { unborn: true });
  const baseline = event(f.root, [], SOURCE, 'exact original root');
  const tip = event(f.root, [baseline], ADAPTED, 'adapt after original');
  const declaration = contract(f, baseline), reader = gitReaders({ root: f.root, tree: tip });
  assertPass(validate(f, declaration, reader));
  const originalProof = reader.baselineHistory(baseline, [ACTIVE]);
  assert.equal(originalProof.allEarlierOrParallelContent, true);
  const mixedReader = { ...reader, baselineHistory(...args) {
    const { allEarlierOrParallelContent, ...oldProof } = reader.baselineHistory(...args);
    assert.equal(allEarlierOrParallelContent, true);
    return oldProof;
  } };
  assertHistoryRefusal(validate(f, declaration, mixedReader), /requires complete earlier and parallel target history proof/);
});

test('a genuinely unborn repository certifies and accepts its staged exact first copy', t => {
  const f = fixture(t, { unborn: true });
  write(f.root, ACTIVE, SOURCE);
  git(f.root, 'add', '-A');
  assert.equal(git(f.root, 'rev-list', '--all', '--reflog', '--max-count=1'), '');
  const reader = gitReaders({ root: f.root, tree: ':' });
  const proof = reader.baselineHistory('HEAD', [ACTIVE]);
  assert.equal(proof.allEarlierOrParallelContent, true);
  assert.deepEqual(proof.targets[0].before, []);
  assert.deepEqual(proof.targets[0].parallel, []);
  assertPass(validate(f, contract(f, null, { initialCopy: true }), reader));
});

test('a symbolic HEAD pointing to a missing commit cannot certify empty history', t => {
  const f = fixture(t, { unborn: true });
  write(f.root, ACTIVE, SOURCE);
  git(f.root, 'add', '-A');
  write(f.root, '.git/refs/heads/main', `${'1'.repeat(40)}\n`);
  assert.equal(git(f.root, 'symbolic-ref', '--quiet', 'HEAD'), 'refs/heads/main');
  const scan = spawnSync('git', ['--no-replace-objects', '-C', f.root, 'rev-list', '--all', '--reflog', '--max-count=1'], {
    env: gitEnvironment, encoding: 'utf8',
  });
  assert.notEqual(scan.status, 0, 'corrupt object history is an error, not an empty successful scan');
  const reader = gitReaders({ root: f.root, tree: ':' });
  assert.equal(reader.baselineHistory('HEAD', [ACTIVE]), null);
  assertHistoryRefusal(validate(f, contract(f, null, { initialCopy: true }), reader), /requires repository history proof/);
});

for (const onlyReflog of [false, true]) {
  test(`an unborn HEAD cannot hide ${onlyReflog ? 'reflog-only' : 'another branch\'s'} committed history`, t => {
    const f = fixture(t);
    git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/fresh');
    if (onlyReflog) rmSync(join(f.root, '.git/refs/heads/main'));
    write(f.root, ACTIVE, SOURCE);
    git(f.root, 'add', '-A');
    if (onlyReflog) assert.equal(git(f.root, 'rev-list', '--all', '--max-count=1'), '', 'no live ref holds the prior commit');
    assert.equal(git(f.root, 'rev-list', '--all', '--reflog', '--max-count=1'), f.initial);
    const reader = gitReaders({ root: f.root, tree: ':' });
    assert.equal(reader.baselineHistory('HEAD', [ACTIVE]), null);
    assertHistoryRefusal(validate(f, contract(f, null, { initialCopy: true }), reader), /requires repository history proof/);
  });
}

test('genuine pre-policy same-file provenance retains its nonexact ancestral development allowance', t => {
  const f = fixture(t);
  const baseline = event(f.root, [f.initial], SOURCE, 'complete same-file source snapshot');
  const tip = event(f.root, [baseline], ADAPTED, 'adapt the existing source after policy');
  const reader = gitReaders({ root: f.root, tree: tip });
  const proof = reader.baselineHistory(baseline, [ACTIVE]);
  assert.equal(proof.targets[0].introductionsOrdered, true);
  assert.ok(proof.targets[0].before.some(bytes => bytes.equals(Buffer.from(EARLIER))), 'the earlier implementation is genuinely nonexact');
  assert.deepEqual(proof.targets[0].parallel, []);
  assertPass(validate(f, contract(f, baseline, { sameFile: true }), reader, baseline));
});

test('ordered same-file introductions cannot hide parallel adaptation followed by a raw revert', t => {
  const f = fixture(t);
  const sharedSource = event(f.root, [f.initial], SOURCE, 'shared same-file source introduction');
  const baseline = event(f.root, [sharedSource], SOURCE, 'pre-policy unchanged source snapshot');
  const parallelAdaptation = event(f.root, [sharedSource], ADAPTED, 'parallel active adaptation');
  const reverted = event(f.root, [parallelAdaptation], SOURCE, 'restore exact source on parallel branch');
  const merge = event(f.root, [baseline, reverted], SOURCE, 'merge apparently exact tips');
  const tip = event(f.root, [merge], ADAPTED, 'adapt after merge');
  const reader = gitReaders({ root: f.root, tree: tip });
  const proof = reader.baselineHistory(baseline, [ACTIVE]);
  assert.equal(proof.targets[0].introductionsOrdered, true, 'introduction comparability cannot detect this opponent');
  assert.deepEqual(reader.targetAtCommit(reverted, ACTIVE), Buffer.from(SOURCE));
  assert.ok(proof.targets[0].parallel.some(bytes => bytes.equals(Buffer.from(ADAPTED))), 'the hidden parallel adaptation remains in the proof');
  assertHistoryRefusal(validate(f, contract(f, baseline, { sameFile: true }), reader, baseline), /baseline must precede active adaptation/);
});
