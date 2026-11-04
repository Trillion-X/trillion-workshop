// tools/check-every-tool-call: the person's check rows (record:check, kind check) judge commits, pushes and other tool
// calls through the one judge (tools/check-against-a-persons-rules-and-verdicts rules mode), read from a made-up door
// that answers records:list by type and `where`, as the person's door does. A row's fixtures are its tests: each pass
// fixture passes the row alone and each refuse fixture is refused, and a call that writes a row whose fixtures do not
// hold is refused. Every row, file and value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { addedLines, fixturesHold, fixtureUnit, judgeACall, unitsOfToolCall } from '../do-work/judge-check-rows.mjs';

const RUNNER = resolve(import.meta.dirname, '..', 'do-work', 'check_switches.py');
const JUDGE = resolve(import.meta.dirname, '..', 'do-work', 'judge-check-rows.mjs');
const SETTINGS = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'read-data', 'settings.json'), 'utf8'));

// A made-up row in the shape of the person's real one: a protocol literal is a bounded namespace or a media type, or one
// of the two literals the row names by their definitions.
const LITERALS = {
  id: 'protocol-literals-named-by-their-definition', kind: 'check', part_of: 'made-up-branch', method: 'made-up-branch',
  kinds: ['git-commit', 'git-push'],
  says: 'A protocol literal is a bounded namespace (name:...) or a media type (type/subtype); any other literal is named by its definition here.',
  path: 'capabilities.*.protocol_literals.*',
  where_pattern: '^(?![a-z][a-z0-9_.-]*(?::[a-z0-9_./-]*\\*?|/[a-z0-9_.+-]+)$)',
  allow_exact: ['public-key', 'trp_*'],
  definitions: { 'public-key': 'WebAuthn PublicKeyCredentialType', 'trp_*': "the engine's computer-proof token prefix" },
  fixtures: { pass: ['public-key', 'trp_*', 'record:check'], refuse: ['foo', 'key'] },
};
const WORD = { id: 'made-up-no-zorblax', kind: 'check', kinds: ['git-commit'], words: ['zorblax'], says: 'Zorblax is not a word; say what it is.',
  fixtures: { pass: ['a plain line'], refuse: ['the zorblax line'] } };
const READ_BY_A_MODEL = { id: 'made-up-reads-well', kind: 'check', kinds: ['git-commit'], says: 'The commit message reads well to a new reader.' };
const OFF = { id: 'made-up-switched-off', kind: 'check', kinds: ['git-commit'], words: ['plain'], says: 'Never plain.', on: 'Off',
  fixtures: { pass: ['x'], refuse: ['plain'] } };
const TOOL_CALL = { id: 'made-up-no-secret-path', kind: 'check', kinds: ['tool-call'], pattern: '/made-up-secrets/', says: 'Leave the made-up secrets folder alone.',
  fixtures: { pass: ['/tmp/x'], refuse: ['/made-up-secrets/a'] } };

test('the made-up literal row: its fixtures hold, each judged from the row alone', () => {
  const held = fixturesHold(LITERALS);
  assert.deepEqual(held, { id: LITERALS.id, holds: true, checked: 5, wrong: [] });
  assert.deepEqual(fixtureUnit(LITERALS, 'foo'), { kind: 'git-commit', view: { capabilities: { fixture: { protocol_literals: { fixture: 'foo' } } } } });
});

test('allow (a substring of a whole text) cannot say the row: a view has no text, so the literals it names are refused', () => {
  const { allow_exact: named, ...rest } = LITERALS;
  const held = fixturesHold({ ...rest, allow: named });
  assert.equal(held.holds, false);
  assert.deepEqual(held.wrong.map(one => [one.expected, one.fixture, one.got]), [['pass', 'public-key', 'refused'], ['pass', 'trp_*', 'refused']]);
});

test('a row whose fixtures do not hold, a row with none, a row that cannot compile and a row read by a model', () => {
  const wrong = fixturesHold({ ...WORD, fixtures: { pass: ['the zorblax line'], refuse: ['a plain line'] } });
  assert.equal(wrong.holds, false);
  assert.deepEqual(wrong.wrong.map(one => one.got), ['refused', 'passed']);
  assert.equal(fixturesHold({ ...WORD, fixtures: { pass: ['x'] } }).no_fixtures, true);
  assert.match(fixturesHold({ ...WORD, words: undefined, pattern: '(' }).broken, /Invalid regular expression|Unterminated/);
  assert.deepEqual(fixturesHold(READ_BY_A_MODEL), { id: READ_BY_A_MODEL.id, holds: null, read_by_a_model: true, checked: 0, wrong: [] });
});

