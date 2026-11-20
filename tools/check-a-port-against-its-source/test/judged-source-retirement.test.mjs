// A move inside the judged repository can retire its old owner in the same candidate or index.
// An external owner's published main remains authoritative until that separate repository retires it.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from '../do-work/validate-reference-adaptation-contract.mjs';

const SOURCE = Array.from({ length: 12 }, (_, i) => `export function keepRowsInOrder${i}(rows) { return rows.slice(${i}); }`).join('\n') + '\n';
const ORIGINAL = `export const legacyModuleVersion = 1;\n${SOURCE}export const legacyCompatibilityName = 'rows';\n`;
const OLD_PATH = 'legacy/order-rows.mjs';
const CORE_PATH = 'tools/order-rows/do-work/core.mjs';
const BASELINE_PATH = 'proofs/order-rows-original.mjs';
const FACADE = `export * from '../${CORE_PATH}';\nexport const legacyModuleVersion = 1;\nexport const legacyCompatibilityName = 'rows';\n`;
const NOW_AFTER_DUE = '2026-01-04T00:00:00Z';
const identity = (text) => makeHashCodeHexFromBytes(Buffer.from(text));

function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function commit(root, files, message) {
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=retirement-test', '-c', 'user.email=retirement@example.test', 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function repository(root) {
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
}

function fixture(t, { external = false, wholeFile = false } = {}) {
  const base = tempFolder(join(tmpdir(), 'judged-source-retirement-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'candidate-repo');
  const owner = external ? join(base, 'external-owner') : root;
  repository(root);
  if (external) repository(owner);
  const sourceCommit = commit(owner, { [OLD_PATH]: ORIGINAL, 'README.md': 'Synthetic source-owner fixture.\n' }, 'original source owner');
  git(owner, 'update-ref', 'refs/remotes/origin/main', sourceCommit);
  const copied = wholeFile ? ORIGINAL : SOURCE;
  const baselineCommit = commit(root, { [BASELINE_PATH]: copied }, 'exact source copy before active adaptation');
  const activeCommit = commit(root, { [CORE_PATH]: `${copied}export const activeCoreAdaptation = true;\n` }, 'new active core after immutable copy');
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-JUDGED-SOURCE-RETIREMENT', status: 'VERIFIED', mode: 'SOURCE_FIRST_PORT',
    directive: { message_multihash: identity('port the row ordering atomically'), quote: 'port the row ordering into a fresh core and retain its compatibility facade' },
    sources: [{
      repository: basename(owner), commit: sourceCommit, path: OLD_PATH,
      ...(!wholeFile ? { lines: [2, 13] } : {}), multihash: identity(copied), ownership: 'repository-owned',
      old_copy: { deleted_by: '2026-01-03T00:00:00Z' },
    }],
    targets: [{ path: CORE_PATH }],
    preserve: ['the twelve row-ordering functions'], allowed_deltas: ['a stable facade and one added export'], banned_substitutions: ['a rewritten ordering algorithm'],
    baseline: {
      path: BASELINE_PATH, commit: baselineCommit, copied_before_adaptation: true,
      source_multihash: identity(copied), target_multihash_at_baseline: identity(copied), recorded_at: '2026-01-01T00:00:00Z',
    },
    proof: { minimum_meaningful_line_retention: 0.8, required_mechanisms: ['keepRowsInOrder3'], test_refs: ['test/synthetic-row-ordering.test.mjs'] },
  };
  return { root, owner, contract, sourceCommit, baselineCommit, activeCommit };
}

function validate({ root, contract }, tree) {
  const readers = gitReaders({ root, tree });
  return validateReferenceAdaptationContract(contract, {
    readers, repository: basename(root), stage: 'completion', activeTargetPaths: [CORE_PATH],
    retentionAtLeast: 0.6, oldCopyDaysAtMost: 3, now: NOW_AFTER_DUE,
  });
}

function assertQualified(result) {
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.deferred, [], 'qualification requires readable retirement evidence');
  assert.equal(result.measurements.meaningfulLineRetention, 1);
}

function assertRetained(result) {
  assert.equal(result.valid, false, JSON.stringify(result, null, 2));
  assert.match(result.errors.join('\n'), /old copy.*still lives/);
}

test('a same-repository candidate retires the source slice atomically while its facade and published original remain', (t) => {
  const state = fixture(t);
  const candidate = commit(state.root, { [OLD_PATH]: FACADE }, 'retire original slice and keep the stable facade');
  assert.equal(git(state.root, 'rev-parse', 'refs/remotes/origin/main'), state.sourceCommit);
  assert.ok(git(state.root, 'show', `refs/remotes/origin/main:${OLD_PATH}`).includes(SOURCE.trim()));
  assert.equal(git(state.root, 'show', `${candidate}:${OLD_PATH}`), FACADE.trim());
  assertQualified(validate(state, candidate));
});

test('same-repository staged retirement uses the index rather than disk, HEAD or origin/main', (t) => {
  const state = fixture(t);
  write(state.root, OLD_PATH, FACADE);
  assertRetained(validate(state, ':')); // The facade is only on disk; the judged index still owns the old slice.
  git(state.root, 'add', '--', OLD_PATH);
  assert.ok(git(state.root, 'show', `HEAD:${OLD_PATH}`).includes(SOURCE.trim()));
  assert.ok(git(state.root, 'show', `refs/remotes/origin/main:${OLD_PATH}`).includes(SOURCE.trim()));
  assertQualified(validate(state, ':'));
});

