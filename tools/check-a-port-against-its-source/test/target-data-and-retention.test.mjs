import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes as hash } from '../../content-identity/read-data/identity.mjs';
import { judgeRepository } from '../do-work/check-a-repository-for-port-contracts.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from '../do-work/validate-reference-adaptation-contract.mjs';

const SOURCE = Array.from({ length: 12 }, (_, i) => `export function preserveSyntheticMechanism${i}(rows) { return rows.slice(${i}); }`).join('\n') + '\n';
const ACTIVE = 'src/order.mjs', DATA = 'src/settings.json', ARTIFACT = 'proofs/order-original.held';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const write = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n');
};
const commit = (root, files) => {
  for (const [path, bytes] of Object.entries(files)) write(root, path, bytes);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-q', '-m', 'synthetic fixture');
  return git(root, 'rev-parse', 'HEAD');
};

function fixture(t, { mode = 'SOURCE_FIRST_PORT', code = SOURCE, data = '{}\n', legacyArchive = false, extraTarget, artifactUnderFeature = false } = {}) {
  const base = tempFolder(join(tmpdir(), 'target-data-retention-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const old = join(base, 'old-owner'), root = join(base, 'tools-repo');
  for (const dir of [old, root]) { mkdirSync(dir); git(dir, 'init', '-q', '-b', 'main'); }
  const sourceCommit = commit(old, { 'src/order.mjs': SOURCE });
  git(old, 'update-ref', 'refs/remotes/origin/main', sourceCommit);
  const rules = {
    schema: 'port-contracts/feature-files', since: null,
    feature_files: [{ matches: '^src/.+\\.mjs$', added: true, grown_lines_over: 5 }],
    contracts_match: '^ports/.+\\.json$', modes: ['SOURCE_FIRST_PORT', 'BEHAVIORAL_PORT'],
    retention_at_least: 0.6, old_copy_days_at_most: 3,
  };
  const since = commit(root, { 'ports/feature-files.json': rules });
  rules.since = since;
  const artifact = artifactUnderFeature ? 'src/original.mjs' : ARTIFACT;
  const baseline = commit(root, { 'ports/feature-files.json': rules, [artifact]: SOURCE });
  const digest = hash(Buffer.from(SOURCE));
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-SYNTHETIC-COUPLED-DATA', status: 'ADAPTED', mode,
    directive: { quote: mode === 'SOURCE_FIRST_PORT' ? 'port the original ordering' : 'preserve the ordering behavior and settings', message_multihash: digest },
    sources: [{ repository: 'old-owner', commit: sourceCommit, path: 'src/order.mjs', multihash: digest, ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-03T00:00:00Z' } }],
    targets: [{ path: ACTIVE }, { path: DATA }], preserve: ['the ordering behavior'], allowed_deltas: ['coupled configuration'], banned_substitutions: ['archive retention'],
    baseline: { path: artifact, commit: baseline, copied_before_adaptation: true, source_multihash: digest, target_multihash_at_baseline: digest, recorded_at: '2026-01-01T00:00:00Z' },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['preserveSyntheticMechanism11'], test_refs: ['synthetic:ordering'] },
  };
  if (legacyArchive) { delete contract.baseline.path; contract.targets.unshift({ path: ARTIFACT }); }
  if (extraTarget) contract.targets.push({ path: extraTarget });
  const files = { [ACTIVE]: code, 'ports/order.json': contract };
  if (data !== null && data !== 'symlink') files[DATA] = data;
  if (data === 'symlink') { mkdirSync(join(root, 'src'), { recursive: true }); symlinkSync('../' + ARTIFACT, join(root, DATA)); }
  if (artifactUnderFeature) contract.targets.push({ path: artifact });
  commit(root, files);
  const policyBefore = readFileSync(join(root, 'ports/feature-files.json'));
  const result = judgeRepository({ root, span: { from: since, to: 'HEAD' }, now: '2026-01-02T00:00:00Z' });
  assert.deepEqual(readFileSync(join(root, 'ports/feature-files.json')), policyBefore, 'target admission does not change feature policy');
  return { result, errors: result.judged.flatMap(row => row.errors).join('\n') };
}

for (const mode of ['SOURCE_FIRST_PORT', 'BEHAVIORAL_PORT']) {
  test(`${mode} admits coupled current DATA without making it feature coverage`, t => {
    const { result } = fixture(t, { mode });
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.deepEqual(result.judged.map(row => row.path), [ACTIVE]);
    assert.deepEqual(result.judged[0].deferred, []);
  });
}

test('a missing coupled DATA target is refused while ADAPTED', t => {
  const { result, errors } = fixture(t, { mode: 'BEHAVIORAL_PORT', data: null });
  assert.equal(result.valid, false);
  assert.match(errors, /target missing: src\/settings\.json/);
});

test('a DATA symlink cannot borrow its original-copy artifact', t => {
  const { result, errors } = fixture(t, { data: 'symlink' });
  assert.equal(result.valid, false);
  assert.match(errors, /target missing: src\/settings\.json/);
});

test('an existing archive and DATA text cannot replace active retention or mechanisms', t => {
  const { result, errors } = fixture(t, { code: 'export const unrelatedImplementation = true;\n', data: { original: SOURCE }, legacyArchive: true });
  assert.equal(result.valid, false);
  assert.match(errors, /separate artifact belongs in baseline.path/);
  assert.match(errors, /meaningful line retention 0\.0000/);
  assert.match(errors, /required mechanism missing/);
});

test('coupled DATA cannot supply a mechanism removed from otherwise retained active code', t => {
  const { result, errors } = fixture(t, { code: SOURCE.split('\n').filter(line => !line.includes('preserveSyntheticMechanism11')).join('\n'), data: { mechanism: 'preserveSyntheticMechanism11' } });
  assert.equal(result.valid, false);
  assert.doesNotMatch(errors, /meaningful line retention/);
  assert.match(errors, /required mechanism missing: preserveSyntheticMechanism11/);
});

test('a contract cannot count its own separate artifact even under a feature path', t => {
  const { result, errors } = fixture(t, { code: 'export const unrelatedImplementation = true;\n', artifactUnderFeature: true });
  assert.equal(result.valid, false);
  assert.match(errors, /targets must not name baseline artifacts/);
  assert.match(errors, /meaningful line retention 0\.0000/);
});

test('current DATA admission never permits a repository traversal target', t => {
  const { result, errors } = fixture(t, { mode: 'BEHAVIORAL_PORT', extraTarget: '../outside.json' });
  assert.equal(result.valid, false);
  assert.match(errors, /canonical repository-relative paths/);
});

// Both contracts share genuine history, but only the second uses ACTIVE as a
// separate historical artifact. That role cannot exclude the first's live code.
for (const adaptInPlace of [false, true]) {
  test(`a historical baseline path remains valid active code (${adaptInPlace ? 'adapted' : 'unchanged'} in place)`, t => {
    const base = tempFolder(join(tmpdir(), 'historical-active-baseline-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const root = join(base, 'tools-repo');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    commit(root, { [ACTIVE]: 'export const earlierImplementation = true;\n' });
    const snapshot = commit(root, { [ACTIVE]: SOURCE });
    const digest = hash(Buffer.from(SOURCE));
    const rules = {
      schema: 'port-contracts/feature-files', since: snapshot,
      feature_files: [{ matches: '^src/.+\\.mjs$', added: true, grown_lines_over: 0 }],
      contracts_match: '^ports/.+\\.json$', modes: ['SOURCE_FIRST_PORT'],
      retention_at_least: 0.6, old_copy_days_at_most: 3,
    };
    const contract = {
      schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-SYNTHETIC-IN-PLACE', status: 'ADAPTED', mode: 'SOURCE_FIRST_PORT',
      directive: { quote: 'preserve the ordering while adapting in place', message_multihash: digest },
      sources: [{ repository: 'tools-repo', commit: snapshot, path: ACTIVE, multihash: digest, ownership: 'repository-owned', old_copy: 'same-file' }],
      targets: [{ path: ACTIVE }], preserve: ['the ordering behavior'], allowed_deltas: ['adapter'], banned_substitutions: ['unrelated rewrite'],
      baseline: { commit: snapshot, copied_before_adaptation: true, source_multihash: digest, target_multihash_at_baseline: digest, recorded_at: '2026-01-01T00:00:00Z' },
      proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['preserveSyntheticMechanism11'], test_refs: ['synthetic:ordering'] },
    };
    commit(root, { 'ports/feature-files.json': rules, 'ports/order.json': contract });
    const adapter = structuredClone(contract);
    adapter.id = 'REF-SYNTHETIC-OTHER-ADAPTER';
    adapter.sources[0].old_copy = { deleted_by: '2026-01-03T00:00:00Z' };
    adapter.targets = [{ path: 'src/adapter.mjs' }];
    adapter.baseline.path = ACTIVE;
    commit(root, {
      [ACTIVE]: SOURCE + (adaptInPlace ? 'export const currentAdaptation = true;\n' : ''),
      'src/adapter.mjs': SOURCE + 'export const otherAdapter = true;\n',
      'ports/adapter.json': adapter,
    });
    const span = { from: snapshot, to: 'HEAD' };
    const options = { root, span, now: '2026-01-02T00:00:00Z' };
    const both = judgeRepository(options);
    assert.equal(both.valid, true, JSON.stringify(both));
    assert.deepEqual(both.judged.flatMap(row => row.deferred), []);
    assert.ok(both.judged.some(row => row.path === 'src/adapter.mjs'));
    if (adaptInPlace) assert.ok(both.judged.some(row => row.path === ACTIVE));
    // Validate the unchanged file too: it need not occur in the changed span.
    const readers = gitReaders({ root, tree: 'HEAD' });
    const sameFile = validateReferenceAdaptationContract(contract, {
      stage: 'pre-edit', readers, repository: readers.self, policySince: snapshot,
      activeTargetPaths: [ACTIVE, 'src/adapter.mjs'], now: options.now,
    });
    assert.equal(sameFile.valid, true, JSON.stringify(sameFile));
    assert.deepEqual(sameFile.deferred, []);
    assert.equal(sameFile.measurements.meaningfulLineRetention, 1);
  });
}
