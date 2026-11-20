// tools/check-a-port-against-its-source: the repository judge over made-up checkouts side by side. An older owner
// lives in one repository; a second repository adds feature files. A file with no contract, a rewrite, a second live
// copy past its date and a claim of no prior owner that the search contradicts are refused; a byte copy that was then
// adapted, and a claim whose every near file is named, pass.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { judgeRepository } from '../do-work/check-a-repository-for-port-contracts.mjs';
import { validateReferenceAdaptationContract } from '../do-work/validate-reference-adaptation-contract.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';

const JUDGE = resolve(import.meta.dirname, '..', 'do-work', 'check-a-repository-for-port-contracts.mjs');
const identity = (text) => makeHashCodeHexFromBytes(new TextEncoder().encode(text));
const OLD_SOURCE = Array.from({ length: 12 }, (_, i) => `export function keepTheRowsInOrder${i}(rows) { return rows.slice(${i}); }`).join('\n') + '\n';
const RULES = {
  schema: 'port-contracts/feature-files',
  why: 'made-up rules for the test',
  since: null,
  feature_files: [{ matches: '^tools/[^/]+/do-work/[^/]+\\.mjs$', ignore: '\\.test\\.mjs$', added: true, grown_lines_over: 5 }],
  contracts_match: '^tools/[^/]+/ports/[^/]+\\.json$',
  modes: ['SOURCE_FIRST_PORT', 'NO_PRIOR_OWNER'],
  retention_at_least: 0.6,
  old_copy_days_at_most: 3,
};

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
}

function commit(root, files, message = 'change') {
  write(root, files);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function checkouts(t) {
  const base = tempFolder(join(tmpdir(), 'port-contracts-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const old = join(base, 'old-owner');
  const tools = join(base, 'tools-repo');
  for (const root of [old, tools]) {
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
  }
  const oldCommit = commit(old, { 'src/order-rows.mjs': OLD_SOURCE, 'src/unrelated.mjs': 'export const nothing = 0;\n' });
  git(old, 'update-ref', 'refs/remotes/origin/main', oldCommit);
  const since = commit(tools, { 'ports/feature-files.json': { ...RULES, since: 'placeholder' }, 'README.md': 'made-up\n' });
  write(tools, { 'ports/feature-files.json': { ...RULES, since } });
  return { base, old, tools, oldCommit, since };
}

function portContract({ oldCommit, status = 'ADAPTED', baselineCommit, deletedBy = '2026-01-03T00:00:00Z' }) {
  const digest = identity(OLD_SOURCE);
  return {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-ORDER-ROWS', status,
    directive: { message_multihash: identity('move the row ordering'), quote: 'port the row ordering to the tools repository' },
    mode: 'SOURCE_FIRST_PORT',
    sources: [{ repository: 'old-owner', commit: oldCommit, path: 'src/order-rows.mjs', multihash: digest, ownership: 'repository-owned', old_copy: { deleted_by: deletedBy } }],
    targets: [{ path: 'tools/order-rows/do-work/order-rows.mjs' }],
    preserve: ['the ordering functions'], allowed_deltas: ['one added export'], banned_substitutions: ['a rewritten ordering'],
    baseline: { copied_before_adaptation: true, source_multihash: digest, target_multihash_at_baseline: digest, commit: baselineCommit, recorded_at: '2026-01-01T00:00:00Z' },
    proof: { minimum_meaningful_line_retention: 0.8, required_mechanisms: ['keepTheRowsInOrder3'], test_refs: ['tools/order-rows/test/order-rows.test.mjs'] },
  };
}

const NOW_BEFORE_DUE = '2026-01-02T00:00:00Z';
const range = (since) => ({ from: since, to: 'HEAD' });

test('a feature file added with no contract is refused, and a test file needs none', (t) => {
  const { tools, since } = checkouts(t);
  commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': 'export const x = 1;\n', 'tools/order-rows/do-work/order-rows.test.mjs': 'x\n' });
  const result = judgeRepository({ root: tools, span: range(since) });
  assert.equal(result.valid, false);
  assert.deepEqual(result.judged.map((one) => one.path), ['tools/order-rows/do-work/order-rows.mjs']);
  assert.match(result.judged[0].errors[0], /no contract/);
});

test('a byte copy committed first, then adapted, passes while the old copy has days left', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const copy = commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': OLD_SOURCE });
  commit(tools, {
    'tools/order-rows/do-work/order-rows.mjs': `${OLD_SOURCE}export const rowsKeptInOrderBy = (rows, field) => rows.toSorted((a, b) => a[field] - b[field]);\n`,
    'tools/order-rows/ports/order-rows.json': portContract({ oldCommit, baselineCommit: copy }),
  });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
});

test('the copy commit itself passes with no baseline commit yet', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  write(tools, {
    'tools/order-rows/do-work/order-rows.mjs': OLD_SOURCE,
    'tools/order-rows/ports/order-rows.json': portContract({ oldCommit, status: 'BASELINED' }),
  });
  git(tools, 'add', '-A');
  const result = judgeRepository({ root: tools, span: { staged: true }, rules: { ...RULES, since }, now: NOW_BEFORE_DUE });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
});

test('the exact first copy can be committed into a genuinely unborn repository', (t) => {
  const { base, oldCommit } = checkouts(t);
  const tools = join(base, 'fresh-tools');
  mkdirSync(tools);
  git(tools, 'init', '-q', '-b', 'main');
  const contract = portContract({ oldCommit, status: 'BASELINED' });
  write(tools, { [contract.targets[0].path]: OLD_SOURCE, 'tools/order-rows/ports/order-rows.json': contract });
  git(tools, 'add', '-A');
  const result = judgeRepository({ root: tools, span: { staged: true }, rules: { ...RULES, since: null }, now: NOW_BEFORE_DUE });
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('an uncommitted raw copy cannot qualify a grouped preexisting adapted target', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit, status: 'BASELINED' });
  const adapted = contract.targets[0].path;
  commit(tools, { [adapted]: `${OLD_SOURCE.trimEnd().split('\n').slice(0, 10).join('\n')}\n` });
  contract.targets.unshift({ path: 'tools/order-rows/do-work/raw-copy.mjs' });
  write(tools, { [contract.targets[0].path]: OLD_SOURCE, 'tools/order-rows/ports/order-rows.json': contract });
  git(tools, 'add', '-A');
  const result = judgeRepository({ root: tools, span: { staged: true }, rules: { ...RULES, since }, now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.judged[0].errors.join('\n'), /must precede active adaptation/);
});

test('a renamed byte-copy baseline proves active targets without claiming the historical path', (t) => {
  const { tools, old, since, oldCommit } = checkouts(t);
  const baselinePath = 'proofs/order-rows-original.mjs';
  const copy = commit(tools, { [baselinePath]: OLD_SOURCE });
  git(tools, 'rm', baselinePath);
  const contract = portContract({ oldCommit, baselineCommit: copy });
  contract.baseline.path = baselinePath;
  commit(tools, {
    [contract.targets[0].path]: `${OLD_SOURCE}export const adaptedRows = true;\n`,
    'tools/order-rows/ports/order-rows.json': contract,
  });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  git(old, 'rm', 'src/order-rows.mjs');
  commit(old, {}, 'retire moved owner');
  git(old, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const command = spawnSync(process.execPath, [JUDGE, '--root', tools, '--range', `${since}..HEAD`], { encoding: 'utf8' });
  assert.equal(command.status, 0, command.stdout);
  assert.equal(JSON.parse(command.stdout).valid, true);
});

test('Git rename records preserve a real baseline while tracing earlier adaptation', (t) => {
  for (const adaptedBefore of [false, true]) {
    const { tools, since, oldCommit } = checkouts(t);
    const contract = portContract({ oldCommit });
    const current = contract.targets[0].path;
    const original = 'tools/order-rows/do-work/original-name.mjs';
    if (adaptedBefore) commit(tools, { [original]: `${OLD_SOURCE.trimEnd().split('\n').slice(0, 10).join('\n')}\n` });
    const copy = commit(tools, { [original]: OLD_SOURCE });
    contract.baseline.commit = copy;
    git(tools, 'mv', original, current);
    commit(tools, { [current]: `${OLD_SOURCE}export const adaptedRowsAfterRename = true;\n`, 'tools/order-rows/ports/order-rows.json': contract });
    const readers = gitReaders({ root: tools, tree: 'HEAD' });
    assert.equal(readers.targetAtCommit(copy, current)?.toString(), OLD_SOURCE);
    assert.equal(readers.targetAtCommit(copy, current, { followRenames: false }), null, 'an explicit baseline path still requires that exact path');
    assert.equal(gitReaders({ root: tools, tree: copy }).targetAtCommit(copy, current), null, 'future rename records do not apply to an earlier judged tree');
    const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
    assert.equal(result.valid, !adaptedBefore, JSON.stringify({ adaptedBefore, result }));
    if (adaptedBefore) assert.match(result.judged[0].errors.join('\n'), /must precede active adaptation/);
  }
});

test('an unrelated new path cannot borrow a baseline from a similar file without a Git rename record', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  contract.baseline.commit = commit(tools, { 'tools/order-rows/do-work/original-name.mjs': OLD_SOURCE });
  commit(tools, { [contract.targets[0].path]: `${OLD_SOURCE}export const independentlyAddedRows = true;\n`, 'tools/order-rows/ports/order-rows.json': contract });
  assert.equal(gitReaders({ root: tools, tree: 'HEAD' }).targetAtCommit(contract.baseline.commit, contract.targets[0].path), null);
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false);
  assert.match(result.judged.find((one) => one.path === contract.targets[0].path).errors.join('\n'), /does not hold/);
});