test('a same-repository whole-path retirement qualifies in the candidate without first publishing it', (t) => {
  const state = fixture(t, { wholeFile: true });
  git(state.root, 'rm', '--', OLD_PATH);
  const candidate = commit(state.root, {}, 'retire the entire original source path');
  assert.ok(git(state.root, 'show', `refs/remotes/origin/main:${OLD_PATH}`).includes(SOURCE.trim()));
  assertQualified(validate(state, candidate));
});

test('an unretired same-repository candidate still has two owners after its deadline', (t) => {
  const state = fixture(t);
  assertRetained(validate(state, state.activeCommit));
});

test('a symlink at the old source path supplies no proof that its source slice has retired', (t) => {
  const state = fixture(t);
  git(state.root, 'rm', '--', OLD_PATH);
  mkdirSync(dirname(join(state.root, OLD_PATH)), { recursive: true });
  symlinkSync(`../${CORE_PATH}`, join(state.root, OLD_PATH));
  const candidate = commit(state.root, {}, 'replace old path with an unreadable-as-code symlink');
  const result = validate(state, candidate);
  assert.ok(result.deferred.some((one) => /old copy.*not readable/.test(one)), JSON.stringify(result, null, 2));
});

test('an unreadable candidate revision cannot turn unknown old-source state into absence', (t) => {
  const state = fixture(t);
  const result = validate(state, 'f'.repeat(40));
  assert.equal(result.valid, false);
  assert.ok(result.deferred.some((one) => /old copy.*not readable/.test(one)), JSON.stringify(result, null, 2));
});

test('a directory at the old file path remains unreadable in both the candidate and staged index', (t) => {
  const state = fixture(t, { wholeFile: true });
  git(state.root, 'rm', '--', OLD_PATH);
  write(state.root, `${OLD_PATH}/index.mjs`, ORIGINAL);
  const candidate = commit(state.root, {}, 'replace the old file with a directory containing code');
  for (const tree of [candidate, ':']) {
    const result = validate(state, tree);
    assert.ok(result.deferred.some((one) => /old copy.*not readable/.test(one)), JSON.stringify(result));
    assert.equal(gitReaders({ root: state.root, tree }).readTarget(OLD_PATH), null);
  }
});

test('a parent-directory symlink remains unreadable in candidate, index and disk views', (t) => {
  const state = fixture(t);
  const staged = gitReaders({ root: state.root, tree: ':' });
  assert.equal(staged.retirementOf(state.contract.sources[0]).state, 'regular');
  git(state.root, 'rm', '-r', '--', 'legacy');
  symlinkSync('tools/order-rows/do-work', join(state.root, 'legacy'));
  git(state.root, 'add', '-A');
  assert.equal(staged.retirementOf(state.contract.sources[0]).state, 'unreadable', 'the staged cache must refresh when the index changes');
  const candidate = commit(state.root, {}, 'replace the old parent with an alias');
  for (const tree of [candidate, ':', undefined]) {
    const result = validate(state, tree);
    assert.ok(result.deferred.some((one) => /old copy.*not readable/.test(one)), JSON.stringify({ tree, result }));
    assert.equal(gitReaders({ root: state.root, tree }).retirementOf(state.contract.sources[0]).state, 'unreadable');
  }
});

test('removing the old parent directory really retires the source in candidate and index views', (t) => {
  const state = fixture(t);
  git(state.root, 'rm', '-r', '--', 'legacy');
  const candidate = commit(state.root, {}, 'remove the retired parent directory entirely');
  for (const tree of [candidate, ':']) {
    assert.equal(gitReaders({ root: state.root, tree }).retirementOf(state.contract.sources[0]).state, 'absent');
    assertQualified(validate(state, tree));
  }
});

test('external source retirement stays tied to origin/main despite disk, index and local-commit deletions', (t) => {
  const state = fixture(t, { external: true });
  rmSync(join(state.owner, OLD_PATH));
  assertRetained(validate(state, state.activeCommit));
  git(state.owner, 'add', '-A');
  assertRetained(validate(state, state.activeCommit));
  const retired = commit(state.owner, {}, 'retire external owner locally');
  assert.equal(git(state.owner, 'rev-parse', 'refs/remotes/origin/main'), state.sourceCommit);
  assertRetained(validate(state, state.activeCommit));
  git(state.owner, 'update-ref', 'refs/remotes/origin/main', retired);
  assertQualified(validate(state, state.activeCommit));
});

test('an external local-only retirement stays unreadable when its published main is missing', (t) => {
  const state = fixture(t, { external: true });
  const retired = commit(state.owner, { [OLD_PATH]: 'export const legacyModuleVersion = 2;\n' }, 'retire external source slice locally');
  git(state.owner, 'update-ref', '-d', 'refs/remotes/origin/main');
  assert.equal(git(state.owner, 'rev-parse', 'refs/heads/main'), retired);

  const readers = gitReaders({ root: state.root, tree: state.activeCommit });
  assert.equal(readers.retirementOf(state.contract.sources[0]).state, 'unreadable',
    'local main and HEAD are not evidence of an external published retirement');
  assert.match(validate(state, state.activeCommit).deferred.join('\n'), /old copy.*not readable/);

  git(state.owner, 'update-ref', 'refs/remotes/origin/main', retired);
  assertQualified(validate(state, state.activeCommit));
});
