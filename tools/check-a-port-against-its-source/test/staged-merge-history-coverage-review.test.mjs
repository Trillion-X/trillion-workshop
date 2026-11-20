// A real pending merge has two parents; its staged history proof must cover both before the exact merge commit.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { judgeRepository } from '../do-work/check-a-repository-for-port-contracts.mjs';
import { validateReferenceAdaptationContract } from '../do-work/validate-reference-adaptation-contract.mjs';

const OLD = 'src/original.mjs', CURRENT = 'src/current.mjs';
const SOURCE = Array.from({ length: 12 }, (_, index) =>
  `export function preserveMergeRows${index}(rows) { return rows.slice(${index}); }`).join('\n') + '\n';
const ADAPTED = `${SOURCE}export const mergeAdapter = true;\n`;
const digest = makeHashCodeHexFromBytes(Buffer.from(SOURCE));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function write(root, files) {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  }
}
function commit(root, files, message) {
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(t, { parallelAdaptation = false, extraParent = false, pendingRename = false } = {}) {
  const home = tempFolder(join(tmpdir(), 'staged-merge-history-review-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'merge-owner');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'merge-history-review');
  git(root, 'config', 'user.email', 'merge@example.test');
  const shared = commit(root, { [OLD]: SOURCE }, 'shared exact source introduction');
  git(root, 'branch', 'parallel', shared);
  if (extraParent) git(root, 'branch', 'spare', shared);
  const baseline = commit(root, { 'baseline-marker.txt': 'pre-policy captured source\n' }, 'declare unchanged source baseline');
  let firstParent;
  if (pendingRename) {
    firstParent = commit(root, { 'main-marker.txt': 'main branch still holds the original spelling\n' }, 'main work before pending rename');
    assert.equal(git(root, 'show', `${firstParent}:${OLD}`), SOURCE.trimEnd());
  } else {
    git(root, 'mv', OLD, CURRENT);
    firstParent = commit(root, {}, 'genuine main rename');
    assert.equal(git(root, 'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', `${firstParent}^`, firstParent),
      `R100\t${OLD}\t${CURRENT}`);
  }
  git(root, 'checkout', '-q', 'parallel');
  const adapted = parallelAdaptation ? commit(root, { [OLD]: ADAPTED }, 'adapt parallel to declared baseline') : null;
  const secondParent = commit(root, { [OLD]: SOURCE, 'parallel-marker.txt': 'parallel side work\n' },
    parallelAdaptation ? 'revert to apparently exact source' : 'independent raw-only branch work');
  let thirdParent;
  if (extraParent) {
    git(root, 'checkout', '-q', 'spare');
    thirdParent = commit(root, { 'spare-marker.txt': 'another raw-only branch\n' }, 'independent third-parent work');
  }
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '--no-ff', '--no-commit', '-q', 'parallel', ...(extraParent ? ['spare'] : []));
  const mergeHeads = readFileSync(join(root, '.git/MERGE_HEAD'), 'utf8').trim().split('\n');
  assert.deepEqual(mergeHeads, [secondParent, ...(extraParent ? [thirdParent] : [])]);
  assert.equal(git(root, 'rev-parse', 'HEAD'), firstParent);
  if (pendingRename) git(root, 'mv', OLD, CURRENT);
  const declaration = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-SYNTHETIC-STAGED-MERGE-HISTORY',
    status: 'ADAPTED', mode: 'SOURCE_FIRST_PORT',
    directive: { quote: 'Preserve the same file across a genuine merge', message_multihash: digest },
    sources: [{ repository: basename(root), commit: baseline, path: OLD, multihash: digest,
      ownership: 'repository-owned', old_copy: 'same-file' }],
    targets: [{ path: CURRENT }], preserve: ['the twelve source functions'], allowed_deltas: ['one adapter export'],
    banned_substitutions: ['a hidden parallel adaptation'],
    baseline: { commit: baseline, copied_before_adaptation: true, source_multihash: digest,
      target_multihash_at_baseline: digest, recorded_at: '2026-01-01T00:00:00Z' },
    proof: { minimum_meaningful_line_retention: 0.6, required_mechanisms: ['preserveMergeRows11'],
      test_refs: ['tools/check-a-port-against-its-source/test/staged-merge-history-coverage-review.test.mjs'] },
  };
  write(root, {
    [CURRENT]: pendingRename ? SOURCE : ADAPTED,
    'ports/contract.json': declaration,
    'ports/feature-files.json': {
      schema: 'port-contracts/feature-files', since: baseline,
      feature_files: [{ matches: '^src/current\\.mjs$', added: true, grown_lines_over: 0 }],
      contracts_match: '^ports/contract\\.json$', modes: ['SOURCE_FIRST_PORT'], retention_at_least: 0.6, old_copy_days_at_most: 3,
    },
  });
  git(root, 'add', '-A');
  if (pendingRename) {
    assert.equal(git(root, 'diff', '--cached', '-M', '--name-status', '--', 'src'), `R100\t${OLD}\t${CURRENT}`,
      'the pending merge carries an actual exact rename against its first parent');
    assert.equal(git(root, 'diff', '--cached', '-M', '--name-status', secondParent, '--', 'src'), `R100\t${OLD}\t${CURRENT}`,
      'the same pending R100 is visible against the genuine merge parent');
  }
  return { root, shared, baseline, adapted, firstParent, secondParent, thirdParent, mergeHeads, declaration, pendingRename };
}

function parity(f, t) {
  const { root, shared, baseline, adapted, firstParent, secondParent, mergeHeads, declaration, pendingRename } = f;
  const exactTree = git(root, 'write-tree');
  const exactIndex = readFileSync(join(root, '.git/index'));
  const stagedReader = gitReaders({ root, tree: ':' });
  const stagedHistory = stagedReader.baselineHistory(baseline, [CURRENT]);
  const validate = readers => validateReferenceAdaptationContract(declaration, {
    readers, repository: readers.self, stage: 'pre-edit', policySince: baseline, activeTargetPaths: [CURRENT],
    retentionAtLeast: 0.6, oldCopyDaysAtMost: 3, now: '2026-01-04T00:00:00Z',
  });
  const stagedContract = validate(stagedReader);
  const staged = judgeRepository({ root, span: { staged: true }, now: '2026-01-04T00:00:00Z' });
  assert.deepEqual(readFileSync(join(root, '.git/index')), exactIndex, 'staged judgment preserves the original index bytes');
  assert.equal(git(root, 'write-tree'), exactTree, 'the staged proof preserves the exact judged index');
  git(root, 'commit', '-qm', 'record the exact pending merge index');
  const merged = git(root, 'rev-parse', 'HEAD');
  assert.equal(git(root, 'rev-list', '--parents', '-n', '1', merged), [merged, firstParent, ...mergeHeads].join(' '));
  assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), exactTree);
  const committedReader = gitReaders({ root, tree: 'HEAD' });
  const committedHistory = committedReader.baselineHistory(baseline, [CURRENT]);
  const committedContract = validate(committedReader);
  const committed = judgeRepository({ root, span: { from: baseline, to: 'HEAD' }, now: '2026-01-04T00:00:00Z' });
  t.diagnostic(JSON.stringify({ shared, baseline, adapted, firstParent, secondParent, merged, exactTree, pendingRename,
    stagedParallel: stagedHistory.targets[0].parallel.length,
    committedParallel: committedHistory.targets[0].parallel.length, staged, committed, stagedContract, committedContract }));
  assert.equal(committedContract.measurements.meaningfulLineRetention, 1);
  assert.deepEqual(committed.judged[0].deferred, []);
  assert.equal(stagedContract.measurements.meaningfulLineRetention, 1);
  assert.deepEqual(staged.judged[0].deferred, []);
  return { staged, committed, stagedContract, committedContract, stagedHistory, committedHistory };
}

