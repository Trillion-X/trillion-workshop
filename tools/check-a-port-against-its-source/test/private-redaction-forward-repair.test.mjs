// Real synthetic Git histories keep source chronology separate from privacy and current repair.
// These controls grant no public admission and do not adopt a forward-repair schema.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract, validateReferenceAdaptationEvidence } from '../do-work/validate-reference-adaptation-contract.mjs';

const SOURCE = Array.from({ length: 12 }, (_, n) =>
  `export function preserveRows${n}(rows) { return rows.slice(${n}); }`).join('\n') + '\n';
const ORIGINAL = 'src/order-rows.mjs';
const ACTIVE = 'tools/order-rows/do-work/core.mjs';
const ADAPTER = 'tools/order-rows/do-work/adapter.mjs';
const HELD = 'proofs/order-rows.mjs.held';
const identity = value => makeHashCodeHexFromBytes(Buffer.from(value));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(root, files, message) {
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(t, { priorAdaptation = false, rawRevert = false, archiveOnly = false,
  changedCapture = false, freshOwner = false, adoption = 'live', sourceText = SOURCE,
  copiedText = sourceText, redactions, requiredMechanism = 'function preserveRows3', retainedAdapter = false } = {}) {
  const home = tempFolder(join(tmpdir(), 'private-redaction-forward-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = join(home, 'original-owner'), root = join(home, 'receiving-owner');
  for (const folder of [old, root]) {
    mkdirSync(folder);
    git(folder, 'init', '-q', '-b', 'main');
  }
  const sourceCommit = commit(old, { [ORIGINAL]: sourceText }, 'original synthetic source');
  git(old, 'rm', ORIGINAL);
  const retired = commit(old, { 'README.md': 'The synthetic source moved.\n' }, 'retire original synthetic source');
  git(old, 'update-ref', 'refs/remotes/origin/main', retired);
  const since = commit(root, { 'README.md': 'Synthetic source policy begins here.\n' }, 'begin synthetic source policy');
  let earlier = null;
  if (freshOwner) {
    earlier = commit(root, { [ADAPTER]: 'export const priorImplementation = rows => rows.toReversed();\n' },
      'existing public adapter after policy');
  } else if (priorAdaptation) {
    earlier = commit(root, { [ACTIVE]: sourceText + 'export const earlierAdapterVersion = 2;\n' }, 'existing public adaptation after policy');
    if (rawRevert) commit(root, { [ACTIVE]: sourceText }, 'restore raw bytes without erasing earlier adaptation');
  }
  const baselinePath = freshOwner ? ACTIVE : HELD;
  const baseline = commit(root, {
    [baselinePath]: changedCapture ? copiedText.replace('rows.slice(11)', 'rows.slice(10)') : copiedText,
  }, freshOwner ? 'copy full source into the fresh active owner' : 'capture full original in an archive');
  const current = commit(root, {
    [ACTIVE]: archiveOnly ? 'export const unrelatedImplementation = true;\n'
      : copiedText + 'export const currentAdapterVersion = 2;\nexport const currentCallerVersion = 3;\n',
    ...(freshOwner ? { [ADAPTER]: adoption === 'live'
      ? (retainedAdapter ? sourceText + "export { preserveRows210 as currentImplementation } from './core.mjs';\n"
        : "export { preserveRows0 as currentImplementation } from './core.mjs';\n")
      : adoption === 'comment'
        ? "// use preserveRows0 from './core.mjs'\nexport const currentImplementation = rows => rows.toReversed();\n"
        : "import { preserveRows0 } from './core.mjs';\nexport const unusedOriginalCopy = preserveRows0;\nexport const currentImplementation = rows => rows.toReversed();\n" } : {}),
  }, 'adapt current owner without rewriting earlier history');
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-SYNTHETIC-CURRENT-REPAIR-CONSUMER', status: 'VERIFIED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'Synthetic fixture: preserve the original row operations',
      message_multihash: identity('synthetic original row operations') },
    sources: [{ repository: basename(old), commit: sourceCommit, path: ORIGINAL, multihash: identity(sourceText),
      ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-03T00:00:00Z' } }],
    // Existing adapters never supply this new owner's retained source lines.
    targets: [{ path: ACTIVE }],
    preserve: ['all twelve original row operations'], allowed_deltas: ['one current adapter export'],
    banned_substitutions: ['an archive or an existing adapter standing in for the active source owner'],
    baseline: { commit: baseline, ...(freshOwner ? {} : { path: HELD }),
      recorded_at: '2026-01-01T00:00:00Z', copied_before_adaptation: true,
      source_multihash: identity(sourceText), target_multihash_at_baseline: identity(copiedText),
      ...(redactions ? { redactions } : {}) },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: [requiredMechanism],
      test_refs: ['tools/check-a-port-against-its-source/test/private-redaction-forward-repair.test.mjs'] },
  };
  const readers = gitReaders({ root, tree: current, repositories: { [basename(old)]: old } });
  const result = validateReferenceAdaptationContract(contract, {
    readers, repository: basename(root), stage: 'completion', activeTargetPaths: [ACTIVE, ADAPTER],
    policySince: since, retentionAtLeast: 0.6, oldCopyDaysAtMost: 3, now: '2026-01-04T00:00:00Z',
  });
  assert.deepEqual(result.deferred, [], 'the opposing case must have complete real Git inputs');
  if (earlier) git(root, 'merge-base', '--is-ancestor', earlier, current);
  return { root, current, baseline, earlier, result, contract, readers };
}

test('an exact private capture before active adaptation supplies the chronology control', t => {
  const { result } = fixture(t);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.measurements.meaningfulLineRetention, 1);
});

test('an archive added after public adaptation cannot retroactively certify source-first history', t => {
  const { result } = fixture(t, { priorAdaptation: true });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /baseline must precede active adaptation/);
  assert.equal(result.measurements.meaningfulLineRetention, 1, 'retention does not excuse earlier adaptation');
});

