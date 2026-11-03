// tools/check-every-tool-call: `check_switches.py run` as a repository's hook starts it, against a made-up door here.
// A door it cannot read is said on every call and refuses nothing; a row that applies runs, and its refusal refuses
// the call in its own words (exit 2, the reason on standard error, as the dispatcher answers); a row for another
// tool, another scope or an unmatched command does not run; a row marked Off still runs and the mark is said.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUNNER = resolve(import.meta.dirname, '..', 'do-work', 'check_switches.py');

function row(id, definition, value = {}) {
  return { id: `record:example-check:${id}`, type: 'record:example-check', value: { full_definition: JSON.stringify({ id, ...definition }), ...value } };
}

const ROWS = [
  row('refuses-a-commit', {
    on: [{ harness: 'claude', event: 'PreToolUse', tools: 'Bash', scope: 'every-repository' }],
    acts_on: { tools: 'Bash', fields: ['command'], matches: '\\bgit\\b.*\\bcommit\\b' },
    workshop_run: ['sh', '-c', 'echo "refused {tool_input.command}"; exit 1'],
    failure_policy: 'deny',
  }),
  row('only-on-the-home-computer', {
    on: [{ harness: 'claude', event: 'PreToolUse', tools: 'Bash', scope: 'home-computer' }],
    workshop_run: ['sh', '-c', 'exit 1'],
  }),
  row('only-for-edits', {
    on: [{ harness: 'claude', event: 'PreToolUse', tools: 'Edit', scope: 'every-repository' }],
    workshop_run: ['sh', '-c', 'exit 1'],
  }),
];

// A door answering records:list the way the person's door does, one page, to a request with the right key.
async function door(t, { status = 200, key = 'made-up-key', records = ROWS } = {}) {
  const server = createServer((request, response) => {
    if (status !== 200 || request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(status === 200 ? 401 : status, { 'content-type': 'application/json' });
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

function settings(t, url, door = { url }) {
  const folder = mkdtempSync(join(tmpdir(), 'check-every-tool-call-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'check-list.json');
  writeFileSync(file, JSON.stringify({
    door: { ...door, address: '@own-records', method: 'records:list', key_from: { env: 'EXAMPLE_CHECK_LIST_KEY' }, page: 100, timeout_seconds: 5 },
    types: [{ type: 'record:example-check', id_prefix: 'record:example-check:' }],
    field: 'on', off_value: 'Off', detail_fields: ['why_off'],
    snapshot: { file: 'check-switches.json', refresh_seconds: 60 },
    honour_off: false, harness: 'claude', scope: 'every-repository',
  }));
  return { file, state: join(folder, 'state') };
}

// The runner runs as its own process while this one keeps serving the made-up door.
async function call(where, event, key) {
  const child = spawn('python3', [RUNNER, 'run', where.file], {
    env: { ...process.env, CHECK_LIST_STATE: where.state, ...(key ? { EXAMPLE_CHECK_LIST_KEY: key } : {}) },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: tmpdir(), ...event }));
  const status = await new Promise((done) => child.on('close', done));
  return { status, stderr, answer: stdout.trim() ? JSON.parse(stdout) : {} };
}

async function allowed(where, event, key) {
  const { status, stderr, answer } = await call(where, event, key);
  assert.equal(status, 0, stderr);
  return answer;
}

test('with no key the list is unreachable: said on the call, nothing refused', async (t) => {
  const where = settings(t, await door(t));
  const answer = await allowed(where, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
  assert.match(answer.systemMessage, /^check list unreachable: no key/);
  assert.equal(answer.hookSpecificOutput, undefined);
});

test('a door that refuses the key is said with its status on every call', async (t) => {
  const where = settings(t, await door(t, { status: 401 }));
  for (let i = 0; i < 2; i += 1) {
    const answer = await allowed(where, { tool_name: 'Bash', tool_input: { command: 'ls' } }, 'made-up-key');
    assert.match(answer.systemMessage, /^check list unreachable: 401/);
    assert.equal(answer.hookSpecificOutput, undefined);
  }
});

test('a row that applies runs, and its refusal refuses the call in its own words', async (t) => {
  const where = settings(t, await door(t));
  const { status, stderr } = await call(where, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, 'made-up-key');
  assert.equal(status, 2);
  assert.match(stderr, /^refused git commit -m x$/m);
  assert.doesNotMatch(stderr, /unreachable/);
});

test('rows for another scope, another tool or an unmatched command do not run', async (t) => {
  const where = settings(t, await door(t));
  assert.deepEqual(await allowed(where, { tool_name: 'Bash', tool_input: { command: 'ls -la' } }, 'made-up-key'), {});
  assert.deepEqual(await allowed(where, { tool_name: 'Read', tool_input: { file_path: '/x' } }, 'made-up-key'), {});
});

test('a row marked Off still runs while Off is not honoured, and the mark is said', async (t) => {
  const records = ROWS.map((one, i) => (i === 0 ? { ...one, value: { ...one.value, on: 'Off', why_off: 'made-up reason' } } : one));
  const where = settings(t, await door(t, { records }));
  const { status, stderr } = await call(where, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, 'made-up-key');
  assert.equal(status, 2);
  assert.match(stderr, /ran anyway: refuses-a-commit is marked Off .*made-up reason/);
  assert.match(stderr, /^refused git commit -m x$/m);
});

test('the door can come from the environment, and without it the list is unreachable', async (t) => {
  const url = await door(t);
  const where = settings(t, url, { url_from: { env: 'EXAMPLE_CHECK_LIST_DOOR' } });
  const unnamed = await allowed(where, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, 'made-up-key');
  assert.match(unnamed.systemMessage, /^check list unreachable: no door/);
  const named = { ...where, state: `${where.state}-named` };
  process.env.EXAMPLE_CHECK_LIST_DOOR = url;
  t.after(() => { delete process.env.EXAMPLE_CHECK_LIST_DOOR; });
  const { status } = await call(named, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, 'made-up-key');
  assert.equal(status, 2);
});