test('a separate retained baseline artifact cannot inflate active targets retention', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const baselinePath = 'proofs/order-rows-original.mjs';
  const copy = commit(tools, { [baselinePath]: OLD_SOURCE });
  const contract = portContract({ oldCommit, baselineCommit: copy });
  contract.baseline.path = baselinePath;
  commit(tools, {
    [contract.targets[0].path]: 'export function rewrittenRowsInReverse(rows) { return [...rows].reverse(); }\n',
    'tools/order-rows/ports/order-rows.json': contract,
  });
  let result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false);
  assert.match(result.judged[0].errors.join('\n'), /meaningful line retention/);
  contract.targets.unshift({ path: baselinePath });
  commit(tools, { 'tools/order-rows/ports/order-rows.json': contract });
  result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false, 'claiming an archival baseline as an active target must fail');
  assert.match(result.judged[0].errors.join('\n'), /baseline.path.*targets/);
  const measured = validateReferenceAdaptationContract(contract, { stage: 'pre-edit', readers: gitReaders({ root: tools, tree: 'HEAD' }), repository: 'tools-repo', now: NOW_BEFORE_DUE });
  assert.equal(measured.measurements.meaningfulLineRetention, 0);
  assert.match(measured.errors.join('\n'), /required mechanism missing: keepTheRowsInOrder3/);
  for (const alias of ['./proofs/order-rows-original.mjs', 'proofs//order-rows-original.mjs', 'proofs/../proofs/order-rows-original.mjs']) {
    contract.targets[0].path = alias;
    commit(tools, { 'tools/order-rows/ports/order-rows.json': contract });
    for (const tree of ['HEAD', ':']) {
      const aliased = validateReferenceAdaptationContract(contract, { stage: 'pre-edit', readers: gitReaders({ root: tools, tree }), repository: 'tools-repo', now: NOW_BEFORE_DUE });
      assert.equal(aliased.valid, false, JSON.stringify({ alias, tree, aliased }));
      assert.match(aliased.errors.join('\n'), /targets.*repository-relative/);
      assert.equal(aliased.measurements.meaningfulLineRetention, 0);
    }
  }
  symlinkSync('order-rows-original.mjs', join(tools, 'proofs/alias.mjs'));
  symlinkSync('proofs', join(tools, 'proofs-alias'));
  for (const alias of ['proofs/alias.mjs', 'proofs-alias/order-rows-original.mjs']) {
    contract.targets[0].path = alias;
    const aliased = validateReferenceAdaptationContract(contract, { stage: 'pre-edit', readers: gitReaders({ root: tools }), repository: 'tools-repo', now: NOW_BEFORE_DUE });
    assert.equal(aliased.valid, false, JSON.stringify({ alias, aliased }));
    assert.equal(aliased.measurements.meaningfulLineRetention, 0);
  }
});

test('an explicit baseline path must exist with exact source bytes at its real commit', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const baselinePath = 'proofs/order-rows-original.mjs';
  const copy = commit(tools, { [baselinePath]: OLD_SOURCE, 'proofs/wrong.mjs': 'export const differentSourceBytes = true;\n' });
  const contract = portContract({ oldCommit, baselineCommit: copy });
  for (const [path, baselineCommit, expected] of [
    ['proofs/missing.mjs', copy, /does not hold proofs\/missing/],
    ['proofs/wrong.mjs', copy, /is not the source's bytes/],
    [baselinePath, 'f'.repeat(40), /does not hold proofs\/order-rows/],
    [baselinePath, git(tools, 'rev-parse', `${copy}^{tree}`), /does not hold proofs\/order-rows/],
    [baselinePath, undefined, /baseline.commit/],
    ['../proofs/escape.mjs', copy, /baseline.path.*relative path/],
    ['/proofs/absolute.mjs', copy, /baseline.path.*relative path/],
    ['proofs/../order-rows.mjs', copy, /baseline.path.*relative path/],
    ['proofs\\order-rows.mjs', copy, /baseline.path.*relative path/],
    ['', copy, /baseline.path.*relative path/],
  ]) {
    contract.baseline.path = path;
    contract.baseline.commit = baselineCommit;
    commit(tools, { [contract.targets[0].path]: OLD_SOURCE, 'tools/order-rows/ports/order-rows.json': contract });
    const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
    assert.equal(result.valid, false, JSON.stringify({ path, result }));
    assert.match(result.judged[0].errors.join('\n'), expected);
  }
});