test('a raw-byte revert before the archive preserves the earlier noncompliant event', t => {
  const { result } = fixture(t, { priorAdaptation: true, rawRevert: true });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /baseline must precede active adaptation/);
  assert.equal(result.measurements.meaningfulLineRetention, 1);
});

test('the complete held source supplies no retained lines to an unrelated active owner', t => {
  const { result } = fixture(t, { archiveOnly: true });
  assert.equal(result.valid, false);
  assert.equal(result.measurements.meaningfulLineRetention, 0);
  assert.match(result.errors.join('\n'), /meaningful line retention/);
  assert.match(result.errors.join('\n'), /required mechanism missing/);
});

test('a changed byte in the claimed complete capture fails despite intact active source', t => {
  const { result } = fixture(t, { changedCapture: true });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /at baseline.commit is not the source's bytes/);
  assert.equal(result.measurements.meaningfulLineRetention, 1);
});

test('a fresh active owner can have true copy-before-adapt history while preserving an older adapter', async t => {
  const { root, current, earlier, result } = fixture(t, { freshOwner: true });
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.measurements.meaningfulLineRetention, 1);
  assert.match(git(root, 'show', `${earlier}:${ADAPTER}`), /priorImplementation/);
  assert.match(git(root, 'show', `${current}:${ADAPTER}`), /from '\.\/core\.mjs'/);
  const consumer = await import(pathToFileURL(join(root, ADAPTER)).href);
  const input = ['sample-a', 'sample-b', 'sample-c'];
  const actual = consumer.currentImplementation(input);
  assert.deepEqual(actual, input);
  assert.notEqual(actual, input, 'the native consumer must call the original slice operation');
  // This proves only the new owner's source chronology. It grants neither old-adapter historical
  // compliance nor privacy/publication, and is not a substitute for a future admitted repair consumer.
});

