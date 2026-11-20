// Immutable quotation/source evidence does not certify current targets, retirement or port admission.
// The prospective-copy shape follows the maintained contract-quotation-evidence.test.py regression.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract, validateReferenceAdaptationEvidence } from '../do-work/validate-reference-adaptation-contract.mjs';

const ORIGINAL = 'original/trillion-source.mjs', TARGET = 'active/generic.mjs';
const SOURCE = 'export const generic_value = 42;\n';
const QUOTE = 'Port the old trillion source into its existing generic owner.';
const NOW = '2026-01-04T00:00:00Z';
const identity = bytes => makeHashCodeHexFromBytes(Buffer.from(bytes));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function initialize(root) {
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'immutable-evidence-test');
  git(root, 'config', 'user.email', 'evidence@example.invalid');
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(t, { sameRepository = false, sourceText = SOURCE } = {}) {
  const home = tempFolder(join(tmpdir(), 'immutable-contract-evidence-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'receiving-owner'), old = sameRepository ? root : join(home, 'original-owner');
  initialize(old);
  write(old, 'README.md', 'Synthetic pinned source owner.\n');
  write(old, ORIGINAL, sourceText);
  const sourceCommit = commit(old, 'retain original synthetic source');
  git(old, 'update-ref', 'refs/remotes/origin/main', sourceCommit);
  git(old, 'rm', '-q', ORIGINAL);
  commit(old, 'remove source locally without publication');
  if (!sameRepository) {
    initialize(root);
    write(root, 'README.md', 'Synthetic receiving owner.\n');
    commit(root, 'initialize receiver');
  }
  write(root, TARGET, sourceText);
  git(root, 'add', '--', TARGET);
  const pin = identity(sourceText);
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-PROSPECTIVE-QUOTATION', status: 'BASELINED',
    directive: { quote: QUOTE, message_multihash: identity(QUOTE) }, mode: 'SOURCE_FIRST_PORT',
    sources: [{ repository: basename(old), commit: sourceCommit, path: ORIGINAL, multihash: pin,
      ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-01T00:00:00Z' } }],
    targets: [{ path: TARGET }], preserve: ['the original generic constant'],
    allowed_deltas: ['generic import wiring after the raw copy'],
    banned_substitutions: ['runtime product selection hidden as quoted evidence'],
    baseline: { recorded_at: '2025-12-31T00:00:00Z', copied_before_adaptation: true,
      source_multihash: pin, target_multihash_at_baseline: pin },
    proof: { minimum_meaningful_line_retention: 0.6, test_refs: [] },
  };
  const options = { readers: gitReaders({ root, repositories: { [basename(old)]: old, [basename(root)]: root } }),
    repository: basename(root), requireRepositorySources: true, now: NOW };
  return { root, old, sourceCommit, sourceText, contract, options,
    sourceBlob: git(old, 'rev-parse', `${sourceCommit}:${ORIGINAL}`) };
}

function result(f, contract = f.contract) {
  const checked = validateReferenceAdaptationEvidence(contract, f.options);
  assert.equal(checked.scope, 'immutable-contract-evidence');
  assert.equal(checked.admission, false);
  assert.equal(checked.measurements, null, 'immutable evidence supplies no retention or admission measurement');
  assert.ok(Array.isArray(checked.errors));
  assert.ok(Array.isArray(checked.deferred));
  assert.equal(git(f.old, 'rev-parse', `${f.sourceCommit}:${ORIGINAL}`), f.sourceBlob, 'the real pinned source is unchanged');
  return checked;
}

function assertEvidence(f, contract = f.contract) {
  const checked = result(f, contract);
  assert.equal(checked.valid, true, JSON.stringify(checked));
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.deferred, []);
  assert.equal(checked.id, contract.id);
  assert.equal(checked.mode, contract.mode);
  assert.equal(checked.status, contract.status);
}

function assertInvalid(f, contract, message) {
  const checked = result(f, contract);
  assert.equal(checked.valid, false, JSON.stringify(checked));
  assert.ok(checked.errors.length, message);
}

test('a prospective raw copy is immutable evidence while its old published source prevents full admission', t => {
  const f = fixture(t);
  assert.equal('commit' in f.contract.baseline, false);
  assert.equal(git(f.old, 'rev-parse', 'refs/remotes/origin/main'), f.sourceCommit);
  for (const state of ['raw', 'different', 'absent']) {
    if (state === 'different') write(f.root, TARGET, 'export const other_value = 99;\n');
    if (state === 'absent') rmSync(join(f.root, TARGET));
    assertEvidence(f);
    const admission = validateReferenceAdaptationContract(f.contract, { ...f.options, stage: 'pre-edit' });
    assert.equal(admission.valid, false, JSON.stringify({ state, admission }));
    assert.ok(admission.errors.some(error => /old copy.*still lives/.test(error)), JSON.stringify(admission));
  }
});

test('the same-repository Media quotation fixture also keeps its evidence role independently of current target state', t => {
  const f = fixture(t, { sameRepository: true });
  for (const state of ['raw', 'different', 'absent']) {
    if (state === 'different') write(f.root, TARGET, 'export const other_value = 99;\n');
    if (state === 'absent') rmSync(join(f.root, TARGET));
    assertEvidence(f);
    // Completion remains unproved: BASELINED is not VERIFIED and this prospective copy has no completion tests.
    const admission = validateReferenceAdaptationContract(f.contract, f.options);
    assert.equal(admission.valid, false, JSON.stringify({ state, admission }));
  }
});

test('real pinned selected lines are checked independently of the current target', t => {
  const lines = ['export const firstOriginalValue = 1;', 'export const secondOriginalValue = 2;', 'export const thirdOriginalValue = 3;'];
  const f = fixture(t, { sourceText: `${lines.join('\n')}\n` });
  f.contract.sources[0].lines = [2, 2];
  const selected = identity(`${lines[1]}\n`);
  f.contract.sources[0].multihash = selected;
  f.contract.baseline.source_multihash = selected;
  f.contract.baseline.target_multihash_at_baseline = selected;
  assertEvidence(f);
  const wrong = structuredClone(f.contract);
  wrong.sources[0].multihash = identity(f.sourceText);
  wrong.baseline.source_multihash = wrong.sources[0].multihash;
  wrong.baseline.target_multihash_at_baseline = wrong.sources[0].multihash;
  assertInvalid(f, wrong, 'the whole file hash cannot stand for a selected line');
});

test('declared literal redactions bind the exact resulting copy identity', t => {
  const f = fixture(t);
  f.contract.baseline.redactions = [{ from: 'generic_value', to: 'portable_value' }];
  f.contract.baseline.target_multihash_at_baseline = identity(SOURCE.replaceAll('generic_value', 'portable_value'));
  assertEvidence(f);
  const wrong = structuredClone(f.contract);
  wrong.baseline.target_multihash_at_baseline = identity(SOURCE);
  assertInvalid(f, wrong, 'an unredacted hash cannot certify the declared redacted copy');
});

test('malformed contract, schema and directive shapes are rejected', t => {
  const f = fixture(t);
  const attacks = [null, [], 42, { ...f.contract, schema: 'unknown/schema' }, { ...f.contract, id: 'not-a-reference' }];
  const missing = structuredClone(f.contract); delete missing.allowed_deltas; attacks.push(missing);
  const directive = structuredClone(f.contract); directive.directive = {}; attacks.push(directive);
  const badHash = structuredClone(f.contract); badHash.directive.message_multihash = 'sha256:not-a-message'; attacks.push(badHash);
  const emptyQuote = structuredClone(f.contract); emptyQuote.directive.quote = ' '; attacks.push(emptyQuote);
  for (const candidate of attacks) assertInvalid(f, candidate, 'malformed declaration cannot acquire immutable evidence scope');
});

test('a missing or malformed pinned source commit is rejected by real Git readers', t => {
  const f = fixture(t);
  for (const revision of ['not-a-commit', 'f'.repeat(40), git(f.old, 'rev-parse', 'HEAD')]) {
    const candidate = structuredClone(f.contract);
    candidate.sources[0].commit = revision;
    assertInvalid(f, candidate, 'only the actual source commit contains the pinned regular file');
  }
});

test('source byte drift and invalid selected-line bounds are rejected', t => {
  const f = fixture(t);
  const drift = structuredClone(f.contract); drift.sources[0].multihash = `1f:${'0'.repeat(64)}`;
  assertInvalid(f, drift, 'the declared identity must match actual source bytes');
  for (const lines of [[0, 1], [2, 1], [1, 999], ['1', 1], '1,1']) {
    const candidate = structuredClone(f.contract);
    candidate.sources[0].lines = lines;
    assertInvalid(f, candidate, 'line selection uses actual pinned file bounds');
  }
});

test('malformed redactions and mismatched declared baseline identities are rejected', t => {
  const f = fixture(t);
  for (const redactions of [[{ from: '', to: 'x' }], [{ from: 'generic_value' }], [{ from: 5, to: '' }]]) {
    const candidate = structuredClone(f.contract); candidate.baseline.redactions = redactions;
    assertInvalid(f, candidate, 'redactions are literal from/to replacements');
  }
  for (const field of ['source_multihash', 'target_multihash_at_baseline']) {
    const candidate = structuredClone(f.contract); candidate.baseline[field] = `1f:${'0'.repeat(64)}`;
    assertInvalid(f, candidate, 'declared baseline identities must agree with the pinned source and copy declarations');
  }
});

test('a literal port directive cannot be relabeled as a non-copy mode', t => {
  const f = fixture(t);
  for (const mode of ['BEHAVIORAL_PORT', 'INSPIRATION_ONLY', 'NO_PRIOR_OWNER']) {
    const candidate = structuredClone(f.contract); candidate.mode = mode;
    const checked = result(f, candidate);
    assert.equal(checked.valid, false, JSON.stringify(checked));
    assert.ok(checked.errors.some(error => /literal copy\/port\/exact-same directive/.test(error)), JSON.stringify(checked));
  }
});

test('a source-looking symlink committed to real Git is not readable immutable source evidence', t => {
  const f = fixture(t);
  mkdirSync(dirname(join(f.old, ORIGINAL)), { recursive: true });
  symlinkSync(SOURCE, join(f.old, ORIGINAL));
  const linkCommit = commit(f.old, 'a symlink is not a regular source file');
  assert.match(git(f.old, 'ls-tree', linkCommit, '--', ORIGINAL), /^120000 blob /);
  const candidate = structuredClone(f.contract); candidate.sources[0].commit = linkCommit;
  assertInvalid(f, candidate, 'link text cannot stand in for pinned regular source bytes');
});

test('unavailable repository source evidence is explicitly deferred or refused', t => {
  const f = fixture(t);
  const candidate = structuredClone(f.contract); candidate.sources[0].repository = 'unavailable-synthetic-owner';
  const checked = result(f, candidate);
  assert.ok(!checked.valid || checked.deferred.length > 0, JSON.stringify(checked));
  assert.ok(checked.errors.length || checked.deferred.length, 'an unread source never becomes complete evidence success');
});

test('exact quote-to-message hashing remains the caller responsibility rather than a new common semantic rule', t => {
  const f = fixture(t);
  f.contract.directive.message_multihash = identity('Different synthetic message bytes with valid BLAKE3 shape.');
  assertEvidence(f);
});

test('NO_PRIOR_OWNER fresh search is outside immutable evidence certification', t => {
  const f = fixture(t);
  const candidate = structuredClone(f.contract);
  candidate.mode = 'NO_PRIOR_OWNER'; candidate.directive.quote = 'Create a new projection for supplied rows.';
  candidate.job = 'project supplied rows'; candidate.sources = []; candidate.baseline = {};
  candidate.proof.search = { phrasings: ['project supplied rows'], capability_rows: [], code_patterns: ['supplied'], repositories: [] };
  const checked = result(f, candidate);
  assert.ok(!checked.valid || checked.deferred.length > 0, JSON.stringify(checked));
  assert.ok(checked.errors.length || checked.deferred.length, 'shape alone supplies no fresh-search proof');
});