test('a source commit must be a real commit rather than a tree with matching bytes', (t) => {
  const { tools, old, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  contract.sources[0].commit = git(old, 'rev-parse', `${oldCommit}^{tree}`);
  contract.baseline.commit = commit(tools, { [contract.targets[0].path]: OLD_SOURCE });
  commit(tools, { 'tools/order-rows/ports/order-rows.json': contract });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.judged[0].errors.join('\n'), /source .* is not in that commit/);
});

test('source code must be a regular Git file rather than source-looking symlink text', (t) => {
  const { tools, old, since } = checkouts(t);
  git(old, 'rm', 'src/order-rows.mjs');
  symlinkSync(OLD_SOURCE, join(old, 'src/order-rows.mjs'));
  const sourceCommit = commit(old, {});
  git(old, 'update-ref', 'refs/remotes/origin/main', sourceCommit);
  const contract = portContract({ oldCommit: sourceCommit });
  contract.baseline.commit = commit(tools, { [contract.targets[0].path]: OLD_SOURCE });
  commit(tools, { 'tools/order-rows/ports/order-rows.json': contract });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.judged[0].errors.join('\n'), /source .* is not in that commit/);
});

test('a separate baseline retains grouped sources across active targets only', (t) => {
  const { tools, old, since, oldCommit } = checkouts(t);
  const extra = 'export const keepSupplementaryRowsInOrder = (rows) => rows.slice();\n';
  const extraCommit = commit(old, { 'src/supplement.mjs': extra });
  git(old, 'update-ref', 'refs/remotes/origin/main', extraCommit);
  const baselinePath = 'proofs/order-rows-original.mjs';
  const copy = commit(tools, { [baselinePath]: OLD_SOURCE });
  const contract = portContract({ oldCommit, baselineCommit: copy });
  contract.baseline.path = baselinePath;
  contract.sources.push({ ...contract.sources[0], commit: extraCommit, path: 'src/supplement.mjs', multihash: identity(extra) });
  contract.targets.push({ path: 'tools/order-rows/do-work/remaining-rows.mjs' });
  const lines = OLD_SOURCE.trimEnd().split('\n');
  commit(tools, {
    [contract.targets[0].path]: `${lines.slice(0, 6).join('\n')}\n`,
    [contract.targets[1].path]: `${lines.slice(6).join('\n')}\n${extra}`,
    'tools/order-rows/ports/order-rows.json': contract,
  });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  const measured = validateReferenceAdaptationContract(contract, { stage: 'pre-edit', readers: gitReaders({ root: tools, tree: 'HEAD' }), repository: 'tools-repo', now: NOW_BEFORE_DUE });
  assert.equal(measured.measurements.meaningfulLineRetention, 1);
  const legacyCopy = commit(tools, { [contract.targets[0].path]: OLD_SOURCE });
  delete contract.baseline.path;
  contract.baseline.commit = legacyCopy;
  commit(tools, {
    [contract.targets[0].path]: `${lines.slice(0, 6).join('\n')}\n`,
    'tools/order-rows/ports/order-rows.json': contract,
  });
  const legacy = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(legacy.valid, false, 'omitting baseline.path cannot qualify a later raw revert as source-first');
  assert.match(legacy.judged[0].errors.join('\n'), /must precede active adaptation/);
});

test('legacy archive-first targets fail and only active feature DATA supplies retention', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  const active = contract.targets[0].path;
  const archive = 'proofs/order-rows-original.held';
  const rewritten = `${OLD_SOURCE.trimEnd().split('\n').slice(0, 10).join('\n')}\nexport const adaptedRows = true;\n`;
  commit(tools, { [active]: rewritten });
  contract.baseline.commit = commit(tools, { [archive]: OLD_SOURCE });
  contract.targets.unshift({ path: archive });
  commit(tools, { 'tools/order-rows/ports/order-rows.json': contract });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.judged[0].errors.join('\n'), /separate artifact belongs in baseline.path/);
  assert.match(result.judged[0].errors.join('\n'), /must precede active adaptation/);
  const options = { stage: 'pre-edit', readers: gitReaders({ root: tools, tree: 'HEAD' }), repository: 'tools-repo', now: NOW_BEFORE_DUE };
  const ambiguous = validateReferenceAdaptationContract(contract, options);
  assert.equal(ambiguous.valid, false);
  assert.equal(ambiguous.measurements, null);
  assert.match(ambiguous.errors.join('\n'), /baseline.path or activeTargetPaths/);
  const scoped = validateReferenceAdaptationContract(contract, { ...options, activeTargetPaths: [active] });
  assert.equal(scoped.valid, false);
  assert.equal(scoped.measurements.meaningfulLineRetention, 10 / 12);
});

test('grouped active ports include unchanged helpers from all feature DATA paths', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  const active = contract.targets[0].path;
  const helper = 'tools/order-rows/do-work/remaining-rows.mjs';
  const lines = OLD_SOURCE.trimEnd().split('\n');
  contract.baseline.commit = commit(tools, { [active]: OLD_SOURCE });
  contract.targets.push({ path: helper });
  const helperCommit = commit(tools, { [helper]: `${lines.slice(6).join('\n')}\n` });
  commit(tools, { [active]: `${lines.slice(0, 6).join('\n')}\nexport const additionalOrderingAdapter = true;\n`, 'tools/order-rows/ports/order-rows.json': contract });
  const rules = { ...RULES, since, feature_files: [{ ...RULES.feature_files[0], grown_lines_over: 0 }] };
  const result = judgeRepository({ root: tools, span: { from: helperCommit, to: 'HEAD' }, rules, now: NOW_BEFORE_DUE });
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.deepEqual(result.judged.map((one) => one.path), [active]);
  const measured = validateReferenceAdaptationContract(contract, { stage: 'pre-edit', readers: gitReaders({ root: tools, tree: 'HEAD' }), repository: 'tools-repo', activeTargetPaths: [active, helper], now: NOW_BEFORE_DUE });
  assert.equal(measured.valid, true, JSON.stringify(measured));
  assert.equal(measured.measurements.meaningfulLineRetention, 1);
});

