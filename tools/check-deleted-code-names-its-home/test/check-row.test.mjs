// The check row read-data/check-row.json, exactly as the person's Checks list holds it, run by the person's check list
// runner (tools/check-every-tool-call) on a `git commit` and a `git push` in made-up checkouts side by side: a deleted
// source or test file with no moved-from receipt and no retirement decision is refused in words; a receipt in a
// checkout beside it (by path, or by the identity of a private path), a receipt staged in the same commit, a
// retirement row that quotes a decision, a rename inside the tree, and a deleted document all pass. A retirement row
// with no decision does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { globCovers, isJudged, judgeDeletions, pathIdentity } from '../do-work/check-deleted-code-names-its-home.mjs';

const RUNNER = resolve(import.meta.dirname, '..', '..', 'check-every-tool-call', 'do-work', 'check_switches.py');
const ROW = JSON.parse(readFileSync(new URL('../read-data/check-row.json', import.meta.url), 'utf8'));
const TOOL = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload;

async function door(t, records) {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer made-up-key') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { records, next: null } } }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

function settings(t, url) {
  const folder = mkdtempSync(join(tmpdir(), 'deleted-code-settings-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'check-list.json');
  writeFileSync(file, JSON.stringify({
    door: { url, address: '@own-records', method: 'records:list', key_from: { env: 'MADE_UP_CHECK_LIST_KEY' }, page: 100, timeout_seconds: 5 },
    types: [{ type: 'record:check', id_prefix: 'record:check:' }],
    field: 'on', off_value: 'Off', detail_fields: ['why_off'],
    snapshot: { file: 'check-switches.json', refresh_seconds: 60 },
    honour_off: false, harness: 'claude', scope: 'every-repository',
  }));
  return { file, state: join(folder, 'state') };
}

async function call(where, root, command) {
  const child = spawn('python3', [RUNNER, 'run', where.file], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'CLAUDE_PROJECT_DIR')),
      CHECK_LIST_STATE: where.state, MADE_UP_CHECK_LIST_KEY: 'made-up-key' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Bash', tool_input: { command } }));
  const status = await new Promise((done) => child.on('close', done));
  return { status, stdout, stderr };
}

// Made-up checkouts beside each other in one folder, named as the rules name them.
function checkouts(t) {
  const parent = mkdtempSync(join(tmpdir(), 'deleted-code-checkouts-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const make = (name) => {
    const root = join(parent, name);
    mkdirSync(root);
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
    git('init', '-q', '-b', 'main');
    write('README.md', 'made-up\n');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'start');
    const commit = (message) => git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', message);
    return { root, git, write, commit };
  };
  return { old: make('trillion'), workshop: make('trillion-workshop') };
}

test('the row is a record:check row whose definition runs this judge on commit and push', () => {
  assert.equal(ROW.type, 'record:check');
  assert.match(ROW.id, /^record:check:/);
  const definition = JSON.parse(ROW.value.full_definition);
  assert.equal(definition.failure_policy, 'deny');
  assert.match('git commit -m x', new RegExp(definition.acts_on.matches));
  assert.match('git push -u origin main', new RegExp(definition.acts_on.matches));
  assert.equal(definition.workshop_run[1], '{tools}/check-deleted-code-names-its-home/do-work/check-deleted-code-names-its-home.mjs');
});

test('source and test files are judged; documents and data beside them are not', () => {
  for (const path of ['src/a.mjs', 'macos/App/A.swift', 'crates/x/src/lib.rs', 'test/a.test.mjs', 'crates/x/fuzz/corpus/t/00ab', 'test/fixtures/page.html'])
    assert.ok(isJudged(path), path);
  for (const path of ['README.md', 'docs/plan.md', 'records/rows.json']) assert.ok(!isJudged(path), path);
  assert.ok(globCovers('macos', 'macos/App/A.swift'));
  assert.ok(globCovers('src/*.mjs', 'src/a.mjs'));
  assert.ok(!globCovers('src/*.mjs', 'src/x/a.mjs'));
  assert.ok(globCovers('src/**/a.mjs', 'src/x/y/a.mjs'));
});

test('a commit deleting code with no home is refused; a receipt beside it lets it through', async (t) => {
  const where = settings(t, await door(t, [ROW]));
  const { old, workshop } = checkouts(t);
  old.write('computer/model-relay.mjs', 'export const relay = 1;\n');
  old.write('test/model-relay.test.mjs', "import '../computer/model-relay.mjs';\n");
  old.git('add', '-A');
  old.commit('add');
  old.git('rm', '-q', 'computer/model-relay.mjs', 'test/model-relay.test.mjs');

  const refused = await call(where, old.root, 'git commit -m "drop dead code"');
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /2 deleted source or test file\(s\) name no new home and no retirement decision/);
  assert.match(refused.stderr, /computer\/model-relay\.mjs: no moved-from\.json/);
  assert.match(refused.stderr, /test\/model-relay\.test\.mjs: no moved-from\.json/);

  // The destination carries the receipt (written by tools/move-code-between-trees): one file by path, one by the
  // identity of its path, as a public tree names a private source.
  workshop.write('tools/models-on-this-computer/moved-from.json', JSON.stringify({ source: 'trillion', files: [
    { from: 'computer/model-relay.mjs', commit: 'made-up', to: 'tools/models-on-this-computer/computer/model-relay.mjs' },
    { from_path_identity: pathIdentity('test/model-relay.test.mjs'), to: 'tools/models-on-this-computer/test/model-relay.test.mjs' },
  ] }));
  workshop.git('add', '-A');
  workshop.commit('move');
  const passed = await call(where, old.root, 'git commit -m "moved to the Workshop"');
  assert.equal(passed.status, 0, passed.stderr);
});

test('a receipt from another repository does not name this one\'s file', async (t) => {
  const { old, workshop } = checkouts(t);
  old.write('src/a.mjs', 'export const a = 1;\n');
  old.git('add', '-A');
  old.commit('add');
  old.git('rm', '-q', 'src/a.mjs');
  workshop.write('tools/x/moved-from.json', JSON.stringify({ source: 'trillion-apps', files: [{ from: 'src/a.mjs', to: 'tools/x/src/a.mjs' }] }));
  const result = judgeDeletions({ root: old.root, span: { staged: true } });
  assert.equal(result.valid, false);
  assert.deepEqual(result.unread.sort(), ['trillion-apps: no checkout at ' + join(dirname(old.root), 'trillion-apps'), 'trillion-rust: no checkout at ' + join(dirname(old.root), 'trillion-rust')]);
});

test('a retirement row passes only when it quotes the decision; a rename and a deleted document pass', async (t) => {
  const where = settings(t, await door(t, [ROW]));
  const { old } = checkouts(t);
  old.write('src/backup-ai.mjs', 'export const backup = 1;\n');
  old.write('src/kept.mjs', 'export const kept = 1;\n');
  old.write('docs/notes.md', 'made-up\n');
  old.git('add', '-A');
  old.commit('add');

  old.git('rm', '-q', 'src/backup-ai.mjs');
  old.write('retired-paths.json', JSON.stringify({ retired: [{ path: 'src/backup-ai.mjs', tag: 'retired/backup-ai-2026-11-04', reason: 'nothing imports it' }] }));
  old.git('add', 'retired-paths.json');
  const undecided = await call(where, old.root, 'git commit -m retire');
  assert.equal(undecided.status, 2, undecided.stderr);
  assert.match(undecided.stderr, /src\/backup-ai\.mjs: no moved-from\.json/);

  old.write('retired-paths.json', JSON.stringify({ retired: [{ path: 'src/backup-ai.mjs', tag: 'retired/backup-ai-2026-11-04',
    reason: 'one routing for waiting work',
    decision: { by: 'a made-up owner', words: 'Waiting work goes to my own AIs in my order; there is no backup AI.', source: 'made-up-decision-1' } }] }));
  old.git('add', 'retired-paths.json');
  const decided = await call(where, old.root, 'git commit -m retire');
  assert.equal(decided.status, 0, decided.stderr);
  old.commit('retire');

  old.git('mv', 'src/kept.mjs', 'src/kept-here.mjs');
  old.git('rm', '-q', 'docs/notes.md');
  const moved = await call(where, old.root, 'git commit -m "rename and drop a note"');
  assert.equal(moved.status, 0, moved.stderr);
  const judged = judgeDeletions({ root: old.root, span: { staged: true } });
  assert.deepEqual(judged.judged, [{ path: 'src/kept.mjs', home: { repository: 'trillion', path: 'src/kept-here.mjs' }, how: 'renamed in the same change' }]);
});

test('a receipt staged in the same commit counts, and a push is judged over the commits it publishes', async (t) => {
  const where = settings(t, await door(t, [ROW]));
  const { workshop } = checkouts(t);
  workshop.write('tools/old-place/do-work/a.mjs', 'export const a = 1;\n');
  workshop.git('add', '-A');
  workshop.commit('add');
  workshop.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  workshop.git('mv', 'tools/old-place/do-work/a.mjs', 'tools/new-place-a.mjs');
  workshop.write('tools/new-place-a.mjs', 'export const a = 2; // changed past what git calls a rename\nexport const more = [1, 2, 3, 4, 5, 6, 7, 8];\n');
  workshop.write('tools/moved-from.json', JSON.stringify({ source: 'trillion-workshop', files: [{ from: 'tools/old-place/do-work/a.mjs', to: 'tools/new-place-a.mjs' }] }));
  workshop.git('add', '-A');
  assert.equal((await call(where, workshop.root, 'git commit -m move')).status, 0);
  workshop.commit('move');

  workshop.write('tools/b.mjs', 'export const b = 1;\n');
  workshop.git('add', '-A');
  workshop.commit('add b');
  workshop.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  workshop.git('rm', '-q', 'tools/b.mjs');
  workshop.commit('drop b');
  const pushed = await call(where, workshop.root, 'git push -u origin main');
  assert.equal(pushed.status, 2, pushed.stderr);
  assert.match(pushed.stderr, /tools\/b\.mjs: no moved-from\.json/);
});

test('the tool row judges a range in the checkout the person granted, and answers { result }', (t) => {
  const { old } = checkouts(t);
  old.write('src/a.mjs', 'export const a = 1;\n');
  old.git('add', '-A');
  old.commit('add');
  const start = old.git('rev-parse', 'HEAD');
  old.git('rm', '-q', 'src/a.mjs');
  old.commit('drop a');
  // The row's own argv, with /opt/<package> read as this tree's tools folder and the grant as the checkout.
  const tools = resolve(import.meta.dirname, '..', '..');
  const argv = TOOL.invoke.argv.map((one) => typeof one === 'string' ? one.replace(/^\/opt\//, `${tools}/`) : old.root);
  const run = (input) => spawnSync(argv[0], argv.slice(1), { input: JSON.stringify(input), encoding: 'utf8' });

  const refused = run({ range: `${start}..HEAD` });
  assert.equal(refused.status, 1, refused.stderr);
  const { result } = JSON.parse(refused.stdout);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /src\/a\.mjs: no moved-from\.json/);
  assert.equal(run({ range: `${start}..${start}` }).status, 0);

  const wrong = run({ range: 'HEAD; rm -rf /' });
  assert.equal(wrong.status, 2);
  assert.match(JSON.parse(wrong.stdout).error, /give range/);
});