for (const pendingRename of [false, true]) {
  test(`a pending merge with ${pendingRename ? 'staged R100' : 'committed rename'} cannot omit parallel adapted-and-reverted history`, t => {
    const result = parity(fixture(t, { parallelAdaptation: true, pendingRename }), t);
    const { staged, committed, stagedContract, committedContract } = result;
    assert.equal(committed.valid, false, JSON.stringify(committed));
    assert.equal(committedContract.valid, false, JSON.stringify(committedContract));
    assert.equal(stagedContract.valid, false, JSON.stringify(stagedContract));
    assert.equal(staged.valid, false, JSON.stringify(staged));
  });

  test(`raw-only pending merge with ${pendingRename ? 'staged R100' : 'committed rename'} and its exact commit both preserve same-file provenance`, t => {
    const { staged, committed, stagedContract, committedContract } = parity(fixture(t, { pendingRename }), t);
    assert.equal(staged.valid, true, JSON.stringify(staged));
    assert.equal(committed.valid, true, JSON.stringify(committed));
    assert.deepEqual(stagedContract.errors, []);
    assert.deepEqual(committedContract.errors, []);
  });
}

for (const movement of ['added', 'changed', 'removed', 'reordered', 'head-moved']) {
  test(`late staged parent movement (${movement}) invalidates a populated reader while preserving index bytes`, t => {
    const f = fixture(t, { extraParent: movement === 'reordered' });
    const { root, baseline, firstParent, secondParent, shared, mergeHeads } = f;
    const mergeHeadPath = join(root, '.git/MERGE_HEAD');
    if (movement === 'added') rmSync(mergeHeadPath);
    // Populate immutable tree, lineage, move and history caches only after the staged scope is captured.
    git(root, 'write-tree');
    const originalIndex = readFileSync(join(root, '.git/index'));
    const sourceObject = git(root, 'rev-parse', `${baseline}:${OLD}`);
    const readers = gitReaders({ root, tree: ':' });
    readers.snapshotSpan({ staged: true });
    assert.deepEqual(readers.readTarget(CURRENT), Buffer.from(ADAPTED));
    assert.deepEqual(readers.targetAtCommit(baseline, CURRENT), Buffer.from(SOURCE));
    assert.equal(readers.sameFileIdentity(baseline, OLD, CURRENT), true);
    assert.equal(readers.baselineHistory(baseline, [CURRENT]).allEarlierOrParallelContent, true);
    readers.assertScope();
    if (movement === 'added') writeFileSync(mergeHeadPath, `${secondParent}\n`);
    if (movement === 'changed') writeFileSync(mergeHeadPath, `${shared}\n`);
    if (movement === 'removed') rmSync(mergeHeadPath);
    if (movement === 'reordered') writeFileSync(mergeHeadPath, `${[...mergeHeads].reverse().join('\n')}\n`);
    if (movement === 'head-moved') git(root, 'update-ref', 'HEAD', baseline, firstParent);
    assert.deepEqual(readFileSync(join(root, '.git/index')), originalIndex, 'only parent metadata moved; the exact index bytes remain unchanged');
    assert.equal(git(root, 'rev-parse', `${baseline}:${OLD}`), sourceObject);
    assert.throws(() => readers.assertScope(), /parent|HEAD|history|changed/i, 'a previously cached proof cannot finish under different staged parents');
    assert.throws(() => readers.readTarget(CURRENT), /parent|HEAD|history|changed/i, 'the staged target consumer also refuses the moved scope');
  });
}
