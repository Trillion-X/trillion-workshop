// Real, synthetic Git histories distinguish independent exact copies from adaptation before a baseline.
// Existing check-a-repository-for-port-contracts.test.mjs supplies the symlink, rename, future-baseline,
// deleted/reintroduced and shallow/grafted-history floor; shared-history-cache.test.mjs supplies tip isolation.
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
  `export function preserveRowOrder${index}(rows) { return rows.slice(${index}); }`).join('\n') + '\n';
const ADAPTED = `${SOURCE}export const activeRowAdapter = true;\n`;
const ORIGINAL = 'src/order-rows.mjs';
const ACTIVE = 'tools/order-rows/do-work/core.mjs';
const HELD = 'proofs/original-order-rows.mjs';
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

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=parallel-history-test', '-c', 'user.email=history@example.test', 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function repository(path, initialFiles = {}) {
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  write(path, 'README.md', 'Synthetic source-first history fixture.\n');
  for (const [name, contents] of Object.entries(initialFiles)) write(path, name, contents);
  return commit(path, 'initial fixture');
}

function fixture(t, { receivingRootContents } = {}) {
  const home = tempFolder(join(tmpdir(), 'parallel-source-baseline-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'receiving-owner'), old = join(home, 'original-owner');
  const since = repository(root, receivingRootContents === undefined ? {} : { [ACTIVE]: receivingRootContents });
  repository(old);
  write(old, ORIGINAL, SOURCE);
  const sourceCommit = commit(old, 'original row ordering');
  git(old, 'rm', ORIGINAL);
  const retired = commit(old, 'retire synthetic old copy');
  git(old, 'update-ref', 'refs/remotes/origin/main', retired);
  return { root, old, since, sourceCommit };
}

// Only the synthetic receiving repository's known active file changes between snapshots. Its main ref is not
// moved: commit-tree records explicit parents, so the tested DAG does not rely on checkout order or wall time.
function event(f, parents, contents, message) {
  if (contents === null) rmSync(join(f.root, ACTIVE), { force: true });
  else write(f.root, ACTIVE, contents);
  git(f.root, 'add', '-A');
  const tree = git(f.root, 'write-tree');
  return git(f.root, '-c', 'user.name=parallel-history-test', '-c', 'user.email=history@example.test',
    'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message);
}

function ancestor(f, before, after) {
  const result = spawnSync('git', ['--no-replace-objects', '-C', f.root, 'merge-base', '--is-ancestor', before, after], {
    env: gitEnvironment, encoding: 'utf8',
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.status === 0;
}

function contract(f, baseline, { baselinePath } = {}) {
  const digest = identity(SOURCE);
  return {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-SYNTHETIC-PARALLEL-SOURCE-HISTORY', status: 'VERIFIED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'Synthetic fixture: port the original row ordering', message_multihash: identity('synthetic row-order port') },
    sources: [{
      repository: basename(f.old), commit: f.sourceCommit, path: ORIGINAL, multihash: digest,
      ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-03T00:00:00Z' },
    }],
    targets: [{ path: ACTIVE }],
    preserve: ['the twelve original row-ordering functions'], allowed_deltas: ['one active adapter export'],
    banned_substitutions: ['adaptation before the original copy', 'an archive counted as active retention'],
    baseline: {
      commit: baseline, recorded_at: '2026-01-01T00:00:00Z', copied_before_adaptation: true,
      source_multihash: digest, target_multihash_at_baseline: digest,
      ...(baselinePath ? { path: baselinePath } : {}),
    },
    proof: {
      minimum_meaningful_line_retention: 0.6, required_mechanisms: ['function preserveRowOrder3'],
      test_refs: ['tools/check-a-port-against-its-source/test/parallel-source-baseline-history.test.mjs'],
    },
  };
}

function validate(f, baseline, tip, options) {
  return validateReferenceAdaptationContract(contract(f, baseline, options), {
    readers: gitReaders({ root: f.root, tree: tip }), repository: basename(f.root), stage: 'completion',
    activeTargetPaths: [ACTIVE], policySince: f.since, retentionAtLeast: 0.6, oldCopyDaysAtMost: 3,
    now: '2026-01-04T00:00:00Z',
  });
}

function assertChronologyRefusal(result) {
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.deepEqual(result.deferred, []);
  assert.equal(result.errors.length, 1, JSON.stringify(result));
  assert.match(result.errors[0], /baseline must precede active adaptation/);
  assert.equal(result.measurements.meaningfulLineRetention, 1, 'refusal is not caused by lost source lines');
}

test('two incomparable exact source introductions can merge before active adaptation', t => {
  const f = fixture(t);
  const parallel = event(f, [f.since], SOURCE, 'independent exact copy');
  const baseline = event(f, [f.since], SOURCE, 'declared exact copy');
  assert.equal(ancestor(f, parallel, baseline), false);
  assert.equal(ancestor(f, baseline, parallel), false);
  const merged = event(f, [parallel, baseline], SOURCE, 'merge exact copies');
  const tip = event(f, [merged], ADAPTED, 'adapt only after both copies');
  assert.equal(ancestor(f, parallel, tip), true);
  assert.equal(ancestor(f, baseline, tip), true);
  for (const revision of [parallel, baseline, merged]) {
    const bytes = execFileSync('git', ['--no-replace-objects', '-C', f.root, 'show', `${revision}:${ACTIVE}`], {
      env: gitEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.deepEqual(bytes, Buffer.from(SOURCE), 'each original event is byte-for-byte source, including its final newline');
  }
  const result = validate(f, baseline, tip);
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  assert.deepEqual(result.deferred, []);
  assert.equal(result.valid, true);
  assert.equal(result.measurements.meaningfulLineRetention, 1);
});

test('a held exact baseline can precede adaptation when the raw active copy came from an incomparable branch', t => {
  const f = fixture(t);
  const parallel = event(f, [f.since], SOURCE, 'independent exact active copy');
  write(f.root, HELD, SOURCE);
  const baseline = event(f, [f.since], null, 'hold original source without an active path');
  assert.equal(ancestor(f, parallel, baseline), false);
  assert.equal(ancestor(f, baseline, parallel), false);
  const baselineReader = gitReaders({ root: f.root, tree: baseline });
  assert.deepEqual(baselineReader.targetState(ACTIVE), { state: 'absent' }, 'the active path is absent, not unreadable, on the baseline branch');
  assert.deepEqual(baselineReader.readTarget(HELD), Buffer.from(SOURCE), 'the explicit artifact holds the full original bytes');
  const parallelReader = gitReaders({ root: f.root, tree: parallel });
  assert.deepEqual(parallelReader.readTarget(ACTIVE), Buffer.from(SOURCE), 'the incomparable active introduction is an exact copy');
  const merged = event(f, [parallel, baseline], SOURCE, 'merge original active copy with held baseline');
  const tip = event(f, [merged], ADAPTED, 'adapt after both original-copy histories');
  assert.equal(ancestor(f, parallel, tip), true);
  assert.equal(ancestor(f, baseline, tip), true);
  const result = validate(f, baseline, tip, { baselinePath: HELD });
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  assert.deepEqual(result.deferred, []);
  assert.equal(result.valid, true);
  assert.equal(result.measurements.meaningfulLineRetention, 1);
});

test('an adapted introduction on a parallel branch is refused', t => {
  const f = fixture(t);
  const parallel = event(f, [f.since], ADAPTED, 'parallel adapted introduction');
  const baseline = event(f, [f.since], SOURCE, 'declared exact copy');
  const tip = event(f, [parallel, baseline], ADAPTED, 'merge parallel adaptation');
  assertChronologyRefusal(validate(f, baseline, tip));
});

test('parallel raw then adapted then reverted-to-raw history is still refused', t => {
  const f = fixture(t);
  const raw = event(f, [f.since], SOURCE, 'parallel original copy');
  const adapted = event(f, [raw], ADAPTED, 'parallel adaptation before declared copy');
  const reverted = event(f, [adapted], SOURCE, 'restore original bytes');
  const baseline = event(f, [f.since], SOURCE, 'declared exact copy');
  const merged = event(f, [reverted, baseline], SOURCE, 'merge apparently raw tips');
  const tip = event(f, [merged], ADAPTED, 'current active adaptation');
  assertChronologyRefusal(validate(f, baseline, tip));
});

test('parallel adaptation after a common raw introduction is refused even when every introduction is ordered', t => {
  const f = fixture(t);
  const initialCopy = event(f, [f.since], SOURCE, 'common exact source introduction');
  const baseline = event(f, [initialCopy], SOURCE, 'declare unchanged original baseline');
  const parallelAdaptation = event(f, [initialCopy], ADAPTED, 'adapt parallel to the declared baseline');
  const reverted = event(f, [parallelAdaptation], SOURCE, 'revert parallel adaptation to raw bytes');
  assert.equal(ancestor(f, initialCopy, baseline), true);
  assert.equal(ancestor(f, parallelAdaptation, baseline), false);
  assert.equal(ancestor(f, baseline, parallelAdaptation), false);
  const merged = event(f, [baseline, reverted], SOURCE, 'merge two raw tips after parallel adaptation');
  const tip = event(f, [merged], ADAPTED, 'adapt the current active target');
  const reader = gitReaders({ root: f.root, tree: tip });
  assert.deepEqual(reader.targetAtCommit(reverted, ACTIVE), Buffer.from(SOURCE), 'the parallel tip hides its earlier adaptation');
  t.diagnostic(`introduction ordering alone reports ${reader.baselineHistory(baseline, [ACTIVE]).targets[0].introductionsOrdered}`);
  assertChronologyRefusal(validate(f, baseline, tip));
});

test('an adapted receiving root remains visible when log.showRoot is false', t => {
  const f = fixture(t, { receivingRootContents: ADAPTED });
  git(f.root, 'config', 'log.showRoot', 'false');
  assert.equal(git(f.root, 'config', '--get', 'log.showRoot'), 'false');
  const baseline = event(f, [f.since], SOURCE, 'copy original bytes after an adapted root');
  const tip = event(f, [baseline], ADAPTED, 'current active adaptation');
  const rootReader = gitReaders({ root: f.root, tree: f.since });
  assert.deepEqual(rootReader.readTarget(ACTIVE), Buffer.from(ADAPTED), 'the real root commit already contains adapted content');
  assertChronologyRefusal(validate(f, baseline, tip));
});

for (const state of ['deleted', 'discarded']) {
  test(`parallel adaptation later ${state} at the merge cannot disappear from provenance`, t => {
    const f = fixture(t);
    const raw = event(f, [f.since], SOURCE, 'parallel original copy');
    const adapted = event(f, [raw], ADAPTED, 'parallel adaptation');
    const parallel = state === 'deleted' ? event(f, [adapted], null, 'delete adapted path') : adapted;
    const baseline = event(f, [f.since], SOURCE, 'declared exact copy');
    const merged = event(f, [parallel, baseline], SOURCE, 'keep only raw bytes at merge');
    const tip = event(f, [merged], ADAPTED, 'current active adaptation');
    assertChronologyRefusal(validate(f, baseline, tip));
  });
}

test('adaptation on the baseline ancestry remains refused after a raw revert', t => {
  const f = fixture(t);
  const prior = event(f, [f.since], ADAPTED, 'adaptation before baseline');
  const baseline = event(f, [prior], SOURCE, 'later raw copy');
  const tip = event(f, [baseline], ADAPTED, 'current adaptation');
  assertChronologyRefusal(validate(f, baseline, tip));
});

test('an unmerged unrelated adapted branch does not enter the judged history', t => {
  const f = fixture(t);
  const unrelated = event(f, [f.since], ADAPTED, 'unmerged unrelated adaptation');
  git(f.root, 'update-ref', 'refs/heads/unmerged', unrelated);
  const baseline = event(f, [f.since], SOURCE, 'declared exact copy');
  const tip = event(f, [baseline], ADAPTED, 'adapt after copy');
  assert.equal(ancestor(f, unrelated, tip), false);
  const result = validate(f, baseline, tip);
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  assert.deepEqual(result.deferred, []);
  assert.equal(result.valid, true);
});