test('a genuine same-file source snapshot preserves its earlier development history', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  const active = contract.targets[0].path;
  commit(tools, { [active]: 'export const earlierImplementationBeforeTheSourceSnapshot = true;\n' });
  const sourceSnapshot = commit(tools, { [active]: OLD_SOURCE });
  contract.sources = [{ ...contract.sources[0], repository: 'tools-repo', commit: sourceSnapshot, path: active, old_copy: 'same-file' }];
  contract.baseline.commit = sourceSnapshot;
  commit(tools, { [active]: `${OLD_SOURCE}export const currentAdaptationKeepsTheSource = true;\n`, 'tools/order-rows/ports/order-rows.json': contract });
  const rules = { ...RULES, since: sourceSnapshot, feature_files: [{ ...RULES.feature_files[0], grown_lines_over: 0 }] };
  const result = judgeRepository({ root: tools, span: { from: sourceSnapshot, to: 'HEAD' }, rules, now: NOW_BEFORE_DUE });
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.judged.length, 1);
});

test('supplementary or post-policy self-sources cannot launder already-adapted imports', (t) => {
  for (const mixed of [true, false]) {
    const { tools, since, oldCommit } = checkouts(t);
    const contract = portContract({ oldCommit });
    const active = contract.targets[0].path;
    const adapted = `${OLD_SOURCE.trimEnd().split('\n').slice(0, 10).join('\n')}\n`;
    commit(tools, { [active]: adapted });
    contract.baseline.path = 'proofs/order-rows-original.held';
    const copy = commit(tools, { [contract.baseline.path]: mixed ? OLD_SOURCE : adapted });
    contract.baseline.commit = copy;
    const self = { repository: 'tools-repo', commit: copy, path: active, multihash: identity(adapted), ownership: 'repository-owned', old_copy: 'same-file' };
    if (mixed) contract.sources.push(self);
    else {
      contract.sources = [self];
      contract.baseline.source_multihash = self.multihash;
      contract.baseline.target_multihash_at_baseline = self.multihash;
    }
    commit(tools, { 'tools/order-rows/ports/order-rows.json': contract });
    const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
    assert.equal(result.valid, false, JSON.stringify({ mixed, result }));
    assert.match(result.judged[0].errors.join('\n'), /same-file provenance requires the complete original source\/target set/);
  }
});

test('rename lineage checks both current and older names before and after the baseline', (t) => {
  for (const scenario of ['deleted-current', 'adapted-old-name', 'raw-old-name']) {
    const { tools, since, oldCommit } = checkouts(t);
    const contract = portContract({ oldCommit });
    const active = contract.targets[0].path;
    const earlier = 'tools/order-rows/do-work/earlier-name.mjs';
    const adapted = `${OLD_SOURCE.trimEnd().split('\n').slice(0, 10).join('\n')}\n`;
    contract.baseline.path = 'proofs/order-rows-original.held';
    if (scenario === 'deleted-current') {
      commit(tools, { [active]: adapted });
      git(tools, 'rm', active);
      contract.baseline.commit = commit(tools, { [contract.baseline.path]: OLD_SOURCE });
      mkdirSync(dirname(join(tools, active)), { recursive: true });
      git(tools, 'mv', contract.baseline.path, active);
    } else {
      commit(tools, { [earlier]: scenario === 'raw-old-name' ? OLD_SOURCE : adapted });
      git(tools, 'mv', earlier, active);
      contract.baseline.commit = commit(tools, { [active]: OLD_SOURCE, [contract.baseline.path]: OLD_SOURCE });
    }
    commit(tools, { [active]: `${OLD_SOURCE}export const adaptedRowsAfterRename = true;\n`, 'tools/order-rows/ports/order-rows.json': contract });
    const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
    assert.equal(result.valid, scenario === 'raw-old-name', JSON.stringify({ scenario, result }));
    if (scenario !== 'raw-old-name') assert.match(result.judged[0].errors.join('\n'), /must precede active adaptation/);
  }
});

test('a separate baseline still verifies literal redactions and the original source identity', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const baselinePath = 'proofs/order-rows-original.mjs';
  const copied = OLD_SOURCE.replaceAll('keepTheRowsInOrder', 'orderTheRows');
  const copy = commit(tools, { [baselinePath]: copied });
  const contract = portContract({ oldCommit, baselineCommit: copy });
  contract.baseline.path = baselinePath;
  contract.baseline.redactions = [{ from: 'keepTheRowsInOrder', to: 'orderTheRows' }];
  contract.baseline.target_multihash_at_baseline = identity(copied);
  contract.proof.required_mechanisms = ['orderTheRows3'];
  commit(tools, { [contract.targets[0].path]: copied, 'tools/order-rows/ports/order-rows.json': contract });
  assert.equal(judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE }).valid, true);
  contract.baseline.redactions[0].to = 'anotherName';
  contract.sources[0].multihash = identity('invented source');
  commit(tools, { 'tools/order-rows/ports/order-rows.json': contract });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false);
  assert.match(result.judged[0].errors.join('\n'), /source multihash drift/);
  assert.match(result.judged[0].errors.join('\n'), /exactly baseline\.redactions applied/);
});

test('a separate baseline cannot retroactively qualify an adapted, deleted or reverted active target', (t) => {
  const rewritten = `${OLD_SOURCE.trimEnd().split('\n').slice(0, 10).join('\n')}\nexport const adaptedRows = true;\n`;
  for (const state of ['adapted', 'deleted', 'reverted']) {
    const { tools, since, oldCommit } = checkouts(t);
    const contract = portContract({ oldCommit });
    const active = contract.targets[0].path;
    commit(tools, { [active]: rewritten });
    if (state === 'deleted') git(tools, 'rm', active);
    contract.baseline.path = 'proofs/order-rows-original.mjs';
    contract.baseline.commit = commit(tools, { [contract.baseline.path]: OLD_SOURCE, ...(state === 'reverted' ? { [active]: OLD_SOURCE } : {}) });
    commit(tools, { [active]: rewritten, 'tools/order-rows/ports/order-rows.json': contract });
    const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
    assert.equal(result.valid, false, JSON.stringify({ state, result }));
    assert.match(result.judged[0].errors.join('\n'), /baseline must precede active adaptation/);
  }
});

test('every active target must follow the copy, even if another target held an exact copy at baseline', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  const active = contract.targets[0].path;
  const rewritten = `${OLD_SOURCE.trimEnd().split('\n').slice(0, 10).join('\n')}\nexport const adaptedRows = true;\n`;
  commit(tools, { [active]: rewritten });
  contract.baseline.path = 'proofs/order-rows-original.mjs';
  contract.targets.push({ path: 'tools/order-rows/do-work/helper.mjs' });
  contract.baseline.commit = commit(tools, { [contract.baseline.path]: OLD_SOURCE, [contract.targets[1].path]: OLD_SOURCE });
  commit(tools, { 'tools/order-rows/ports/order-rows.json': contract });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false);
  assert.match(result.judged[0].errors.join('\n'), /baseline must precede active adaptation/);
});

