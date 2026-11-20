import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract, validateReferenceAdaptationEvidence } from '../do-work/validate-reference-adaptation-contract.mjs';

const hash = bytes => makeHashCodeHexFromBytes(Buffer.from(bytes));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function fixture(t, source, redactions, expected) {
  const home = tempFolder(join(tmpdir(), 'source-copy-redactions-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = join(home, 'original-owner'), root = join(home, 'receiving-owner');
  const git = (folder, ...args) => execFileSync('git', ['--no-replace-objects', '-C', folder, ...args],
    { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const folder of [old, root]) {
    mkdirSync(folder);
    git(folder, 'init', '-q', '-b', 'main');
    git(folder, 'config', 'user.name', 'Synthetic source fixture');
    git(folder, 'config', 'user.email', 'source@example.invalid');
  }
  writeFileSync(join(old, 'source.mjs'), source);
  git(old, 'add', 'source.mjs');
  git(old, 'commit', '-qm', 'retain complete synthetic source');
  const sourceCommit = git(old, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'README.md'), 'Synthetic receiving owner.\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'initialize receiver');
  const quote = 'Port the complete synthetic source into this existing owner.';
  const pin = hash(source);
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-SOURCE-COPY-REDACTIONS', status: 'BASELINED',
    directive: { quote, message_multihash: hash(quote) }, mode: 'SOURCE_FIRST_PORT',
    sources: [{ repository: 'original-owner', commit: sourceCommit, path: 'source.mjs', multihash: pin,
      ownership: 'repository-owned', old_copy: { deleted_by: '2099-01-01T00:00:00Z' } }],
    targets: [{ path: 'active.mjs' }], preserve: ['the complete generic source mechanism'],
    allowed_deltas: ['explicit source-copy redactions'], banned_substitutions: ['source substitution or archive-only retention'],
    baseline: { copied_before_adaptation: true, source_multihash: pin, target_multihash_at_baseline: hash(expected), redactions },
    proof: { minimum_meaningful_line_retention: 0.6, test_refs: [] },
  };
  const options = { readers: gitReaders({ root, repositories: { 'original-owner': old, 'receiving-owner': root } }),
    repository: 'receiving-owner', requireRepositorySources: true };
  const sourceBlob = git(old, 'rev-parse', sourceCommit + ':source.mjs');
  return { contract, options, root, old, git, sourceBlob };
}

function check(f, contract = f.contract) {
  const answer = validateReferenceAdaptationEvidence(contract, f.options);
  assert.equal(answer.scope, 'immutable-contract-evidence');
  assert.equal(answer.admission, false);
  assert.equal(answer.measurements, null);
  assert.equal(f.git(f.old, 'rev-parse', contract.sources[0].commit + ':source.mjs'), f.sourceBlob);
  return answer;
}

function valid(f, contract = f.contract) {
  const answer = check(f, contract);
  assert.equal(answer.valid, true, JSON.stringify(answer));
  assert.deepEqual(answer.errors, []);
  assert.deepEqual(answer.deferred, []);
}

function invalid(f, contract = f.contract) {
  const answer = check(f, contract);
  assert.equal(answer.valid, false);
  assert.ok(answer.errors.length > 0);
  return answer;
}

test('public validator proves byte redaction without serializing removed text or a fragment identity', t => {
  const withheld = 'synthetic-owner/place/example.py';
  const prefix = '// Source: ';
  const source = Buffer.from(prefix + withheld + '\nexport const count = 7;\n');
  const changes = [{ from_bytes: [Buffer.byteLength(prefix), Buffer.byteLength(prefix + withheld)], to: 'portable-source.py' }];
  const f = fixture(t, source, changes, '// Source: portable-source.py\nexport const count = 7;\n');
  valid(f);
  assert.equal(JSON.stringify(f.contract).includes(withheld), false);
  assert.equal(JSON.stringify(changes).includes(hash(Buffer.from(withheld))), false);
  assert.deepEqual(readFileSync(join(f.old, 'source.mjs')), source);
});

test('public validator uses original Unicode/BOM/CRLF offsets across adjacent spans and changed output lengths', t => {
  const source = Buffer.from('\ufeffAé😀BC\r\n');
  const f = fixture(t, source, [
    { from_bytes: [4, 6], to: 'long replacement' },
    { from_bytes: [6, 10], to: '' },
    { from_bytes: [11, 12], to: 'Z' },
  ], '\ufeffAlong replacementBZ\r\n');
  valid(f);
});

test('public validator binds complete pinned source and exact transformed copy identities', t => {
  const source = Buffer.from('synthetic confidential source');
  const f = fixture(t, source, [{ from_bytes: [0, source.length], to: 'replacement' }], 'replacement');
  valid(f);
  const wrongSource = structuredClone(f.contract);
  wrongSource.sources[0].multihash = wrongSource.baseline.source_multihash = hash('other');
  invalid(f, wrongSource);
  const wrongCopy = structuredClone(f.contract);
  wrongCopy.baseline.target_multihash_at_baseline = hash('other copy');
  invalid(f, wrongCopy);
});

test('public validator refuses malformed, mixed, overlapping, reordered and hidden byte declarations', t => {
  const f = fixture(t, Buffer.from('abcdefgh'), [{ from_bytes: [0, 1], to: 'x' }], 'xbcdefgh');
  valid(f);
  const good = { from_bytes: [0, 1], to: 'x' };
  const hidden = { from_bytes: [0, 1], to: '' };
  Object.defineProperty(hidden, 'extra', { value: true });
  const symbolic = { from_bytes: [0, 1], to: '', [Symbol('extra')]: true };
  const sparse = []; sparse.length = 1;
  const extraRange = [0, 1]; extraRange.extra = true;
  for (const changes of [
    [null], [{}], [{ from_bytes: [], to: '' }], [{ from_bytes: [0, 1, 2], to: '' }],
    [{ from_bytes: [0, 0], to: '' }], [{ from_bytes: [-1, 1], to: '' }], [{ from_bytes: [0, 9], to: '' }],
    [{ from_bytes: [0, 1.5], to: '' }], [{ from_bytes: [0, Infinity], to: '' }],
    [{ from_bytes: [0, Number.MAX_SAFE_INTEGER + 1], to: '' }],
    [{ from_bytes: [0, 1], to: '', extra: true }], [{ from_bytes: [0, 1] }],
    [{ from_bytes: [0, 1], to: 5 }], [{ from_bytes: [0, 1], to: '\ud800' }],
    [good, { from: 'b', to: 'z' }], [good, { from_bytes: [0, 2], to: '' }],
    [{ from_bytes: [3, 4], to: '' }, good], [good, {}], [hidden], [symbolic], sparse,
    [{ from_bytes: extraRange, to: '' }],
  ]) {
    const contract = structuredClone(f.contract);
    contract.baseline.redactions = changes;
    invalid(f, contract);
  }
  const nonArray = structuredClone(f.contract);
  nonArray.baseline.redactions = { from_bytes: [0, 1], to: 'x' };
  invalid(f, nonArray);
});

test('public validator refuses UTF-8 splits and malformed original source bytes', t => {
  const f = fixture(t, Buffer.from('Aé😀B'), [{ from_bytes: [1, 3], to: '' }], 'A😀B');
  valid(f);
  for (const range of [[1, 2], [2, 3], [3, 4], [4, 7]]) {
    const contract = structuredClone(f.contract);
    contract.baseline.redactions = [{ from_bytes: range, to: '' }];
    invalid(f, contract);
  }
  const malformed = fixture(t, Buffer.from([0x61, 0xc3, 0x28]), [{ from_bytes: [0, 1], to: '' }], '');
  invalid(malformed);
});

test('public validator does not invoke ordinary declaration/range accessors or emit removed source text', t => {
  const secret = 'synthetic withheld source content';
  const f = fixture(t, Buffer.from(secret), [{ from_bytes: [0, 1], to: '' }], secret.slice(1));
  let reads = 0;
  const entry = { from_bytes: [0, 1], get to() { reads += 1; return 'unexpected'; } };
  const contract = structuredClone(f.contract);
  contract.baseline.redactions = [entry];
  assert.equal(JSON.stringify(invalid(f, contract)).includes(secret), false);
  const range = [0, 1];
  Object.defineProperty(range, '0', { get() { reads += 1; return 0; }, enumerable: true });
  contract.baseline.redactions = [{ from_bytes: range, to: '' }];
  invalid(f, contract);
  assert.equal(reads, 0);
});

test('public validator preserves legacy sequential literal replacements and unchanged copies', t => {
  const source = Buffer.from('alpha alpha');
  const f = fixture(t, source, [{ from: 'alpha', to: 'beta' }, { from: 'beta', to: 'gamma' }], 'gamma gamma');
  valid(f);
  const unchanged = structuredClone(f.contract);
  unchanged.baseline.redactions = [];
  unchanged.baseline.target_multihash_at_baseline = hash(source);
  valid(f, unchanged);
  for (const changes of [[{ from: '', to: 'x' }], [{ from: 'alpha' }], [{ from: 1, to: 'x' }]]) {
    const contract = structuredClone(f.contract); contract.baseline.redactions = changes; invalid(f, contract);
  }
});

test('byte redaction requires exactly one immutable source and binds selected bytes', t => {
  const f = fixture(t, Buffer.from('export const generic_source = 7;\n'), [{ from_bytes: [0, 6], to: 'export' }], 'export const generic_source = 7;\n');
  valid(f);
  const multiple = structuredClone(f.contract); multiple.sources.push(structuredClone(multiple.sources[0])); invalid(f, multiple);
  const selected = structuredClone(f.contract); selected.sources[0].lines = [1, 1]; valid(f, selected);
  selected.sources[0].lines = [1, 1, 1]; invalid(f, selected);
});

test('full admission keeps raw-source retention separate from an exact redacted baseline copy', t => {
  const header = '// synthetic withheld source location';
  const source = Buffer.from(header + '\nexport const preservedAlphaValue = 1;\nexport const preservedBetaValue = 2;\nexport const preservedGammaValue = 3;\n');
  const copy = '// generic\nexport const preservedAlphaValue = 1;\nexport const preservedBetaValue = 2;\nexport const preservedGammaValue = 3;\n';
  const f = fixture(t, source, [{ from_bytes: [0, Buffer.byteLength(header)], to: '// generic' }], copy);
  mkdirSync(join(f.root, 'ports'));
  writeFileSync(join(f.root, 'ports', 'source.held'), copy);
  f.git(f.root, 'add', 'ports/source.held');
  f.git(f.root, 'commit', '-qm', 'capture exact transformed complete source before adaptation');
  const baseline = f.git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'active.mjs'), copy);
  const contract = structuredClone(f.contract);
  contract.status = 'ADAPTED';
  Object.assign(contract.baseline, { path: 'ports/source.held', commit: baseline });
  const answer = validateReferenceAdaptationContract(contract, {
    ...f.options, stage: 'pre-edit', activeTargetPaths: ['active.mjs'], retentionAtLeast: 0.6,
  });
  assert.equal(answer.valid, true, JSON.stringify(answer));
  assert.equal(answer.measurements.sourceMeaningfulLines, 4);
  assert.equal(answer.measurements.retainedMeaningfulLines, 3);
  assert.equal(answer.measurements.meaningfulLineRetention, 0.75);
});