test('added lines of a diff are one text unit each, with the file and the line they land on', () => {
  const diff = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1,0 +4,2 @@', '+one', '++++ b/not-a-header', '@@ -9 +9,0 @@', '-gone',
    'diff --git a/b.txt b/b.txt', '--- a/b.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-deleted'].join('\n');
  assert.deepEqual(addedLines(diff, 'git-commit'), [{ kind: 'git-commit', text: 'one', where: 'a.txt', line: 4 },
    { kind: 'git-commit', text: '+++ b/not-a-header', where: 'a.txt', line: 5 }]);
  assert.deepEqual(unitsOfToolCall({ tool_name: 'Read', tool_input: { file_path: '/x' } }).map(unit => unit.where), ['Read', 'Read.file_path']);
});

test('a tool call that writes a check row whose fixtures do not hold is refused; one whose fixtures hold is not', () => {
  const write = row => ({ tool_name: 'mcp__made_up__run_resource_operation', tool_input: { method: 'records:put', input: { id: `record:check:${row.id}`, value: row } } });
  const bad = judgeACall({ rows: [], event: write({ ...WORD, fixtures: { pass: ['the zorblax line'], refuse: ['a plain line'] } }), kind: 'tool-call' });
  assert.equal(bad.code, 2);
  assert.match(bad.refused.join('\n'), /writes a check row whose fixtures do not hold[\s\S]*made-up-no-zorblax[\s\S]*pass "the zorblax line": refused/);
  assert.equal(judgeACall({ rows: [], event: write(WORD), kind: 'tool-call' }).code, 0);
  // in JSON text too, as a command line or a file may carry it
  const asText = { tool_name: 'Bash', tool_input: { command: JSON.stringify({ ...LITERALS, fixtures: { pass: ['foo'], refuse: ['public-key'] } }) } };
  assert.equal(judgeACall({ rows: [], event: asText, kind: 'tool-call' }).code, 2);
});

// ---- through the runner, as a repository's hook starts it

// A door answering records:list by type and `where`, one page, to a request with the right key; it keeps what it was asked.
async function door(t, records) {
  const asked = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.headers.authorization !== 'Bearer made-up-key') {
      response.writeHead(401).end('{}');
      return;
    }
    const input = JSON.parse(body).params.arguments.input;
    asked.push(input);
    const kept = records.filter(record => record.type === input.type
      && Object.entries(input.where ?? {}).every(([field, value]) => record.value?.[field] === value));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { records: kept, next: null } } }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, asked };
}

const record = row => ({ id: `record:check:${row.id}`, type: 'record:check', value: row });

// This tool's own settings, with the made-up door and key.
function settings(t, url) {
  const folder = mkdtempSync(join(tmpdir(), 'check-rows-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  writeFileSync(file, JSON.stringify({ ...SETTINGS, door: { ...SETTINGS.door, url, url_from: undefined, key_from: { env: 'MADE_UP_CHECK_LIST_KEY' } } }));
  return { file, state: join(folder, 'state') };
}

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'check-rows-repository-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  git('init', '-q', '-b', 'main');
  write('README.md', 'made-up\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  return { root, git, write };
}

async function call(where, event) {
  const child = spawn('python3', [RUNNER, 'run', where.file], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'CLAUDE_PROJECT_DIR')),
      CHECK_LIST_STATE: where.state, MADE_UP_CHECK_LIST_KEY: 'made-up-key' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', ...event }));
  const status = await new Promise(done => child.on('close', done));
  return { status, stderr, answer: stdout.trim() ? JSON.parse(stdout) : {} };
}

const capabilities = literals => `${JSON.stringify({ capabilities: [{ capability: 'made-up job', protocol_literals: literals }] }, null, 2)}\n`;
const bash = (root, command) => ({ cwd: root, tool_name: 'Bash', tool_input: { command } });

test('the runner reads check rows with the door\'s where, and a staged capabilities.json holding "foo" is refused from the row alone', async (t) => {
  const { url, asked } = await door(t, [record(LITERALS), { id: 'record:check:made-up-step', type: 'record:check', value: { kind: 'step', says: 'a step' } }]);
  const where = settings(t, url);
  const { root, git, write } = repository(t);
  write('capabilities.json', capabilities(['public-key', 'trp_*', 'record:check', 'application/json']));
  git('add', '-A');
  const passed = await call(where, bash(root, 'git commit -m literals'));
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(passed.answer, {});
  assert.ok(asked.some(input => input.type === 'record:check' && JSON.stringify(input.where) === JSON.stringify({ kind: 'check' })), 'check rows are read with where { kind: "check" }');
  write('capabilities.json', capabilities(['public-key', 'foo']));
  git('add', '-A');
  const refused = await call(where, bash(root, 'git add -A && git commit -m literals'));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refuse this git-commit/);
  assert.match(refused.stderr, /protocol-literals-named-by-their-definition: capabilities\.json: "foo": A protocol literal is a bounded namespace/);
  assert.doesNotMatch(refused.stderr, /public-key/);
  // a call that publishes nothing is not judged by a commit row
  assert.deepEqual((await call(where, bash(root, 'ls -la'))).answer, {});
});