test('a source copy at an active path followed by adaptation and new helpers is valid', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  const active = contract.targets[0].path;
  contract.baseline.path = 'proofs/order-rows-original.mjs';
  contract.baseline.commit = commit(tools, { [contract.baseline.path]: OLD_SOURCE, [active]: OLD_SOURCE });
  contract.targets.push({ path: 'tools/order-rows/do-work/helper.mjs' });
  commit(tools, { [active]: `${OLD_SOURCE}export const adaptedRows = true;\n`, [contract.targets[1].path]: 'export const keepAdditionalRows = (rows) => rows.slice();\n', 'tools/order-rows/ports/order-rows.json': contract });
  assert.equal(judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE }).valid, true);
  const future = validateReferenceAdaptationContract(contract, { stage: 'pre-edit', readers: gitReaders({ root: tools, tree: since }), repository: 'tools-repo', now: NOW_BEFORE_DUE });
  assert.equal(future.valid, false);
  assert.match(future.errors.join('\n'), /baseline.commit must be an ancestor/);
  git(tools, 'rm', active);
  symlinkSync(OLD_SOURCE, join(tools, active));
  commit(tools, {});
  for (const tree of ['HEAD', ':']) {
    const symlinked = validateReferenceAdaptationContract(contract, { stage: 'pre-edit', readers: gitReaders({ root: tools, tree }), repository: 'tools-repo', now: NOW_BEFORE_DUE });
    assert.equal(symlinked.valid, false, JSON.stringify({ tree, symlinked }));
    assert.match(symlinked.errors.join('\n'), /target missing/);
  }
});

test('an active target introduced on a sibling branch before the copy cannot qualify after a merge', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  const active = contract.targets[0].path;
  const rewritten = `${OLD_SOURCE.trimEnd().split('\n').slice(0, 10).join('\n')}\nexport const adaptedRows = true;\n`;
  const sibling = commit(tools, { [active]: rewritten });
  git(tools, 'rm', active);
  contract.baseline.path = 'proofs/order-rows-original.mjs';
  write(tools, { [contract.baseline.path]: OLD_SOURCE });
  git(tools, 'add', '-A');
  const copyTree = git(tools, 'write-tree');
  contract.baseline.commit = git(tools, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit-tree', copyTree, '-p', since, '-m', 'copy on sibling branch');
  write(tools, { [active]: rewritten, 'tools/order-rows/ports/order-rows.json': contract });
  git(tools, 'add', '-A');
  const merged = git(tools, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit-tree', git(tools, 'write-tree'), '-p', contract.baseline.commit, '-p', sibling, '-m', 'merge independent work');
  git(tools, 'update-ref', 'refs/heads/main', merged);
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.judged[0].errors.join('\n'), /baseline must precede active adaptation/);
});

test('a Git symlink blob is never a source-copy baseline even when its link text has the source identity', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  contract.baseline.path = 'proofs/order-rows-original.mjs';
  mkdirSync(join(tools, 'proofs'));
  symlinkSync(OLD_SOURCE, join(tools, contract.baseline.path));
  contract.baseline.commit = commit(tools, {});
  commit(tools, { [contract.targets[0].path]: OLD_SOURCE, 'tools/order-rows/ports/order-rows.json': contract });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false);
  assert.match(result.judged[0].errors.join('\n'), /does not hold proofs\/order-rows/);
});

test('a shallow checkout cannot certify missing pre-baseline adaptation history', (t) => {
  const { tools, old, base, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  const active = contract.targets[0].path;
  const rewritten = `${OLD_SOURCE.trimEnd().split('\n').slice(0, 10).join('\n')}\nexport const adaptedRows = true;\n`;
  commit(tools, { [active]: rewritten });
  contract.baseline.path = 'proofs/order-rows-original.mjs';
  contract.baseline.commit = commit(tools, { [contract.baseline.path]: OLD_SOURCE, [active]: OLD_SOURCE });
  commit(tools, { [active]: rewritten, 'tools/order-rows/ports/order-rows.json': contract });
  const shallow = join(base, 'shallow');
  execFileSync('git', ['clone', '--quiet', '--depth', '2', pathToFileURL(tools).href, shallow]);
  const result = validateReferenceAdaptationContract(contract, { stage: 'pre-edit', readers: gitReaders({ root: shallow, tree: 'HEAD', repositories: { 'old-owner': old } }), repository: 'shallow', now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.errors.join('\n'), /requires repository history proof/);
});

test('Git replacement commits cannot hide adaptation before the immutable baseline', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = portContract({ oldCommit });
  const active = contract.targets[0].path;
  const rewritten = `${OLD_SOURCE.trimEnd().split('\n').slice(0, 10).join('\n')}\nexport const adaptedRows = true;\n`;
  commit(tools, { [active]: rewritten });
  contract.baseline.path = 'proofs/order-rows-original.mjs';
  contract.baseline.commit = commit(tools, { [contract.baseline.path]: OLD_SOURCE, [active]: OLD_SOURCE });
  commit(tools, { [active]: rewritten, 'tools/order-rows/ports/order-rows.json': contract });
  git(tools, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'replace', '--graft', contract.baseline.commit, since);
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.judged[0].errors.join('\n'), /baseline must precede active adaptation/);
  git(tools, 'replace', '-d', contract.baseline.commit);
  write(tools, { '.git/info/grafts': `${contract.baseline.commit} ${since}\n` });
  const grafted = validateReferenceAdaptationContract(contract, { stage: 'pre-edit', readers: gitReaders({ root: tools, tree: 'HEAD' }), repository: 'tools-repo', now: NOW_BEFORE_DUE });
  assert.equal(grafted.valid, false, JSON.stringify(grafted));
  assert.match(grafted.errors.join('\n'), /requires repository history proof/);
});

