// A complete original snapshot can precede adaptation even when a port selects two ranges from it.
// These repositories and functions are synthetic; the real Git history supplies the byte-copy evidence.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { judgeRepository } from '../do-work/check-a-repository-for-port-contracts.mjs';

const SOURCE = Array.from({ length: 12 }, (_, index) =>
  `export function keepRowsInOrder${index}(rows) { return rows.slice(${index}); }`).join('\n') + '\n';
const SOURCE_PATH = 'src/order-rows.mjs';
const TARGET = 'tools/order-rows/do-work/order-rows.mjs';
const BASELINE = 'tools/order-rows/source-baselines/order-rows.mjs.held';
const CONTRACT = 'tools/order-rows/ports/order-rows.json';
const RANGES = [[2, 4], [8, 10]];
const NOW = '2026-01-02T00:00:00Z';
const identity = text => makeHashCodeHexFromBytes(Buffer.from(text));
const selected = (text, [first, last]) => `${text.split('\n').slice(first - 1, last).join('\n')}\n`;

function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(root, files, message) {
  for (const [path, value] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(t, { excerpt = false, corruptSnapshot = false, mixedOrigins = false,
  mixedCommit = false, mixedRepository = false, fullRedactions = false,
  priorAdaptation = false, archiveOnly = false, sourceDrift = false, unreadableSource = false } = {}) {
  const home = tempFolder(join(tmpdir(), 'full-source-ranges-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = join(home, 'old-owner'), tools = join(home, 'tools-repo');
  for (const root of [old, tools]) {
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
  }
  const otherSource = SOURCE.replace('rows.slice(11)', 'rows.toReversed()');
  const original = commit(old, {
    [SOURCE_PATH]: SOURCE,
    ...(mixedOrigins ? { 'src/other-order-rows.mjs': SOURCE } : {}),
  }, 'original synthetic source');
  const laterOriginal = mixedCommit
    ? commit(old, { 'README.md': 'A later source commit preserves the original file byte for byte.\n' }, 'same source bytes in another commit')
    : original;
  // A local branch is not evidence of external publication. The fixture explicitly supplies its published ref.
  git(old, 'update-ref', 'refs/remotes/origin/main', laterOriginal);
  const repositories = { 'old-owner': old };
  if (mixedRepository) {
    const other = join(home, 'other-owner');
    git(home, 'clone', '--quiet', '--no-hardlinks', old, other);
    git(other, 'update-ref', 'refs/remotes/origin/main', original);
    repositories['other-owner'] = other;
  }
  const rules = {
    schema: 'port-contracts/feature-files', since: null,
    feature_files: [{ matches: '^tools/[^/]+/do-work/[^/]+\\.mjs$', added: true, grown_lines_over: 5 }],
    contracts_match: '^tools/[^/]+/ports/[^/]+\\.json$',
    modes: ['SOURCE_FIRST_PORT', 'NO_PRIOR_OWNER'], retention_at_least: 0.6, old_copy_days_at_most: 3,
  };
  const since = commit(tools, { 'ports/feature-files.json': rules }, 'begin source policy');
  rules.since = since;
  const parts = RANGES.map(range => selected(SOURCE, range));
  const active = `${parts.join('')}export const orderRowsForCaller = rows => rows.slice();\n`;
  if (priorAdaptation) commit(tools, { [TARGET]: active }, 'adapted code already exists');
  const snapshot = excerpt ? parts[0] : corruptSnapshot || fullRedactions ? otherSource : SOURCE;
  const baselineCommit = commit(tools, { [BASELINE]: snapshot, 'ports/feature-files.json': rules }, 'capture original before adaptation');
  const sources = RANGES.map((lines, index) => ({
    repository: mixedRepository && index === 1 ? 'other-owner' : 'old-owner',
    commit: unreadableSource && index === 0 ? 'f'.repeat(40) : mixedCommit && index === 1 ? laterOriginal : original,
    path: mixedOrigins && index === 1 ? 'src/other-order-rows.mjs' : SOURCE_PATH,
    lines, multihash: sourceDrift && index === 0 ? identity('unrelated declared bytes') : identity(parts[index]),
    ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-03T00:00:00Z' },
  }));
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-SYNTHETIC-RANGE-PORT',
    status: 'ADAPTED', directive: { message_multihash: identity('port the synthetic row operations'), quote: 'port the synthetic row operations' },
    mode: 'SOURCE_FIRST_PORT', sources, targets: [{ path: TARGET }],
    preserve: ['the selected row-ordering functions'], allowed_deltas: ['caller export after the preserved functions'],
    banned_substitutions: ['an archive standing in for active source retention'],
    baseline: { path: BASELINE, commit: baselineCommit, recorded_at: '2026-01-01T00:00:00Z',
      copied_before_adaptation: true, source_multihash: sources[0].multihash, target_multihash_at_baseline: identity(snapshot),
      ...(fullRedactions ? { redactions: [{ from: 'rows.slice(11)', to: 'rows.toReversed()' }] } : {}) },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['keepRowsInOrder1', 'keepRowsInOrder7'], test_refs: [] },
  };
  commit(tools, { [TARGET]: archiveOnly ? 'export const unrelatedCaller = true;\n' : active, [CONTRACT]: contract }, 'adapt selected source ranges');
  const result = judgeRepository({ root: tools, span: { from: since, to: 'HEAD' },
    repositories, rules, now: NOW });
  assert.equal(result.judged.length, 1);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.judged[0].deferred, []);
  return { result, errors: result.judged[0].errors, tools, baselineCommit, contract, repositories };
}

function assertIdenticalSourceBytes(contract, repositories) {
  const identities = contract.sources.map(source => identity(execFileSync('git', [
    '--no-replace-objects', '-C', repositories[source.repository], 'show', `${source.commit}:${source.path}`,
  ])));
  assert.equal(new Set(identities).size, 1, 'the origin opponent must not also change the full source bytes');
}

test('a complete pinned source snapshot proves two selected ranges before fresh active adaptation', t => {
  const { result, errors, tools, baselineCommit, contract } = fixture(t);
  assert.notEqual(contract.baseline.target_multihash_at_baseline, contract.sources[0].multihash);
  assert.equal(git(tools, 'ls-tree', baselineCommit, '--', TARGET), '', 'the active target did not exist at the raw capture');
  git(tools, 'merge-base', '--is-ancestor', baselineCommit, 'HEAD');
  const unrelated = errors.filter(error => !error.includes('baseline target multihash must equal source multihash')
    && !error.includes("at baseline.commit is not the source's bytes"));
  assert.deepEqual(unrelated, [], 'the counterexample must not fail a different requirement');
  assert.equal(result.valid, true, errors.join('\n'));
});

test('an ordinary exact excerpt baseline still proves selected source ranges', t => {
  const { result, errors } = fixture(t, { excerpt: true });
  assert.equal(result.valid, true, errors.join('\n'));
});

test('a changed unselected snapshot byte cannot qualify through matching selected slices', t => {
  const { result, errors } = fixture(t, { corruptSnapshot: true });
  assert.equal(result.valid, false);
  assert.match(errors.join('\n'), /baseline|source's bytes/);
});

test('identical source bytes at a different path do not share one full-artifact origin', t => {
  const { result, errors, contract, repositories } = fixture(t, { mixedOrigins: true });
  assertIdenticalSourceBytes(contract, repositories);
  assert.equal(contract.sources[0].repository, contract.sources[1].repository);
  assert.equal(contract.sources[0].commit, contract.sources[1].commit);
  assert.notEqual(contract.sources[0].path, contract.sources[1].path);
  assert.equal(result.valid, false);
  assert.match(errors.join('\n'), /baseline|source/);
});

test('identical source bytes in a different commit do not share one full-artifact origin', t => {
  const { result, errors, contract, repositories } = fixture(t, { mixedCommit: true });
  assertIdenticalSourceBytes(contract, repositories);
  assert.equal(contract.sources[0].repository, contract.sources[1].repository);
  assert.equal(contract.sources[0].path, contract.sources[1].path);
  assert.notEqual(contract.sources[0].commit, contract.sources[1].commit);
  assert.equal(result.valid, false);
  assert.match(errors.join('\n'), /baseline|source/);
});

test('identical source bytes in a different repository do not share one full-artifact origin', t => {
  const { result, errors, contract, repositories } = fixture(t, { mixedRepository: true });
  assertIdenticalSourceBytes(contract, repositories);
  assert.equal(contract.sources[0].commit, contract.sources[1].commit);
  assert.equal(contract.sources[0].path, contract.sources[1].path);
  assert.notEqual(contract.sources[0].repository, contract.sources[1].repository);
  assert.equal(result.valid, false);
  assert.match(errors.join('\n'), /baseline|source/);
});

test('a complete artifact with nonempty redactions cannot use the unredacted full-source proof', t => {
  const { result, errors } = fixture(t, { fullRedactions: true });
  assert.equal(result.valid, false);
  assert.ok(errors.length > 0);
  assert.ok(errors.every(error => error.includes('baseline target multihash must equal the source with exactly baseline.redactions applied')));
});

test('a full raw snapshot cannot repair prior active adaptation history', t => {
  const { result, errors } = fixture(t, { priorAdaptation: true });
  assert.equal(result.valid, false);
  assert.match(errors.join('\n'), /baseline must precede active adaptation/);
});

test('a full raw archive supplies no active retention or required mechanism', t => {
  const { result, errors } = fixture(t, { archiveOnly: true });
  assert.equal(result.valid, false);
  assert.match(errors.join('\n'), /meaningful line retention/);
  assert.match(errors.join('\n'), /required mechanism missing/);
});

test('a full raw snapshot does not excuse a selected source multihash drift', t => {
  const { result, errors } = fixture(t, { sourceDrift: true });
  assert.equal(result.valid, false);
  assert.match(errors.join('\n'), /source multihash drift/);
});

test('a full raw snapshot cannot replace unreadable pinned source evidence', t => {
  const { result, errors } = fixture(t, { unreadableSource: true });
  assert.equal(result.valid, false);
  assert.match(errors.join('\n'), /source .* is not in that commit/);
});
