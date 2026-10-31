// A clean report is a claim about the files that were READ. Source on disk that git does not
// track used to be counted but deliberately skipped; this test proves it is now judged. Tracked
// paths gone from the working tree remain separately visible as pending deletions.
//
// The proof that this is not theoretical: a checker run over a package that was 36 pending
// deletions with no files at all printed `0 file(s) ... 0 finding(s)`. Nothing in that output could
// tell that apart from a small, tidy, fully compliant package.
//
// So this test builds a repository holding one of each of the three kinds and asserts the run
// separates them. It uses a real `git init` rather than a stub, because the whole subject is what
// git reports, and a stubbed git would let both counters be hardcoded to zero forever.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'do-work',
  'run-check-source-files-against-declared-rules.mjs',
);

const RULES = {
  things: [
    {
      type: 'record',
      address: 'test::rule::every-mjs-under-packages',
      path: ['current-item', 'source-file-rule'],
      payload: {
        kind: 'source-file-rule',
        id: 'every-mjs-under-packages',
        why: 'a scope wide enough that the only thing deciding which files are judged is git',
        subject: { named: 'text' },
        scope: { path_matches: '^packages/.*\\.mjs$' },
        violation: { forbidden: [{ pattern: 'a-string-no-fixture-here-contains' }] },
        message: 'unreachable by construction, so any finding means the fixture drifted',
      },
    },
  ],
};

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('the run judges untracked source and counts deleted tracked paths separately', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'declared-source-rules-'));
  try {
    git(repo, 'init', '--quiet');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'test');

    mkdirSync(path.join(repo, 'packages', 'a-package', 'do-work'), { recursive: true });
    const judged = 'packages/a-package/do-work/judged.mjs';
    const vanished = 'packages/a-package/do-work/vanished.mjs';
    const neverAdded = 'packages/a-package/do-work/never-added.mjs';
    writeFileSync(path.join(repo, judged), 'export const judged = true;\n');
    writeFileSync(path.join(repo, vanished), 'export const vanished = true;\n');
    git(repo, 'add', '--', judged, vanished);
    git(repo, 'commit', '--quiet', '-m', 'two tracked files');

    // Gone from the working tree, still in the index. Somebody else's pending deletion.
    rmSync(path.join(repo, vanished));
    // On disk, never added. It must still be judged.
    writeFileSync(path.join(repo, neverAdded), 'export const neverAdded = true;\n');

    const rulesPath = path.join(repo, 'rules.json');
    writeFileSync(rulesPath, JSON.stringify(RULES));

    const output = execFileSync(
      process.execPath,
      [RUNNER, '--repo', repo, '--rules', rulesPath, '--json'],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(output);

    assert.equal(result.violations.length, 0, 'the fixture forbids a string it does not contain');
    assert.equal(result.files, 2, 'tracked and untracked source were both read and judged');
    assert.equal(result.in_scope_untracked_judged, 1);
    assert.deepEqual(result.in_scope_untracked_paths, [neverAdded]);
    assert.equal(result.in_scope_tracked_but_gone_from_disk, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a repository with nothing missing reports zero for both, so the counters can fail', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'declared-source-rules-clean-'));
  try {
    git(repo, 'init', '--quiet');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'test');

    mkdirSync(path.join(repo, 'packages', 'a-package', 'do-work'), { recursive: true });
    const only = 'packages/a-package/do-work/only.mjs';
    writeFileSync(path.join(repo, only), 'export const only = true;\n');
    git(repo, 'add', '--', only);
    git(repo, 'commit', '--quiet', '-m', 'one tracked file');

    const rulesPath = path.join(repo, 'rules.json');
    writeFileSync(rulesPath, JSON.stringify(RULES));
    // rules.json is untracked but out of scope, which is the second half of this assertion:
    // the counter must count what a RULE covers, never every untracked file in the tree.

    const result = JSON.parse(execFileSync(
      process.execPath,
      [RUNNER, '--repo', repo, '--rules', rulesPath, '--json'],
      { encoding: 'utf8' },
    ));

    assert.equal(result.files, 1);
    assert.equal(result.in_scope_untracked_judged, 0);
    assert.equal(result.in_scope_tracked_but_gone_from_disk, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rules given in a file outside the folder reject untracked source in it', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'declared-source-rules-untracked-manifest-'));
  try {
    git(repo, 'init', '--quiet');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'test');

    mkdirSync(path.join(repo, 'packages', 'new-package', 'do-work'), { recursive: true });
    const offender = 'packages/new-package/do-work/offender.mjs';
    writeFileSync(path.join(repo, offender), 'export const value = "a-string-no-fixture-here-contains";\n');
    const rulesFile = path.join(repo, '..', `${path.basename(repo)}-rules.json`);
    writeFileSync(rulesFile, JSON.stringify(RULES));

    const run = spawnSync(
      process.execPath,
      [RUNNER, '--repo', repo, '--rules', rulesFile, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 1, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.rules, 1);
    assert.equal(result.files, 1);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].path, offender);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(path.join(repo, "..", `${path.basename(repo)}-rules.json`), { force: true });
  }
});
