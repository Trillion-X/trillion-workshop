// Git supplies repository-relative names, but the working tree can redirect those names through
// symlinks or special files. These fixtures exercise the runner's filesystem boundary, not the
// pure rule engine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'do-work',
  'run-check-source-files-against-declared-rules.mjs',
);
const SENTINEL = 'OUTSIDE_SENTINEL_74A9';
const SOURCE = 'packages/p/do-work';
const RULES = {
  things: [
    {
      payload: {
        kind: 'source-file-rule',
        id: 'source-path-custody',
        why: 'the fixture detects content reached only outside the repository',
        subject: { named: 'text' },
        scope: { path_matches: '^packages/p/do-work/.*\\.mjs$' },
        violation: { forbidden: [{ pattern: SENTINEL }] },
        message: 'outside-only fixture sentinel',
      },
    },
  ],
};

function git(repo, ...args) {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function put(repo, relativePath, contents) {
  const absolutePath = path.join(repo, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  return absolutePath;
}

function fixture(t) {
  const repo = mkdtempSync(path.join(tmpdir(), 'source-path-custody-repo-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'source-path-custody-outside-'));
  const rulesPath = path.join(outside, 'rules.json');
  writeFileSync(rulesPath, JSON.stringify(RULES));

  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'test');
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  return { repo, outside, rulesPath };
}

// Every bound below detects a HANG (a FIFO open that never returns), never speed. A blocked open
// waits forever, so any finite bound tells it apart; a 2-3 s bound also failed good runs whenever
// exec admission on this Mac took that long by itself (0.35-2 s per launch at load 16-40,
// measured 2026-10-27), which made these tests about load instead of the runner.
const HANG_BOUND_MS = 60000;

function run(f, timeout = HANG_BOUND_MS, extra = []) {
  return spawnSync(
    process.execPath,
    [RUNNER, '--repo', f.repo, '--rules', f.rulesPath, '--json', ...extra],
    { encoding: 'utf8', timeout },
  );
}

function reportFor(runResult) {
  assert.ifError(runResult.error);
  assert.ok(runResult.stdout, runResult.stderr);
  return JSON.parse(runResult.stdout);
}

test('ordinary tracked and untracked source files are both judged', (t) => {
  const f = fixture(t);
  const tracked = `${SOURCE}/tracked.mjs`;
  const untracked = `${SOURCE}/untracked.mjs`;
  put(f.repo, tracked, 'export const tracked = true;\n');
  git(f.repo, 'add', '--', tracked);
  git(f.repo, 'commit', '--quiet', '-m', 'tracked fixture source');
  put(f.repo, untracked, 'export const untracked = true;\n');

  const executed = run(f);
  const result = reportFor(executed);

  assert.equal(executed.status, 0);
  assert.equal(result.files, 2);
  assert.equal(result.violations.length, 0);
  assert.equal(result.in_scope_untracked_judged, 1);
  assert.deepEqual(result.in_scope_untracked_paths, [untracked]);
  assert.deepEqual(result.refused_paths, []);
  assert.deepEqual(result.dangling_paths, []);
});

test('an untracked file symlink to outside the repository is refused without reading its target', (t) => {
  const f = fixture(t);
  const link = `${SOURCE}/outside-file.mjs`;
  const outsideFile = path.join(f.outside, 'outside.mjs');
  writeFileSync(outsideFile, `export const outside = '${SENTINEL}';\n`);
  mkdirSync(path.dirname(path.join(f.repo, link)), { recursive: true });
  symlinkSync(outsideFile, path.join(f.repo, link));

  const executed = run(f);
  const result = reportFor(executed);

  assert.equal(executed.status, 1);
  assert.equal(result.files, 0);
  assert.equal(result.violations.length, 0);
  assert.equal(result.in_scope_untracked_judged, 0);
  assert.deepEqual(result.refused_paths, [link]);
  assert.deepEqual(result.dangling_paths, []);
});

test('a tracked source path redirected through an outside parent symlink is refused', (t) => {
  const f = fixture(t);
  const tracked = `${SOURCE}/redirected.mjs`;
  put(f.repo, tracked, 'export const local = true;\n');
  git(f.repo, 'add', '--', tracked);
  git(f.repo, 'commit', '--quiet', '-m', 'tracked source before redirect');

  rmSync(path.join(f.repo, SOURCE), { recursive: true });
  const outsideSource = path.join(f.outside, 'redirected-source');
  mkdirSync(outsideSource, { recursive: true });
  writeFileSync(path.join(outsideSource, 'redirected.mjs'), `export const outside = '${SENTINEL}';\n`);
  symlinkSync(outsideSource, path.join(f.repo, SOURCE));

  const executed = run(f);
  const result = reportFor(executed);

  assert.equal(executed.status, 1);
  assert.equal(result.files, 0);
  assert.equal(result.violations.length, 0);
  assert.deepEqual(result.refused_paths, [tracked]);
});

test('a dangling symlink is reported separately and is not counted as judged', (t) => {
  const f = fixture(t);
  const dangling = `${SOURCE}/dangling.mjs`;
  mkdirSync(path.dirname(path.join(f.repo, dangling)), { recursive: true });
  symlinkSync(path.join(f.outside, 'not-created.mjs'), path.join(f.repo, dangling));

  const executed = run(f);
  const result = reportFor(executed);

  assert.equal(executed.status, 1);
  assert.equal(result.files, 0);
  assert.equal(result.in_scope_untracked_judged, 0);
  assert.deepEqual(result.in_scope_untracked_paths, []);
  assert.deepEqual(result.refused_paths, []);
  assert.deepEqual(result.dangling_paths, [dangling]);
});

test('a FIFO in scope is refused promptly instead of blocking the runner', (t) => {
  const f = fixture(t);
  const relativeFifo = `${SOURCE}/source-pipe.mjs`;
  const fifo = put(f.repo, relativeFifo, 'export const source = true;\n');
  git(f.repo, 'add', '--', relativeFifo);
  git(f.repo, 'commit', '--quiet', '-m', 'tracked source before FIFO replacement');
  rmSync(fifo);
  execFileSync('mkfifo', [fifo]);
  assert.ok(lstatSync(fifo).isFIFO());

  const executed = run(f);
  const result = reportFor(executed);

  assert.equal(executed.status, 1);
  assert.equal(result.files, 0);
  assert.equal(result.in_scope_untracked_judged, 0);
  assert.deepEqual(result.refused_paths, [relativeFifo]);
});

test('an internal source alias cannot evade path policy and an ordinary repair passes a fresh run', (t) => {
  const f = fixture(t);
  const target = `${SOURCE}/target.mjs`;
  const alias = `${SOURCE}/alias.mjs`;
  put(f.repo, target, 'export const local = true;\n');
  symlinkSync('target.mjs', path.join(f.repo, alias));
  const refused = run(f);
  assert.equal(refused.status, 1);
  assert.deepEqual(reportFor(refused).refused_paths, [alias]);
  rmSync(path.join(f.repo, alias));
  put(f.repo, alias, 'export const local = true;\n');
  const repaired = run(f);
  assert.equal(repaired.status, 0);
  const report = reportFor(repaired);
  assert.equal(report.files, 2);
  assert.equal(report.in_scope_untracked_judged, 2);
  assert.deepEqual(report.refused_paths, []);
  assert.deepEqual(report.dangling_paths, []);
});

test('a recorded baseline cannot turn refused source into a pass', (t) => {
  const f = fixture(t);
  const relative = `${SOURCE}/aliased.mjs`;
  put(f.repo, `${SOURCE}/ordinary.mjs`, 'export const local = true;\n');
  symlinkSync(path.join(f.outside, 'absent.mjs'), path.join(f.repo, relative));
  const recorded = path.join(f.outside, 'baseline.json');
  writeFileSync(recorded, JSON.stringify({known_findings: {}}));
  const executed = run(f, HANG_BOUND_MS, ['--recorded', recorded]);
  assert.equal(executed.status, 1);
  const report = reportFor(executed);
  assert.deepEqual(report.dangling_paths, [relative]);
  assert.deepEqual(report.ratchet.appeared, []);
  assert.deepEqual(report.ratchet.fixed, []);
});

test('a rule file that is a symlink cannot redirect the policy reader', (t) => {
  const f = fixture(t);
  const link = path.join(f.repo, 'rules-link.json');
  symlinkSync(f.rulesPath, link);
  const executed = spawnSync(process.execPath, [RUNNER, '--repo', f.repo, '--rules', link, '--json'], {
    encoding: 'utf8', timeout: HANG_BOUND_MS,
  });
  assert.ifError(executed.error);
  assert.notEqual(executed.status, 0);
  assert.match(executed.stderr, /source-rule policy unavailable/);
});

test('empty scope and conditions that match nothing cannot report a passing run', (t) => {
  const f = fixture(t);
  put(f.repo, 'other/ordinary.rs', 'pub fn ordinary() {}\n');
  let executed = run(f);
  assert.equal(executed.status, 1);
  let report = reportFor(executed);
  assert.equal(report.no_applicable_rule, true);
  assert.equal(report.rule_coverage[0].applicable_files, 0);

  const conditional = JSON.parse(JSON.stringify(RULES));
  conditional.things[0].payload.applies_when = {content_matches: 'CONDITION_NOT_PRESENT'};
  writeFileSync(f.rulesPath, JSON.stringify(conditional));
  put(f.repo, `${SOURCE}/ordinary.mjs`, 'export const local = true;\n');
  executed = run(f);
  assert.equal(executed.status, 1);
  report = reportFor(executed);
  assert.equal(report.files, 1);
  assert.equal(report.rule_coverage[0].scoped_files, 1);
  assert.equal(report.rule_coverage[0].applicable_files, 0);
  assert.equal(report.no_applicable_rule, true);
});

test('name-only rules inspect supplied asset aliases without reading them; regular-file policy still refuses aliases', (t) => {
  const f = fixture(t);
  const alias = `${SOURCE}/model.onnx`;
  mkdirSync(path.dirname(path.join(f.repo, alias)), {recursive: true});
  // A missing host-supplied model target is immaterial to a filename rule. No
  // payload presence, model validity or runtime eligibility is being certified.
  symlinkSync(path.join(f.outside, 'host-supplied-model.onnx'), path.join(f.repo, alias));
  const policy = JSON.parse(JSON.stringify(RULES));
  Object.assign(policy.things[0].payload, {subject: {named: 'path'}, scope: {path_matches: '\\.onnx$'},
    violation: {required: '\\.onnx$'}});
  writeFileSync(f.rulesPath, JSON.stringify(policy));
  let executed = run(f);
  assert.equal(executed.status, 0, executed.stderr);
  let report = reportFor(executed);
  assert.equal(report.files, 1);
  assert.equal(report.content_files, 0);
  assert.deepEqual(report.refused_paths, []);
  assert.deepEqual(report.dangling_paths, []);

  policy.things[0].payload.requires_regular_file = true;
  writeFileSync(f.rulesPath, JSON.stringify(policy));
  executed = run(f);
  assert.equal(executed.status, 1);
  report = reportFor(executed);
  assert.equal(report.files, 0);
  assert.deepEqual(report.dangling_paths, [alias]);
});

for (const replacement of ['fifo', 'symlink']) {
  test(`a ${replacement} replacement at the actual open is refused without blocking`, (t) => {
    const f = fixture(t);
    const relative = `${SOURCE}/swap.mjs`;
    const source = put(f.repo, relative, 'export const local = true;\n');
    const outside = path.join(f.outside, 'foreign.mjs');
    writeFileSync(outside, SENTINEL);
    const preload = path.join(f.outside, 'swap-at-open.mjs');
    writeFileSync(preload, `
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const target=fs.realpathSync(${JSON.stringify(source)}), original=fs.openSync;
let replaced=false;
fs.openSync=function(p,...args){
  if(String(p)===target&&!replaced){
    replaced=true;fs.unlinkSync(target);
    ${replacement === 'fifo' ? "execFileSync('mkfifo',[target]);" : `fs.symlinkSync(${JSON.stringify(outside)},target);`}
  }
  return original.call(this,p,...args);
};
syncBuiltinESMExports();
`);
    const executed = spawnSync(process.execPath, ['--import', preload, RUNNER,
      '--repo', f.repo, '--rules', f.rulesPath, '--json'], {encoding: 'utf8', timeout: HANG_BOUND_MS});
    assert.ifError(executed.error);
    assert.equal(executed.status, 1, executed.stderr);
    const report = reportFor(executed);
    assert.equal(report.files, 0);
    assert.deepEqual(report.refused_paths, [relative]);
    assert.deepEqual(report.violations, []);
  });
}