test('a replacement tree cannot hide changed feature files from the judge or its command', (t) => {
  const { tools, since } = checkouts(t);
  const head = commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': 'export const rewrittenRowsWithoutAPort = true;\n' });
  const replacement = git(tools, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit-tree', git(tools, 'rev-parse', `${since}^{tree}`), '-p', since, '-m', 'hide changed feature');
  git(tools, 'replace', head, replacement);
  const result = judgeRepository({ root: tools, span: range(since) });
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.equal(result.judged.length, 1);
  assert.match(result.judged[0].errors.join('\n'), /no contract/);
  const command = spawnSync(process.execPath, [JUDGE, '--root', tools, '--range', `${since}..HEAD`], { encoding: 'utf8' });
  assert.equal(command.status, 1, command.stdout);
  assert.equal(JSON.parse(command.stdout).judged.length, 1);
});

test('a rewrite is refused: its first commit is not the byte copy, and it keeps too few of the source lines', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const rewritten = 'export function orderTheRows(rows, by) {\n  return [...rows].sort((left, right) => left[by] - right[by]);\n}\n';
  const first = commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': rewritten });
  commit(tools, { 'tools/order-rows/ports/order-rows.json': portContract({ oldCommit, baselineCommit: first }) });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, false);
  const errors = result.judged[0].errors.join('\n');
  assert.match(errors, /is not the source's bytes/);
  assert.match(errors, /meaningful line retention/);
});

test('one copy: the old copy alive after its date, or alive under a VERIFIED contract, is refused', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const copy = commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': OLD_SOURCE });
  commit(tools, { 'tools/order-rows/ports/order-rows.json': portContract({ oldCommit, baselineCommit: copy }) });
  const late = judgeRepository({ root: tools, span: range(since), now: '2026-02-01T00:00:00Z' });
  assert.match(late.judged[0].errors.join('\n'), /still lives after its deleted_by/);
  commit(tools, { 'tools/order-rows/ports/order-rows.json': portContract({ oldCommit, baselineCommit: copy, status: 'VERIFIED' }) });
  const verified = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.match(verified.judged[0].errors.join('\n'), /one copy is part of done/);
  commit(tools, { 'tools/order-rows/ports/order-rows.json': portContract({ oldCommit, baselineCommit: copy, deletedBy: '2026-03-01T00:00:00Z' }) });
  const far = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.match(far.judged[0].errors.join('\n'), /more than 3 days after baseline/);
});

test('when the old copy has left its repository, the VERIFIED port passes', (t) => {
  const { tools, old, since, oldCommit } = checkouts(t);
  const copy = commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': OLD_SOURCE });
  commit(tools, { 'tools/order-rows/ports/order-rows.json': portContract({ oldCommit, baselineCommit: copy, status: 'VERIFIED' }) });
  git(old, 'rm', '-q', 'src/order-rows.mjs');
  git(old, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'moved');
  git(old, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const result = judgeRepository({ root: tools, span: range(since), now: '2026-02-01T00:00:00Z' });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
});

function noPriorOwner(extra = {}, captures = {}) {
  return {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-NEW-JOB', status: 'ADAPTED',
    directive: { message_multihash: identity('make a thing nobody made'), quote: 'build the row ordering tool' },
    mode: 'NO_PRIOR_OWNER',
    job: 'keep rows in order by a field',
    sources: [], targets: [{ path: 'tools/order-rows/do-work/order-rows.mjs' }],
    preserve: [], allowed_deltas: [], banned_substitutions: [], baseline: {},
    proof: {
      search: {
        phrasings: ['keep rows in order by a field', 'sort rows'],
        capability_rows: [],
        code_patterns: ['keepTheRows'],
        repositories: Object.entries(captures).map(([repository, commit]) => ({ repository, commit })),
      },
      test_refs: [],
    },
    ...extra,
  };
}

test('a claim of no prior owner is refused when the search, run again, finds the old code or a near row', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const captures = { 'old-owner': oldCommit, 'tools-repo': since };
  commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': 'export const sortRows = (rows) => rows;\n', 'tools/order-rows/ports/new.json': noPriorOwner({}, captures) });
  const searchRepositories = ['old-owner', 'tools-repo'];
  const found = judgeRepository({ root: tools, span: range(since), searchRepositories });
  assert.match(found.judged[0].errors.join('\n'), /finds old-owner:src\/order-rows\.mjs/);

  commit(tools, { 'tools/order-rows/ports/new.json': noPriorOwner({ distinct_from: [{ repository: 'old-owner', path: 'src/order-rows.mjs', why: 'a made-up difference for the test' }] }, captures) });
  assert.equal(judgeRepository({ root: tools, span: range(since), searchRepositories }).valid, true);

  const rowSearch = [process.execPath, '-e', 'process.stdout.write(JSON.stringify([{capability:"put rows in order",repository:"old-owner",owner:["src/order-rows.mjs"],where:"old-owner",words:0.7,near:true}]))'];
  const near = judgeRepository({ root: tools, span: range(since), searchRepositories, capabilitySearchArgv: rowSearch });
  assert.match(near.judged[0].errors.join('\n'), /finds "put rows in order"/);
});

test('a claim of no prior owner must record a search of every required repository, with patterns from its own words', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const contract = noPriorOwner();
  contract.proof.search.code_patterns = ['zzqx'];
  contract.proof.search.repositories = [{ repository: 'old-owner', commit: oldCommit }];
  commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': 'export const sortRows = (rows) => rows;\n', 'tools/order-rows/ports/new.json': contract });
  const errors = judgeRepository({ root: tools, span: range(since), searchRepositories: ['old-owner', 'third-repo'] }).judged[0].errors.join('\n');
  assert.match(errors, /shares no word with the job phrasings/);
  assert.match(errors, /does not record a search of third-repo/);
});