for (const adoption of ['comment', 'dead-copy']) {
  test(`a ${adoption} reference is not proof that the actual adapter adopted the source owner`, async t => {
    const { root, result } = fixture(t, { freshOwner: true, adoption });
    assert.equal(result.valid, true, 'source chronology alone has a deliberately smaller scope than runtime adoption');
    const consumer = await import(pathToFileURL(join(root, ADAPTER)).href);
    const input = ['sample-a', 'sample-b', 'sample-c'];
    assert.notDeepEqual(consumer.currentImplementation(input), input,
      'a test ref, comment or unused source import must not be called a passing native consumer');
  });
}

const PRIVATE_HEADER = '// Synthetic private fixture marker — café; never a real source value.\n';
const WHOLE_FUNCTIONS = Array.from({ length: 221 }, (_, n) =>
  `export function preserveRows${n}(rows) { return rows.slice(${n}); }\n`);
const WHOLE_SOURCE = PRIVATE_HEADER + WHOLE_FUNCTIONS.join('');

test('a whole pinned UTF-8 copy admits byte-only metadata while measuring the untouched 222-line source', t => {
  const redactions = [{ from_bytes: [0, Buffer.byteLength(PRIVATE_HEADER)], to: '' }];
  const { result, contract, readers } = fixture(t, { freshOwner: true, sourceText: WHOLE_SOURCE,
    copiedText: WHOLE_FUNCTIONS.join(''), redactions, requiredMechanism: 'function preserveRows210' });
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.measurements.sourceMeaningfulLines, 222);
  assert.equal(result.measurements.retainedMeaningfulLines, 221);
  assert.equal(result.measurements.meaningfulLineRetention, 221 / 222);
  const immutable = validateReferenceAdaptationEvidence(contract, { readers });
  assert.equal(immutable.valid, true, JSON.stringify(immutable));
  assert.equal(immutable.admission, false);
  assert.equal(contract.sources[0].multihash, identity(WHOLE_SOURCE));
  assert.notEqual(contract.baseline.target_multihash_at_baseline, contract.sources[0].multihash);
  assert.equal(JSON.stringify(contract).includes(PRIVATE_HEADER.trim()), false);
  assert.deepEqual(Object.keys(redactions[0]).sort(), ['from_bytes', 'to']);
});

test('byte redactions and an intact old adapter cannot shrink the new owner\'s full 222-line floor', t => {
  const removed = PRIVATE_HEADER + WHOLE_FUNCTIONS.slice(0, 90).join('');
  const { result, root, current } = fixture(t, { freshOwner: true, sourceText: WHOLE_SOURCE,
    copiedText: WHOLE_FUNCTIONS.slice(90).join(''),
    redactions: [{ from_bytes: [0, Buffer.byteLength(removed)], to: '' }],
    requiredMechanism: 'function preserveRows210', retainedAdapter: true });
  assert.equal(result.valid, false);
  assert.equal(result.measurements.sourceMeaningfulLines, 222);
  assert.equal(result.measurements.retainedMeaningfulLines, 131);
  assert.equal(result.measurements.meaningfulLineRetention, 131 / 222);
  assert.match(result.errors.join('\n'), /meaningful line retention/);
  assert.equal(result.errors.some(error => /required mechanism missing/.test(error)), false);
  assert.ok(git(root, 'show', `${current}:${ADAPTER}`).includes(WHOLE_FUNCTIONS[0].trim()),
    'the old adapter really holds the excluded original lines');
});

test('a byte range cutting a UTF-8 code point fails through the actual immutable evidence API', t => {
  const midCodePoint = Buffer.byteLength(PRIVATE_HEADER.slice(0, PRIVATE_HEADER.indexOf('é'))) + 1;
  const { contract, readers } = fixture(t, { freshOwner: true, sourceText: WHOLE_SOURCE,
    copiedText: WHOLE_FUNCTIONS.join(''),
    redactions: [{ from_bytes: [midCodePoint, Buffer.byteLength(PRIVATE_HEADER)], to: '' }],
    requiredMechanism: 'function preserveRows210' });
  const result = validateReferenceAdaptationEvidence(contract, { readers });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.equal(result.errors.join('\n').includes(PRIVATE_HEADER.trim()), false);
  assert.equal(result.admission, false);
});
