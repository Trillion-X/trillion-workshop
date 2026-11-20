// The staged index and a normal commit of its exact bytes obey the same source-lineage rules.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { judgeRepository } from '../do-work/check-a-repository-for-port-contracts.mjs';

const OLD = 'src/original.mjs', MIDDLE = 'src/middle.mjs', CURRENT = 'src/current.mjs';
const HELD = 'proofs/raw-source.mjs', TWIN = 'proofs/twin-source.mjs';
const CONTRACT = 'ports/contract.json', RULES = 'ports/feature-files.json';
const SOURCE = Array.from({ length: 12 }, (_, index) =>
  `export function preserveStagedRows${index}(rows) { return rows.slice(${index}); }`).join('\n') + '\n';
const ADAPTED = `${SOURCE}export const activeStageAdapter = true;\n`;
const EARLIER = 'export const originalPrePolicyDevelopment = true;\n';
const digest = makeHashCodeHexFromBytes(Buffer.from(SOURCE));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const NOW = '2026-01-04T00:00:00Z';

function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root, path, contents) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`);
}

function commit(root, files, message) {
  for (const [path, contents] of Object.entries(files)) write(root, path, contents);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function initialize(root) {
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'staged-lineage-test');
  git(root, 'config', 'user.email', 'stage@example.test');
}

function fixture(t) {
  const home = tempFolder(join(tmpdir(), 'staged-same-file-lineage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'receiving-owner');
  initialize(root);
  const initial = commit(root, { [OLD]: EARLIER }, 'earlier original development');
  const baseline = commit(root, { [OLD]: SOURCE }, 'complete pre-policy original snapshot');
  return { home, root, initial, baseline, since: baseline };
}

function declaration(f) {
  return {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-SYNTHETIC-STAGED-SAME-FILE', status: 'ADAPTED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'Synthetic fixture: preserve the original file through its staged rename', message_multihash: digest },
    sources: [{ repository: basename(f.root), commit: f.baseline, path: OLD, multihash: digest,
      ownership: 'repository-owned', old_copy: 'same-file' }],
    targets: [{ path: CURRENT }], preserve: ['the twelve original row functions'],
    allowed_deltas: ['rename and an adapter export'], banned_substitutions: ['copy or resurrection claimed as original-file continuity'],
    baseline: { commit: f.baseline, copied_before_adaptation: true, source_multihash: digest,
      target_multihash_at_baseline: digest, recorded_at: '2026-01-01T00:00:00Z' },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['preserveStagedRows11'],
      test_refs: ['tools/check-a-port-against-its-source/test/staged-same-file-rename-identity.test.mjs'] },
  };
}

function stageMetadata(f, contract = declaration(f)) {
  write(f.root, CONTRACT, contract);
  write(f.root, RULES, {
    schema: 'port-contracts/feature-files', since: f.since,
    feature_files: [{ matches: '^src/current\\.mjs$', added: true, grown_lines_over: 0 }],
    contracts_match: '^ports/contract\\.json$', modes: ['SOURCE_FIRST_PORT'],
    retention_at_least: 0.6, old_copy_days_at_most: 3,
  });
  git(f.root, 'add', '--', CONTRACT, RULES);
  return contract;
}

function stagedReport(f) {
  return git(f.root, 'diff', '--cached', '-M', '--name-status', '--', 'src', 'proofs');
}

function committedRename(f, from, to) {
  git(f.root, 'mv', from, to);
  const revision = commit(f.root, {}, `genuine committed rename ${from} to ${to}`);
  assert.equal(git(f.root, 'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', `${revision}^`, revision),
    `R100\t${from}\t${to}`);
  return revision;
}

function sourcePins(f, contract) {
  return contract.sources.map(source => {
    const owner = source.repository === basename(f.root) ? f.root : join(f.home, source.repository);
    return { repository: source.repository, commit: source.commit, path: source.path,
      blob: git(owner, 'rev-parse', `${source.commit}:${source.path}`) };
  });
}

function recordExactIndex(f, contract, t) {
  const before = {
    tree: git(f.root, 'write-tree'), target: git(f.root, 'rev-parse', `:${CURRENT}`),
    contract: git(f.root, 'rev-parse', `:${CONTRACT}`), sources: sourcePins(f, contract),
  };
  const staged = judgeRepository({ root: f.root, span: { staged: true }, now: NOW });
  assert.equal(git(f.root, 'write-tree'), before.tree, 'staged judgment preserves the exact index tree');
  assert.deepEqual(sourcePins(f, contract), before.sources, 'source snapshots remain unchanged after staged judgment');
  // No add or source write occurs here: this is a normal synthetic commit of the already judged exact index.
  git(f.root, 'commit', '-qm', 'record the exact staged source and contract bytes');
  assert.equal(git(f.root, 'rev-parse', 'HEAD^{tree}'), before.tree);
  assert.equal(git(f.root, 'rev-parse', `HEAD:${CURRENT}`), before.target);
  assert.equal(git(f.root, 'rev-parse', `HEAD:${CONTRACT}`), before.contract);
  const committed = judgeRepository({ root: f.root, span: { from: f.since, to: 'HEAD' }, now: NOW });
  assert.deepEqual(sourcePins(f, contract), before.sources, 'the same pinned sources survive committed judgment');
  t.diagnostic(JSON.stringify({ staged, committed, exactIndex: before }));
  return { staged, committed };
}

function assertPass(result) {
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  assert.equal(result.judged.length, 1, JSON.stringify(result));
  assert.equal(result.judged[0].path, CURRENT);
  assert.deepEqual(result.judged[0].errors, [], JSON.stringify(result));
  assert.deepEqual(result.judged[0].deferred, []);
  assert.equal(result.valid, true);
}

function assertRefused(result) {
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  assert.equal(result.judged.length, 1, JSON.stringify(result));
  assert.equal(result.judged[0].path, CURRENT);
  assert.deepEqual(result.judged[0].deferred, []);
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.judged[0].errors.join('\n'), /same-file|identity|bijection|baseline.*history|baseline must precede/);
  assert.doesNotMatch(result.judged[0].errors.join('\n'), /no contract|source multihash drift|not readable here/);
}

test('a staged unique R100 and its exact normal commit preserve the same-file contract', t => {
  const f = fixture(t);
  git(f.root, 'mv', OLD, CURRENT);
  assert.equal(stagedReport(f), `R100\t${OLD}\t${CURRENT}`);
  const contract = stageMetadata(f);
  const { staged, committed } = recordExactIndex(f, contract, t);
  assertPass(committed);
  assertPass(staged);
});

test('a pending rename extends an already committed genuine rename without changing staged bytes at commit', t => {
  const f = fixture(t);
  committedRename(f, OLD, MIDDLE);
  git(f.root, 'mv', MIDDLE, CURRENT);
  assert.equal(stagedReport(f), `R100\t${MIDDLE}\t${CURRENT}`);
  const contract = stageMetadata(f);
  const { staged, committed } = recordExactIndex(f, contract, t);
  assertPass(committed);
  assertPass(staged);
});

test('a staged retained-copy addition cannot inherit same-file identity', t => {
  const f = fixture(t);
  write(f.root, CURRENT, SOURCE);
  git(f.root, 'add', '--', CURRENT);
  assert.equal(stagedReport(f), `A\t${CURRENT}`);
  const contract = stageMetadata(f);
  const { staged, committed } = recordExactIndex(f, contract, t);
  assertRefused(staged);
  assertRefused(committed);
});

test('a staged R100 plus an equal-byte added output remains an ambiguous split', t => {
  const f = fixture(t);
  git(f.root, 'mv', OLD, CURRENT);
  write(f.root, TWIN, SOURCE);
  git(f.root, 'add', '--', TWIN);
  const report = stagedReport(f);
  assert.match(report, /^R100\t/m);
  assert.match(report, /^A\t/m);
  assert.equal(report.split('\n').length, 2);
  const contract = stageMetadata(f);
  const { staged, committed } = recordExactIndex(f, contract, t);
  assertRefused(staged);
  assertRefused(committed);
});

test('staged A resurrection of a genuinely renamed then deleted target is refused', t => {
  const f = fixture(t);
  committedRename(f, OLD, CURRENT);
  git(f.root, 'rm', '-q', CURRENT);
  commit(f.root, {}, 'delete the formerly renamed target');
  write(f.root, CURRENT, SOURCE);
  git(f.root, 'add', '--', CURRENT);
  assert.equal(stagedReport(f), `A\t${CURRENT}`);
  const contract = stageMetadata(f);
  const { staged, committed } = recordExactIndex(f, contract, t);
  assertRefused(staged);
  assertRefused(committed);
});

test('a pending rename cannot hide committed adaptation before a separate SourceFirst baseline', t => {
  const f = fixture(t);
  const old = join(f.home, 'external-original-owner');
  initialize(old);
  const sourceCommit = commit(old, { 'source.mjs': SOURCE, 'README.md': 'Synthetic external source.\n' }, 'original external source');
  git(old, 'rm', '-q', 'source.mjs');
  const retired = commit(old, {}, 'retire external source');
  git(old, 'update-ref', 'refs/remotes/origin/main', retired);
  git(f.root, 'rm', '-q', OLD);
  commit(f.root, { [MIDDLE]: ADAPTED }, 'adapt the future active path before a source baseline');
  const baseline = commit(f.root, { [HELD]: SOURCE }, 'later genuine raw source artifact');
  git(f.root, 'mv', MIDDLE, CURRENT);
  assert.equal(stagedReport(f), `R100\t${MIDDLE}\t${CURRENT}`);
  const contract = declaration(f);
  contract.sources = [{ repository: basename(old), commit: sourceCommit, path: 'source.mjs', multihash: digest,
    ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-03T00:00:00Z' } }];
  contract.baseline.commit = baseline;
  contract.baseline.path = HELD;
  stageMetadata(f, contract);
  const { staged, committed } = recordExactIndex(f, contract, t);
  assertRefused(committed);
  assertRefused(staged);
});
