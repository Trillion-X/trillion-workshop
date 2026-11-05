// The record:hook-guard row that wires this judge, run by tools/check-every-tool-call `check_switches.py run` the way
// a repository's hook starts it, against a made-up door: a Write to /tmp is refused in the judge's words (exit 2),
// a Write to the repository's source and an ordinary command pass in silence, and a judge that cannot run refuses
// nothing (failure_policy is not "deny").
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUNNER = resolve(import.meta.dirname, '..', '..', 'check-every-tool-call', 'do-work', 'check_switches.py');
const ROW = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'read-data', 'hook-guard-row.json'), 'utf8'));

async function door(t, records) {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { records, next: null } } }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

function settings(t, url) {
  const folder = mkdtempSync(join(tmpdir(), 'check-where-work-is-kept-settings-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'check-list.json');
  writeFileSync(file, JSON.stringify({
    door: { url, address: '@own-records', method: 'records:list', key_from: { env: 'EXAMPLE_CHECK_LIST_KEY' }, page: 100, timeout_seconds: 5 },
    types: [{ type: 'record:hook-guard', id_prefix: 'record:hook-guard:' }],
    field: 'on', off_value: 'Off', detail_fields: ['why_off'],
    snapshot: { file: 'check-switches.json', refresh_seconds: 60 },
    honour_off: false, harness: 'claude', scope: 'every-repository',
  }));
  return { file, state: join(folder, 'state') };
}

async function call(where, event, home) {
  const child = spawn('python3', [RUNNER, 'run', where.file], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'CLAUDE_PROJECT_DIR')),
      HOME: home, CHECK_LIST_STATE: where.state, EXAMPLE_CHECK_LIST_KEY: 'made-up-key' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', ...event }));
  const status = await new Promise((done) => child.on('close', done));
  return { status, stdout, stderr };
}

function checkout(t, home) {
  // A checkout of a repository the row's rules declare, so its source passes.
  const root = join(home, 'code', 'trillion-workshop');
  mkdirSync(join(root, 'tools'), { recursive: true });
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/Trillion-X/trillion-workshop.git']);
  writeFileSync(join(root, 'tools', 'reader.mjs'), 'x\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  return root;
}

test('the hook-guard row given to the lead: a Write to /tmp is refused naming the list and records:write; source passes', async (t) => {
  const definition = JSON.parse(ROW.value.full_definition);
  assert.equal(ROW.type, 'record:hook-guard');
  assert.deepEqual(definition.on, [{ harness: 'claude', event: 'PreToolUse', tools: 'Write|Edit|Bash', scope: 'every-repository' }]);
  assert.notEqual(definition.failure_policy, 'deny');
  const home = mkdtempSync(join(tmpdir(), 'check-where-work-is-kept-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = checkout(t, home);
  const where = settings(t, await door(t, [ROW]));
  const refused = await call(where, { cwd: root, tool_name: 'Write', tool_input: { file_path: '/tmp/plan.md', content: 'the plan' } }, home);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /never onto disk/);
  assert.match(refused.stderr, /Keep it in list:notes instead: records:write \{"records":\[\{"id":"record:note:plan","type":"record:note"/);
  const memory = await call(where, { cwd: root, tool_name: 'Bash', tool_input: { command: 'echo remember > ~/.claude/projects/x/memory/MEMORY.md' } }, home);
  assert.equal(memory.status, 2, memory.stderr);
  assert.match(memory.stderr, /Keep it in list:memories instead/);
  for (const event of [
    { cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, 'tools', 'reader.mjs'), content: 'y\n' } },
    { cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'tools', 'reader.mjs'), old_string: 'x', new_string: 'y' } },
    { cwd: root, tool_name: 'Bash', tool_input: { command: 'mkdir -p .git/scratch && git status > .git/scratch/status.txt 2>/dev/null' } },
    { cwd: root, tool_name: 'Read', tool_input: { file_path: '/tmp/anything' } },
  ]) {
    const passed = await call(where, event, home);
    assert.equal(passed.status, 0, `${JSON.stringify(event)}: ${passed.stderr}`);
  }
});