test('typed private repository identities preserve exact search scope and historical commits', (t) => {
  const { base, old, tools, oldCommit, since } = checkouts(t);
  const names = ['old-owner', 'tools-repo', 'alpha', 'beta', 'gamma', 'delta'];
  const repositories = { 'old-owner': old, 'tools-repo': tools };
  const commits = { 'old-owner': oldCommit, 'tools-repo': since };
  for (const name of names.slice(2)) {
    const root = join(base, name);
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    commits[name] = commit(root, { 'README.md': `${name} synthetic source\n` });
    repositories[name] = root;
  }
  commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': 'export const sortRows = (rows) => rows;\n' });
  const contract = noPriorOwner({ distinct_from: [{ repository: 'old-owner', path: 'src/order-rows.mjs', why: 'a synthetic distinct job for this check' }] });
  contract.proof.search.repositories = names.map((name) => ({ repository_multihash: identity(name), commit: commits[name] }));
  const options = {
    repository: 'tools-repo', stage: 'pre-edit', searchRepositories: names,
    readers: gitReaders({ root: tools, repositories, tree: 'HEAD' }), searchCapabilities: () => [],
  };
  const judge = (candidate, extra = {}) => validateReferenceAdaptationContract(candidate, { ...options, ...extra });
  const valid = judge(contract);
  assert.equal(valid.valid, true, JSON.stringify(valid));
  assert.deepEqual(valid.deferred, []);
  assert.deepEqual(Object.keys(valid.measurements.searched).sort(), [...names].sort());
  assert.equal(options.readers.checkout({ repository_multihash: identity('old-owner') }), old);

  const reject = (label, change) => {
    const candidate = structuredClone(contract);
    change(candidate.proof.search.repositories);
    const result = judge(candidate);
    assert.equal(result.valid, false, `${label}: ${JSON.stringify(result)}`);
    assert.ok(result.errors.length, `${label} must be refused, not silently deferred`);
  };
  reject('both locator forms', (rows) => { rows[0].repository = 'old-owner'; });
  reject('malformed identity', (rows) => { rows[0].repository_multihash = '12:' + 'a'.repeat(64); });
  reject('unknown identity', (rows) => { rows[0].repository_multihash = identity('outside-owner'); });
  reject('missing canonical repository', (rows) => { rows.pop(); });
  reject('duplicate resolved repository', (rows) => { rows.push({ repository: 'old-owner', commit: oldCommit }); });
  reject('unresolvable commit', (rows) => { rows[0].commit = 'f'.repeat(40); });
  reject('commit from another repository', (rows) => { rows[0].commit = since; });
  reject('non-record locator', (rows) => { rows[0] = null; });

  const outside = join(base, 'outside-owner');
  mkdirSync(outside);
  git(outside, 'init', '-q', '-b', 'main');
  commit(outside, { 'README.md': 'unadmitted sibling\n' });
  assert.equal(options.readers.checkout({ repository_multihash: identity('outside-owner') }), null,
    'a matching sibling directory cannot grant a repository identity scope');
  assert.equal(options.readers.repositoryName({ repository_multihash: identity('../outside-owner') }, ['../outside-owner']), null);
  assert.equal(options.readers.checkout('../old-owner'), null, 'a raw name cannot traverse outside the declared sibling lookup');
  const spaced = gitReaders({ root: tools, repositories: { 'My Repo': old }, tree: 'HEAD' });
  assert.equal(spaced.checkout('My Repo'), old);
  assert.equal(spaced.checkout({ repository_multihash: identity('My Repo') }), old,
    'an explicit authorized name keeps the same meaning when its ordinary spaces are hashed');

  const named = structuredClone(contract);
  named.proof.search.repositories = names.map((repository) => ({ repository, commit: commits[repository] }));
  assert.equal(judge(named).valid, true);
  for (const badCommit of ['not-a-commit', 'f'.repeat(40), since]) {
    const bad = structuredClone(named);
    bad.proof.search.repositories[0].commit = badCommit;
    assert.equal(judge(bad).valid, false, 'a plain name cannot bypass captured-commit verification');
  }
  const unreachable = { ...repositories, 'old-owner': join(base, 'temporarily-unreachable-owner') };
  const unreadableTyped = judge(contract, { readers: gitReaders({ root: tools, repositories: unreachable, tree: 'HEAD' }) });
  const unreadableNamed = judge(named, { readers: gitReaders({ root: tools, repositories: unreachable, tree: 'HEAD' }) });
  assert.deepEqual(unreadableTyped, unreadableNamed, 'known identity coverage survives an unavailable checkout in both forms');
  assert.deepEqual(unreadableTyped.errors, []);
  assert.ok(unreadableTyped.deferred.length > 0, 'unreadable capture and fresh search remain unqualified');

  const namedSource = portContract({ oldCommit, baselineCommit: since });
  const typedSource = structuredClone(namedSource);
  typedSource.sources[0].repository = { repository_multihash: identity('old-owner') };
  const namedAdmission = judge(namedSource), typedAdmission = judge(typedSource);
  assert.equal(typedAdmission.valid, false, 'the supported typed source still fails actual admission gates');
  assert.deepEqual(typedAdmission.errors, namedAdmission.errors.map(error => error.replaceAll('old-owner', identity('old-owner'))),
    'typed and named source forms retain the same retirement, baseline and retention refusals');
  assert.deepEqual(typedAdmission.deferred, namedAdmission.deferred);

  const later = commit(old, { 'README.md': 'later published source\n' });
  git(old, 'update-ref', 'refs/remotes/origin/main', later);
  const fresh = judge(contract, { readers: gitReaders({ root: tools, repositories, tree: 'HEAD' }) });
  assert.equal(fresh.valid, true, JSON.stringify(fresh));
  assert.equal(fresh.measurements.searched['old-owner'], later);
  assert.equal(contract.proof.search.repositories[0].commit, oldCommit, 'captured proof is not rewritten as a fresh search');
  const replacement = git(old, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit-tree', `${later}^{tree}`, '-m', 'synthetic replacement main');
  git(old, 'update-ref', 'refs/remotes/origin/main', replacement);
  assert.equal(spawnSync('git', ['-C', old, 'merge-base', '--is-ancestor', oldCommit, replacement]).status, 1);
  const afterReplacement = judge(contract, { readers: gitReaders({ root: tools, repositories, tree: 'HEAD' }) });
  assert.equal(afterReplacement.valid, true, JSON.stringify(afterReplacement));
  assert.equal(afterReplacement.measurements.searched['old-owner'], replacement);
  assert.equal(contract.proof.search.repositories[0].commit, oldCommit);
});

test('a repository with no checkout here is deferred in words, never passed or refused on its own', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  commit(tools, {
    'tools/order-rows/do-work/order-rows.mjs': 'export const sortRows = (rows) => rows;\n',
    'tools/order-rows/ports/new.json': noPriorOwner({ distinct_from: [{ repository: 'old-owner', path: 'src/', why: 'made-up' }] }, { 'old-owner': oldCommit, 'tools-repo': since }),
  });
  const result = judgeRepository({ root: tools, span: range(since), searchRepositories: ['old-owner', 'tools-repo', 'elsewhere'], repositories: {} });
  assert.ok(result.judged[0].deferred.some((one) => /elsewhere/.test(one)));
  assert.ok(result.judged[0].deferred.some((one) => /capability search is not re-run/.test(one)));
});

test('a file grown past the line number needs a contract; a small change does not', (t) => {
  const { tools, since } = checkouts(t);
  const start = commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': OLD_SOURCE });
  commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': `${OLD_SOURCE}export const one = 1;\n` });
  assert.equal(judgeRepository({ root: tools, span: { from: start, to: 'HEAD' }, rules: { ...RULES, since } }).judged.length, 0);
  commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': `${OLD_SOURCE}${'export const more = 2;\n'.repeat(9)}` });
  const grown = judgeRepository({ root: tools, span: { from: start, to: 'HEAD' }, rules: { ...RULES, since } });
  assert.equal(grown.judged[0].change, 'grown');
  assert.equal(grown.valid, false);
});

