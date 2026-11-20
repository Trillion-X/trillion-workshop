// Real pinned Git sources keep the same meaning when their repository name is private.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { judgeRepository } from '../do-work/check-a-repository-for-port-contracts.mjs';
import { validateReferenceAdaptationContract, validateReferenceAdaptationEvidence } from '../do-work/validate-reference-adaptation-contract.mjs';

const ORIGINAL = 'src/original.mjs', TARGET = 'active/rows.mjs', BASELINE = 'proofs/original.mjs.held';
const SOURCE = Array.from({ length: 8 }, (_, i) => `export function preserveTypedRows${i}(rows) { return rows.slice(${i}); }`).join('\n') + '\n';
const identity = bytes => makeHashCodeHexFromBytes(Buffer.from(bytes));
const typed = name => ({ repository_multihash: identity(name) });
const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function write(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof bytes === 'string' ? bytes : JSON.stringify(bytes));
}
function initialize(root) {
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'typed-source-test');
  git(root, 'config', 'user.email', 'typed@example.invalid');
}
function commit(root, message) {
  git(root, 'add', '-A'); git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}
function fixture(t, { self = false, ranges = false, other = false } = {}) {
  const home = tempFolder(join(tmpdir(), 'typed-source-repositories-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'receiving-owner'), owner = self ? root : join(home, 'source owner');
  initialize(owner); write(owner, ORIGINAL, SOURCE);
  const sourceCommit = commit(owner, 'original source');
  git(owner, 'update-ref', 'refs/remotes/origin/main', sourceCommit);
  const repositories = { [basename(owner)]: owner };
  if (other) {
    const second = join(home, 'other-owner'); initialize(second); write(second, ORIGINAL, SOURCE);
    assert.equal(commit(second, 'original source'), sourceCommit, 'mixed-origin opponent keeps exact commit and bytes');
    git(second, 'rm', ORIGINAL); const retired = commit(second, 'published retirement');
    git(second, 'update-ref', 'refs/remotes/origin/main', retired);
    repositories['other-owner'] = second;
  }
  if (!self) { initialize(root); write(root, 'README.md', 'Synthetic receiving owner.\n'); commit(root, 'receiver'); }
  const rules = { schema: 'port-contracts/feature-files', since: sourceCommit,
    feature_files: [{ matches: '^active/.+\\.mjs$', added: true, grown_lines_over: 0 }],
    contracts_match: '^ports/.+\\.json$', modes: ['SOURCE_FIRST_PORT'], retention_at_least: 0.6 };
  let baselineCommit = sourceCommit;
  if (!self) { write(root, BASELINE, SOURCE); baselineCommit = commit(root, 'raw source copy'); rules.since = baselineCommit; }
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-TYPED-SOURCE-REPOSITORY',
    status: 'VERIFIED', mode: 'SOURCE_FIRST_PORT', directive: { quote: 'port the original row functions', message_multihash: identity('port the original row functions') },
    sources: (ranges ? [[1, 3], [5, 7]] : [null]).map(lines => ({ repository: typed(basename(owner)), commit: sourceCommit,
      path: self ? ORIGINAL : undefined, ...(!self ? { path_multihash: identity(ORIGINAL) } : {}),
      ...(lines ? { lines } : {}), multihash: identity(lines ? SOURCE.split('\n').slice(lines[0] - 1, lines[1]).join('\n') + '\n' : SOURCE),
      ownership: 'repository-owned', old_copy: self ? 'same-file' : { deleted_by: '2026-01-03T00:00:00Z' } })),
    targets: [{ path: self ? ORIGINAL : TARGET }], preserve: ['the original row functions'],
    allowed_deltas: ['one adapter export'], banned_substitutions: ['private names in published metadata'],
    baseline: { commit: baselineCommit, ...(!self ? { path: BASELINE } : {}), recorded_at: '2026-01-01T00:00:00Z',
      copied_before_adaptation: true, source_multihash: null, target_multihash_at_baseline: identity(SOURCE) },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['preserveTypedRows2'], test_refs: ['test/synthetic.mjs'] },
  };
  contract.baseline.source_multihash = contract.sources[0].multihash;
  write(root, self ? ORIGINAL : TARGET, SOURCE + 'export const typedAdapter = true;\n');
  write(root, 'ports/source.json', contract); write(root, 'ports/feature-files.json', rules);
  commit(root, 'adapt preserved source');
  const options = { readers: gitReaders({ root, repositories, tree: 'HEAD' }), repository: basename(root), policySince: rules.since,
    activeTargetPaths: [self ? ORIGINAL : TARGET], stage: 'completion', now: '2026-01-04T00:00:00Z' };
  return { root, owner, sourceCommit, contract, options, repositories, rules };
}
function check(f) { return validateReferenceAdaptationContract(f.contract, f.options); }
function retire(f, published = true) {
  git(f.owner, 'rm', ORIGINAL); const revision = commit(f.owner, 'retire source');
  if (published) git(f.owner, 'update-ref', 'refs/remotes/origin/main', revision);
  return revision;
}
function pass(result) { assert.equal(result.valid, true, JSON.stringify(result)); assert.deepEqual(result.errors, []); assert.deepEqual(result.deferred, []); }

