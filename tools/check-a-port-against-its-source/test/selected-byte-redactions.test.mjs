// Selected source bytes remain pinned independently of copy transformation and active history.
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

const SOURCE_PATH = 'src/original.mjs', BASELINE = 'proofs/selected.mjs.held', TARGET = 'active/core.mjs';
const prefix = Array.from({ length: 8 }, (_, i) => `// Unselected synthetic prefix line ${i}\r\n`).join('');
const header = '// Synthetic source marker é😀 retained-range example\r\n';
const functions = Array.from({ length: 46 }, (_, i) => `export function selectedRows${i}(rows) { return rows.slice(${i}); }\r\n`);
const selected = Buffer.from(header + functions.join(''));
const source = Buffer.concat([Buffer.from(prefix), selected, Buffer.from('// Unselected synthetic suffix\r\n')]);
const start = Buffer.byteLength('// Synthetic source marker '), end = start + Buffer.byteLength('é😀');
const changes = [{ from_bytes: [start, end], to: 'portable' }];
const transformed = Buffer.concat([selected.subarray(0, start), Buffer.from('portable'), selected.subarray(end)]);
const identity = bytes => makeHashCodeHexFromBytes(Buffer.from(bytes));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root, path, bytes) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
function commit(root, message) { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); }
function fixture(t, { original = source, copy = transformed, redactions = structuredClone(changes), prior = false, baselineCopy = copy, adapter = false } = {}) {
  const home = tempFolder(join(tmpdir(), 'selected-byte-redactions-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = join(home, 'original-owner'), root = join(home, 'receiving-owner');
  for (const folder of [old, root]) {
    mkdirSync(folder); git(folder, 'init', '-q', '-b', 'main');
    git(folder, 'config', 'user.name', 'Synthetic fixture'); git(folder, 'config', 'user.email', 'fixture@example.invalid');
  }
  write(old, SOURCE_PATH, original); const originalCommit = commit(old, 'immutable synthetic original');
  const originalBlob = git(old, 'rev-parse', `${originalCommit}:${SOURCE_PATH}`);
  git(old, 'rm', SOURCE_PATH); write(old, 'README.md', 'Retired synthetic source.\n');
  git(old, 'update-ref', 'refs/remotes/origin/main', commit(old, 'retire old source'));
  write(root, 'README.md', 'Synthetic source policy.\n'); const policy = commit(root, 'begin policy');
  if (prior) { write(root, TARGET, 'export const unrelatedEarlierImplementation = true;\n'); commit(root, 'prior active adaptation'); }
  write(root, BASELINE, baselineCopy); const baseline = commit(root, 'copy selected source before fresh target');
  const baselineBlob = git(root, 'rev-parse', `${baseline}:${BASELINE}`);
  write(root, TARGET, copy);
  if (adapter) write(root, 'active/old-adapter.mjs', selected);
  const current = commit(root, 'adapt fresh core without replacing baseline');
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-SELECTED-BYTE-REDACTION', status: 'VERIFIED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'Preserve the synthetic selected source', message_multihash: identity('synthetic selected source directive') },
    sources: [{ repository: basename(old), commit: originalCommit, path: SOURCE_PATH, lines: [9, 55], multihash: identity(selected), ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-03T00:00:00Z' } }],
    targets: [{ path: TARGET }], preserve: ['the selected row functions'], allowed_deltas: ['declared byte transformation'], banned_substitutions: ['reduced selected-source retention or repaired chronology'],
    baseline: { path: BASELINE, commit: baseline, recorded_at: '2026-01-01T00:00:00Z', copied_before_adaptation: true, source_multihash: identity(selected), target_multihash_at_baseline: identity(copy), redactions },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['selectedRows45'], test_refs: ['test/synthetic.mjs'] },
  };
  const options = { readers: gitReaders({ root, tree: current, repositories: { [basename(old)]: old } }), repository: basename(root), stage: 'completion', activeTargetPaths: [TARGET], policySince: policy, retentionAtLeast: 0.6, oldCopyDaysAtMost: 3, now: '2026-01-04T00:00:00Z' };
  return { root, old, originalCommit, originalBlob, baseline, baselineBlob, contract, options };
}
function evidence(f) { return validateReferenceAdaptationEvidence(f.contract, f.options); }
function full(f) { return validateReferenceAdaptationContract(f.contract, f.options); }
function pass(answer) { assert.equal(answer.valid, true, JSON.stringify(answer)); assert.deepEqual(answer.errors, []); assert.deepEqual(answer.deferred, []); }
function refuse(f) { for (const answer of [evidence(f), full(f)]) { assert.equal(answer.valid, false); assert.ok(answer.errors.length); } }

test('one immutable source lines 9-55 uses original selection-relative UTF-8 offsets and raw retention', t => {
  const f = fixture(t); pass(evidence(f)); const answer = full(f); pass(answer);
  assert.equal(answer.measurements.sourceMeaningfulLines, 47);
  assert.equal(answer.measurements.retainedMeaningfulLines, 46);
  assert.equal(answer.measurements.meaningfulLineRetention, 46 / 47);
  assert.equal(git(f.old, 'rev-parse', `${f.originalCommit}:${SOURCE_PATH}`), f.originalBlob);
  assert.equal(git(f.root, 'rev-parse', `${f.baseline}:${BASELINE}`), f.baselineBlob);
  assert.deepEqual(Object.keys(f.contract.baseline.redactions[0]).sort(), ['from_bytes', 'to']);
});

test('selected byte mode preserves a final line without synthesizing a newline', t => {
  const rawSelection = selected.subarray(0, selected.length - 2);
  const rawCopy = transformed.subarray(0, transformed.length - 2);
  const f = fixture(t, { original: Buffer.concat([Buffer.from(prefix), rawSelection]), copy: rawCopy });
  f.contract.sources[0].multihash = f.contract.baseline.source_multihash = identity(rawSelection);
  pass(evidence(f)); pass(full(f));
});

test('selected byte mode refuses malformed line pairs, selected hashes and immutable locators', t => {
  const f = fixture(t), original = structuredClone(f.contract);
  for (const lines of [[0, 55], [55, 9], [9, 999], [9, 55, 56], [9], [9.5, 55], [9, Infinity], { 0: 9, 1: 55 }]) {
    f.contract = structuredClone(original); f.contract.sources[0].lines = lines; refuse(f);
  }
  const accessor = [9, 55]; let reads = 0;
  Object.defineProperty(accessor, '0', { get() { reads += 1; return 9; }, enumerable: true });
  f.contract = structuredClone(original); f.contract.sources[0].lines = accessor; refuse(f); assert.equal(reads, 0);
  for (const pin of [identity(source), identity('unrelated selected bytes')]) {
    f.contract = structuredClone(original); f.contract.sources[0].multihash = f.contract.baseline.source_multihash = pin; refuse(f);
  }
  for (const [key, value] of [['commit', 'f'.repeat(40)], ['path', 'src/missing.mjs']]) {
    f.contract = structuredClone(original); f.contract.sources[0][key] = value; refuse(f);
  }
});

test('selected byte mode refuses overlap, full-file offsets, code-point splits and malformed UTF-8', t => {
  const f = fixture(t), original = structuredClone(f.contract);
  for (const redactions of [
    [{ from_bytes: [start, end], to: '' }, { from_bytes: [end - 1, end + 1], to: '' }],
    [{ from_bytes: [selected.length, source.length], to: '' }],
    [{ from_bytes: [start, start + 1], to: '' }],
    [{ from_bytes: [start + 1, end], to: '' }],
    [{ from_bytes: [start, end], to: '\ud800' }],
  ]) { f.contract = structuredClone(original); f.contract.baseline.redactions = redactions; refuse(f); }
  const malformed = Buffer.from(source); malformed[Buffer.byteLength(prefix) + start] = 0xff;
  refuse(fixture(t, { original: malformed }));
  const malformedPrefix = Buffer.from(source); malformedPrefix[0] = 0xff;
  refuse(fixture(t, { original: malformedPrefix }));
});

test('selected byte mode keeps one source and exact transformed baseline identity', t => {
  const f = fixture(t); f.contract.sources.push(structuredClone(f.contract.sources[0])); refuse(f);
  const unpinned = fixture(t); delete unpinned.contract.sources[0].repository; refuse(unpinned);
  const other = fixture(t); other.contract.baseline.target_multihash_at_baseline = identity('different copy'); refuse(other);
  const changed = fixture(t, { baselineCopy: Buffer.from('a different immutable baseline\n') });
  pass(evidence(changed)); assert.equal(full(changed).valid, false);
  const wholeBaseline = fixture(t, { baselineCopy: source });
  wholeBaseline.contract.baseline.target_multihash_at_baseline = identity(source); refuse(wholeBaseline);
});

test('removing source lines cannot lower the selected raw denominator or borrow an old adapter', t => {
  const removeThrough = Buffer.byteLength(header + functions.slice(0, 20).join(''));
  const f = fixture(t, { copy: selected.subarray(removeThrough), redactions: [{ from_bytes: [0, removeThrough], to: '' }], adapter: true });
  pass(evidence(f)); const answer = full(f);
  assert.equal(answer.valid, false); assert.equal(answer.measurements.sourceMeaningfulLines, 47);
  assert.equal(answer.measurements.retainedMeaningfulLines, 26);
  assert.match(answer.errors.join('\n'), /meaningful line retention/);
});

test('an exact selected copy never launders earlier active adaptation history', t => {
  const f = fixture(t, { prior: true }); pass(evidence(f));
  const answer = full(f); assert.equal(answer.valid, false);
  assert.match(answer.errors.join('\n'), /baseline must precede active adaptation/);
});