test('the command prints the judgement and exits 1 on a refusal, 2 when it cannot judge', (t) => {
  const { tools, since } = checkouts(t);
  commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': 'export const x = 1;\n' });
  const refused = spawnSync(process.execPath, [JUDGE, '--root', tools, '--since-rules'], { encoding: 'utf8' });
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(JSON.parse(refused.stdout).judged[0].path, 'tools/order-rows/do-work/order-rows.mjs');
  const unjudged = spawnSync(process.execPath, [JUDGE, '--root', tools], { encoding: 'utf8' });
  assert.equal(unjudged.status, 2);
  assert.ok(since);
});

test('contracts kept in another checkout claim the judged files, and a tree with no rules is reported unjudged', (t) => {
  const { tools, base, since, oldCommit } = checkouts(t);
  const plans = join(base, 'plans-repo');
  mkdirSync(plans);
  git(plans, 'init', '-q', '-b', 'main');
  write(plans, { 'contracts/order-rows.json': portContract({ oldCommit, status: 'BASELINED' }) });
  write(tools, { 'tools/order-rows/do-work/order-rows.mjs': OLD_SOURCE });
  git(tools, 'add', '-A');
  const rules = { ...RULES, since, contracts_match: '^contracts/.+\\.json$', contracts_in: { repository: 'plans-repo' } };
  const result = judgeRepository({ root: tools, span: { staged: true }, rules, now: NOW_BEFORE_DUE });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  git(tools, 'rm', '-q', '--cached', 'ports/feature-files.json');
  const unjudged = judgeRepository({ root: tools, span: { staged: true } });
  assert.match(unjudged.unjudged, /predates the port rules/);
});

test('a move into a public repository may lose private words in its first commit, only as the redactions it declares', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const copied = OLD_SOURCE.split('keepTheRowsInOrder').join('orderTheRows');
  const copy = commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': copied });
  const contract = portContract({ oldCommit, baselineCommit: copy });
  contract.baseline.redactions = [{ from: 'keepTheRowsInOrder', to: 'orderTheRows' }];
  contract.baseline.target_multihash_at_baseline = identity(copied);
  contract.proof.required_mechanisms = ['orderTheRows3'];
  commit(tools, { 'tools/order-rows/ports/order-rows.json': contract });
  assert.equal(judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE }).valid, true);
  contract.baseline.redactions = [{ from: 'keepTheRowsInOrder', to: 'sortRows' }];
  commit(tools, { 'tools/order-rows/ports/order-rows.json': contract });
  const errors = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE }).judged[0].errors.join('\n');
  assert.match(errors, /exactly baseline\.redactions applied/);
});

test('a source that is part of a file is followed by its lines: kept after its date is refused, removed passes while the rest stays', (t) => {
  const { tools, old, since } = checkouts(t);
  const before = 'export const engineStart = 1;\n'.repeat(3);
  const after = 'export const engineEnd = 2;\n'.repeat(2);
  const oldCommit = commit(old, { 'src/engine.mjs': before + OLD_SOURCE + after });
  git(old, 'update-ref', 'refs/remotes/origin/main', oldCommit);
  const part = (contract, status = 'ADAPTED') => ({ ...contract, status,
    sources: [{ ...contract.sources[0], path: 'src/engine.mjs', lines: [4, 15] }] });
  const copy = commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': OLD_SOURCE });
  commit(tools, { 'tools/order-rows/ports/order-rows.json': part(portContract({ oldCommit, baselineCommit: copy })) });
  assert.equal(judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE }).valid, true);
  commit(old, { 'src/engine.mjs': before + OLD_SOURCE.replaceAll('{ return', '{\n    return') + after });
  git(old, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const late = judgeRepository({ root: tools, span: range(since), now: '2026-02-01T00:00:00Z' });
  assert.match(late.judged[0].errors.join('\n'), /engine\.mjs lines 4-15 still lives after its deleted_by/, 'a re-indented copy is the same copy');
  commit(old, { 'src/engine.mjs': before + after });
  git(old, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  commit(tools, { 'tools/order-rows/ports/order-rows.json': part(portContract({ oldCommit, baselineCommit: copy }), 'VERIFIED') });
  const moved = judgeRepository({ root: tools, span: range(since), now: '2026-02-01T00:00:00Z' });
  assert.equal(moved.valid, true, JSON.stringify(moved, null, 2));
  commit(tools, { 'tools/order-rows/ports/order-rows.json': { ...part(portContract({ oldCommit, baselineCommit: copy })),
    sources: [{ ...part(portContract({ oldCommit })).sources[0], lines: [4, 99] }] } });
  assert.match(judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE }).judged[0].errors.join('\n'), /lines must be \[first, last\] within its 18 lines/);
});

test('a source in a private repository may be named by its path\'s identity, and is read and followed the same way', (t) => {
  const { tools, since, oldCommit } = checkouts(t);
  const hidden = (contract) => {
    const { path, ...source } = contract.sources[0];
    return { ...contract, sources: [{ ...source, path_multihash: identity(path) }] };
  };
  const copy = commit(tools, { 'tools/order-rows/do-work/order-rows.mjs': OLD_SOURCE });
  commit(tools, { 'tools/order-rows/ports/order-rows.json': hidden(portContract({ oldCommit, baselineCommit: copy })) });
  const result = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  const late = judgeRepository({ root: tools, span: range(since), now: '2026-02-01T00:00:00Z' });
  assert.match(late.judged[0].errors.join('\n'), /still lives after its deleted_by/);
  assert.doesNotMatch(late.judged[0].errors.join('\n'), /src\/order-rows/);
  commit(tools, { 'tools/order-rows/ports/order-rows.json': hidden({ ...portContract({ oldCommit, baselineCommit: copy }), sources: [{ ...portContract({ oldCommit }).sources[0], path: 'src/elsewhere.mjs' }] }) });
  const wrong = judgeRepository({ root: tools, span: range(since), now: NOW_BEFORE_DUE });
  assert.match(wrong.judged[0].errors.join('\n'), /is not in that commit/);
});

test('--for-command judges what a commit or a push would publish, and nothing for any other command', (t) => {
  const { tools } = checkouts(t);
  git(tools, 'add', '-A');
  git(tools, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'rules');
  write(tools, { 'tools/order-rows/do-work/order-rows.mjs': 'export const x = 1;\n' });
  git(tools, 'add', '-A');
  const judge = (command) => spawnSync(process.execPath, [JUDGE, '--root', tools, '--for-command', command], { encoding: 'utf8' });
  const commitCall = judge('git add -A && git commit -m "add order rows"');
  assert.equal(commitCall.status, 1, commitCall.stdout);
  assert.match(commitCall.stdout, /tools\/order-rows\/do-work\/order-rows\.mjs/);
  const other = judge('ls -la');
  assert.equal(other.status, 0);
  assert.match(other.stdout, /commits and pushes nothing/);
});