test('a push is judged over the commits it publishes, from where HEAD left origin/main', async (t) => {
  const where = settings(t, (await door(t, [record(LITERALS)])).url);
  const { root, git, write } = repository(t);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  write('capabilities.json', capabilities(['key']));
  git('add', '-A');
  git('commit', '-q', '-m', 'a literal');
  const refused = await call(where, bash(root, 'git push -u origin main'));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refuse this git-push[\s\S]*capabilities\.json: "key"/);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal((await call(where, bash(root, 'git push'))).status, 0);
});

test('word rows judge added lines; a row read by a model and a row marked Off are said, never refused', async (t) => {
  const where = settings(t, (await door(t, [record(WORD), record(READ_BY_A_MODEL), record(OFF), record(TOOL_CALL)])).url);
  const { root, git, write } = repository(t);
  write('notes.md', 'a plain line\n');
  git('add', '-A');
  const passed = await call(where, bash(root, 'git commit -m notes'));
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.answer.systemMessage, /made-up-reads-well is read by a model only .*reads well to a new reader/);
  assert.match(passed.answer.systemMessage, /made-up-switched-off is marked Off/);
  write('notes.md', 'a plain line\nthe zorblax line\n');
  git('add', '-A');
  const refused = await call(where, bash(root, 'git commit -am notes'));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /made-up-no-zorblax: notes\.md:2: "zorblax": Zorblax is not a word/);
  assert.doesNotMatch(refused.stderr, /Never plain/);
  // a tool-call row judges any other call, and only it
  const read = await call(where, { cwd: root, tool_name: 'Read', tool_input: { file_path: '/made-up-secrets/a' } });
  assert.equal(read.status, 2);
  assert.match(read.stderr, /made-up-no-secret-path: Read\.file_path: "\/made-up-secrets\/"/);
});

test('a check row whose fixtures do not hold is said on every call it is kept for, and still judged', async (t) => {
  const wrong = { ...WORD, fixtures: { pass: ['the zorblax line'], refuse: ['a plain line'] } };
  const where = settings(t, (await door(t, [record(wrong)])).url);
  const { root, git, write } = repository(t);
  write('notes.md', 'fine\n');
  git('add', '-A');
  const said = await call(where, bash(root, 'git commit -m notes'));
  assert.equal(said.status, 0, said.stderr);
  assert.match(said.answer.systemMessage, /made-up-no-zorblax: its fixtures do not hold[\s\S]*pass "the zorblax line": refused/);
});

test('the fixtures command is the row tool:check-a-check-rows-fixtures: { rows } in, { result } out', () => {
  const run = input => JSON.parse(execFileSync('node', [JUDGE, 'fixtures'], { input: JSON.stringify(input), encoding: 'utf8' }).trim().split('\n').at(-1));
  const { result } = run({ rows: [LITERALS, { ...WORD, fixtures: { pass: ['x'], refuse: ['y'] } }] });
  assert.equal(result.holds, false);
  assert.deepEqual(result.rows.map(row => row.holds), [true, false]);
  assert.match(result.lines.join('\n'), /refuse "y": passed/);
});

test('the row runs as the container runs it, with only the files it packs, and answers for the literal row', async () => {
  const row = rowOf(JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'tool-rows.json'), 'utf8')), 'tool:check-a-check-rows-fixtures');
  const answer = await answerOf(row, { rows: [LITERALS, { ...LITERALS, id: 'made-up-wrong', fixtures: { pass: ['foo'], refuse: ['key'] } }] });
  assert.equal(answer.status, 0);
  assert.equal(answer.result.holds, false);
  assert.deepEqual(answer.result.rows.map(one => [one.id, one.holds]), [[LITERALS.id, true], ['made-up-wrong', false]]);
});