test('declared typed source reads genuine pinned bytes and published retirement', t => {
  const f = fixture(t); retire(f); pass(check(f));
  assert.equal(f.options.readers.repositoryCommit(f.contract.sources[0].repository, f.sourceCommit), f.sourceCommit);
  pass(validateReferenceAdaptationEvidence(f.contract, f.options));
});
test('typed self source preserves same-file policy/history proof', t => { const f = fixture(t, { self: true }); pass(check(f)); });
test('typed self retirement follows candidate while published original remains', t => {
  const f = fixture(t, { self: true });
  const source = { ...f.contract.sources[0], old_copy: { deleted_by: '2026-01-03T00:00:00Z' } };
  git(f.root, 'rm', ORIGINAL); const candidate = commit(f.root, 'candidate retirement');
  const readers = gitReaders({ root: f.root, tree: candidate });
  assert.equal(readers.retirementOf(source).state, 'absent');
  assert.equal(git(f.root, 'show', `refs/remotes/origin/main:${ORIGINAL}`), SOURCE.trim());
});
test('typed external source cannot use unpublished local retirement', t => {
  const f = fixture(t); retire(f, false); const result = check(f);
  assert.equal(result.valid, false); assert.match(result.errors.join('\n'), /old copy.*still lives/);
});
test('separate equal typed objects prove one full-artifact range origin', t => { const f = fixture(t, { ranges: true }); retire(f); pass(check(f)); });
test('string and typed forms preserve the same full-artifact range origin', t => {
  const f = fixture(t, { ranges: true }); retire(f); f.contract.sources[1].repository = basename(f.owner); pass(check(f));
});
test('identical bytes and commit in another repository cannot share the full artifact', t => {
  const f = fixture(t, { ranges: true, other: true }); retire(f);
  f.contract.sources[1].repository = typed('other-owner'); const result = check(f);
  assert.equal(result.valid, false); assert.match(result.errors.join('\n'), /baseline.*multihash|source's bytes/);
});
test('unknown typed scope defers without scanning an existing sibling checkout', t => {
  const f = fixture(t); retire(f); f.options.readers = gitReaders({ root: f.root, tree: 'HEAD' });
  assert.equal(f.options.readers.checkout(f.contract.sources[0].repository), null);
  for (const result of [check(f), validateReferenceAdaptationEvidence(f.contract, f.options)]) {
    assert.ok(result.deferred.some(one => /caller-declared/.test(one)));
    assert.ok(!JSON.stringify(result).includes(basename(f.owner))); assert.ok(!JSON.stringify(result).includes('[object Object]'));
  }
});
test('an explicitly declared name resolves through the existing sibling rule', t => {
  const f = fixture(t); retire(f);
  f.options.readers = gitReaders({ root: f.root, repositoryNames: [basename(f.owner)], tree: 'HEAD' }); pass(check(f));
  const result = judgeRepository({ root: f.root, span: { from: f.rules.since, to: 'HEAD' }, searchRepositories: [basename(f.owner)], now: f.options.now });
  assert.equal(result.valid, true, JSON.stringify(result)); assert.equal(result.judged.length, 1); assert.deepEqual(result.judged[0].deferred, []);
});
test('unresolved or ambiguous reader result cannot be supplied by readSource alone', t => {
  const f = fixture(t); let read = false;
  const result = validateReferenceAdaptationEvidence(f.contract, { ...f.options,
    readers: { repositoryName: () => null, readSource: () => { read = true; return Buffer.from(SOURCE); } } });
  assert.equal(read, false); assert.ok(result.deferred.length);
});
test('unresolved typed source still requires old-copy declarations, including unread ranges', t => {
  const f = fixture(t);
  f.options.readers = gitReaders({ root: f.root, tree: 'HEAD' });
  for (const lines of [undefined, [1, 3]]) {
    f.contract.sources[0].lines = lines; delete f.contract.sources[0].old_copy;
    const result = check(f);
    assert.equal(result.valid, false); assert.match(result.errors.join('\n'), /old_copy must be/);
    assert.ok(result.deferred.some(one => /caller-declared/.test(one)));
  }
});
test('typed pin failures use only hash labels and retain immutable commit/path checks', t => {
  const f = fixture(t); retire(f); f.contract.sources[0].commit = 'f'.repeat(40);
  const result = check(f); assert.equal(result.valid, false); assert.match(result.errors.join('\n'), /not in that commit/);
  assert.ok(result.errors.join('\n').includes(identity(basename(f.owner))));
  assert.ok(!JSON.stringify(result).includes(basename(f.owner))); assert.ok(!JSON.stringify(result).includes('[object Object]'));
});
test('source multihash drift and post-policy self source stay refused', t => {
  const f = fixture(t, { self: true }); f.contract.sources[0].multihash = identity('unrelated source');
  assert.match(check(f).errors.join('\n'), /source multihash drift/);
  f.contract.sources[0].multihash = identity(SOURCE); f.options.policySince = 'f'.repeat(40);
  assert.equal(check(f).valid, false);
});
test('typed locator is a closed own-key object, including programmatic inputs', t => {
  const f = fixture(t); const reference = f.contract.sources[0].repository;
  for (const malformed of [{ ...reference, repository: 'hidden label' }, {}, [],
    { repository_multihash: { toString: () => reference.repository_multihash } },
    { repository_multihash: '1f:bad' }, Object.assign(Object.create(reference), { other: true }),
    { ...reference, [Symbol('extra')]: true }]) {
    assert.equal(f.options.readers.repositoryName(malformed), null);
    f.contract.sources[0].repository = malformed;
    const result = validateReferenceAdaptationEvidence(f.contract, f.options);
    assert.equal(result.valid, false); assert.ok(result.errors.length);
    assert.ok(!JSON.stringify(result).includes('hidden label'));
  }
});
