// Whole pinned bytes, copy identity and raw retention stay separate from a privacy declaration.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract, validateReferenceAdaptationEvidence } from '../do-work/validate-reference-adaptation-contract.mjs';

const OLD = 'src/original.mjs', TARGET = 'active/current.mjs', BASELINE = 'proofs/copy.mjs.held';
const PREFIX = '// Source: ', PRIVATE = 'synthetic-owner/private-source.mjs';
const BODY = Array.from({ length: 12 }, (_, i) => `export function preserveByteSource${i}(rows) { return rows.slice(${i}); }`).join('\n') + '\n';
const SOURCE = Buffer.from(`${PREFIX}${PRIVATE}\n${BODY}`);
const COPY = Buffer.from(`${PREFIX}portable-source.mjs\n${BODY}`);
const CHANGES = [{ from_bytes: [Buffer.byteLength(PREFIX), Buffer.byteLength(PREFIX + PRIVATE)], to: 'portable-source.mjs' }];
const identity = value => makeHashCodeHexFromBytes(Buffer.from(value));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root, path, bytes) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
function initialize(root) {
  mkdirSync(root); git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'byte-redaction-test'); git(root, 'config', 'user.email', 'bytes@example.invalid');
}
function commit(root) { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'synthetic committed source'); return git(root, 'rev-parse', 'HEAD'); }
function fixture(t, { source = SOURCE, copy = COPY, changes = structuredClone(CHANGES) } = {}) {
  const home = tempFolder(join(tmpdir(), 'immutable-byte-redactions-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = join(home, 'original-owner'), root = join(home, 'receiving-owner');
  initialize(old); write(old, OLD, source); const original = commit(old);
  git(old, 'rm', OLD); write(old, 'README.md', 'Retired synthetic source.\n'); const retired = commit(old);
  git(old, 'update-ref', 'refs/remotes/origin/main', retired);
  initialize(root); write(root, BASELINE, copy); const baseline = commit(root);
  write(root, TARGET, copy); const current = commit(root);
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-IMMUTABLE-BYTE-REDACTION', status: 'VERIFIED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'port the preserved source', message_multihash: identity('port the preserved source') },
    sources: [{ repository: basename(old), commit: original, path: OLD, multihash: identity(source), ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-03T00:00:00Z' } }],
    targets: [{ path: TARGET }], preserve: ['the original twelve functions'], allowed_deltas: ['declared source-copy redactions'], banned_substitutions: ['a reduced raw retention floor'],
    baseline: { commit: baseline, path: BASELINE, recorded_at: '2026-01-01T00:00:00Z', copied_before_adaptation: true,
      source_multihash: identity(source), target_multihash_at_baseline: identity(copy), redactions: changes },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['preserveByteSource11'], test_refs: ['test/synthetic.mjs'] },
  };
  const options = { readers: gitReaders({ root, repositories: { [basename(old)]: old }, tree: current }), repository: basename(root),
    activeTargetPaths: [TARGET], retentionAtLeast: 0.6, stage: 'completion', now: '2026-01-04T00:00:00Z' };
  return { root, old, original, source, contract, options };
}
function full(f) { return validateReferenceAdaptationContract(f.contract, f.options); }
function evidence(f) { const result = validateReferenceAdaptationEvidence(f.contract, f.options); assert.equal(result.admission, false); return result; }
function pass(result) { assert.equal(result.valid, true, JSON.stringify(result)); assert.deepEqual(result.errors, []); assert.deepEqual(result.deferred, []); }
function invalid(f) { for (const result of [evidence(f), full(f)]) { assert.equal(result.valid, false); assert.ok(result.errors.length); } }

test('offset-only metadata verifies a real source copy without serializing private text or a fragment hash', t => {
  const f = fixture(t); pass(evidence(f)); const result = full(f); pass(result);
  assert.equal(result.measurements.sourceMeaningfulLines, 13);
  assert.equal(result.measurements.retainedMeaningfulLines, 12);
  const declaration = JSON.stringify(f.contract.baseline.redactions);
  assert.ok(!declaration.includes(PRIVATE)); assert.ok(!declaration.includes(identity(PRIVATE)));
  assert.equal(git(f.old, 'show', `${f.original}:${OLD}`), SOURCE.toString().trim());
});
test('valid byte removal cannot shrink the full raw-source retention denominator', t => {
  const copy = Buffer.from(`${PREFIX}${PRIVATE}\n${BODY.split('\n').slice(9).join('\n')}`);
  const start = Buffer.byteLength(`${PREFIX}${PRIVATE}\n`), end = start + Buffer.byteLength(BODY.split('\n').slice(0, 9).join('\n') + '\n');
  const f = fixture(t, { copy, changes: [{ from_bytes: [start, end], to: '' }] });
  pass(evidence(f)); const result = full(f);
  assert.equal(result.valid, false); assert.equal(result.measurements.sourceMeaningfulLines, 13);
  assert.equal(result.measurements.retainedMeaningfulLines, 4); assert.match(result.errors.join('\n'), /line retention/);
});
test('an altered declared output hash or source pin is refused independently', t => {
  const f = fixture(t); f.contract.baseline.target_multihash_at_baseline = identity('different copy'); invalid(f);
  f.contract.baseline.target_multihash_at_baseline = identity(COPY); f.contract.sources[0].multihash = identity('different original'); invalid(f);
});
test('selected ranges bind their own bytes while multiple sources and non-repository inputs refuse byte offsets', t => {
  const f = fixture(t); const original = structuredClone(f.contract.sources);
  f.contract.sources[0].lines = [1, 13]; pass(evidence(f)); pass(full(f));
  f.contract.sources[0].lines = [2, 13]; invalid(f);
  f.contract.sources = [...structuredClone(original), ...structuredClone(original)]; invalid(f);
  f.contract.sources = [{ path: OLD, multihash: identity(SOURCE), ownership: 'repository-owned' }]; invalid(f);
});
test('malformed arrays, mixed declarations and overlapping ranges return structured failures', t => {
  const f = fixture(t);
  for (const changes of [null, {}, 'not an array', [null], [{ from_bytes: [0, 0], to: '' }],
    [...CHANGES, { from: 'text', to: '' }], [{ from_bytes: [0, 2], to: '' }, { from_bytes: [1, 3], to: '' }],
    [{ from_bytes: [0, SOURCE.length + 1], to: '' }], [{ from_bytes: [0, 1], to: '', extra: true }]]) {
    f.contract.baseline.redactions = changes; invalid(f);
  }
});
test('UTF-8 source and replacement boundaries stay exact across BOM and changed lengths', t => {
  const prefix = Buffer.from('\ufeff// é😀AB\n'), source = Buffer.concat([prefix, Buffer.from(BODY)]);
  const start = Buffer.byteLength('\ufeff// '), end = start + Buffer.byteLength('é😀');
  const copy = Buffer.concat([source.subarray(0, start), Buffer.from('portable'), source.subarray(end)]);
  const f = fixture(t, { source, copy, changes: [{ from_bytes: [start, end], to: 'portable' }] }); pass(evidence(f)); pass(full(f));
  for (const range of [[start, start + 1], [start + 1, end], [start + 2, end - 1]]) {
    f.contract.baseline.redactions = [{ from_bytes: range, to: '' }]; invalid(f);
  }
  f.contract.baseline.redactions = [{ from_bytes: [start, end], to: '\ud800' }]; invalid(f);
});
test('invalid UTF-8 cannot be normalized into a valid declared copy', t => {
  const source = Buffer.concat([Buffer.from([0x61, 0xc3, 0x28]), Buffer.from(BODY)]);
  const f = fixture(t, { source, changes: [{ from_bytes: [0, 1], to: '' }] }); invalid(f);
});
test('declaration accessors do not execute and errors reveal no source snippets', t => {
  const f = fixture(t); let reads = 0;
  const range = [0, 1]; Object.defineProperty(range, '0', { get() { reads += 1; return 0; }, enumerable: true });
  for (const entry of [{ from_bytes: [0, 1], get to() { reads += 1; return 'wrong'; } }, { from_bytes: range, to: '' }]) {
    f.contract.baseline.redactions = [entry]; invalid(f);
    assert.ok(!JSON.stringify(evidence(f)).includes(PRIVATE));
  }
  assert.equal(reads, 0);
});
test('legacy literal redactions remain sequential and retain their existing measurement semantics', t => {
  const f = fixture(t, { copy: Buffer.from(`${PREFIX}final-source.mjs\n${BODY}`), changes: [
    { from: PRIVATE, to: 'intermediate-source.mjs' }, { from: 'intermediate-source.mjs', to: 'final-source.mjs' },
  ] }); pass(evidence(f)); const result = full(f); pass(result); assert.equal(result.measurements.meaningfulLineRetention, 1);
});
