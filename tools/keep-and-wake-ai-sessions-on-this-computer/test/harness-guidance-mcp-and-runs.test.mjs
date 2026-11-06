// Ported from old trillion test/harness-guidance-mcp-and-runs.test.mjs (tag old-trillion-before-worker-retire,
// b6ae0ebf81), deleted by Trillion-X/trillion #243. The harness scripts are this tool's; the client catalogue is
// tools/set-up-my-account/read-data/ai-clients.json and report-progress is tools/run-on-a-persons-computer's (old
// computer/). The first test's setup answer (old src/setup-installs.mjs harnessSetup, not moved: tools/set-up-my-account
// README) is this tool's row tool:connect-an-ai-app-on-this-computer-to-trillion now, so its command checks read that
// row: the four actions and no --mcp-url. Left out: that the register command names 'claude-code,codex' by default and
// not gemini-cli or cursor; the row takes the apps from the caller and lists all four (this folder's README, "Rows").
// Every other assertion is the old one.
// test/harness-guidance-mcp-and-runs.test.mjs
//
// Two harness mechanisms on a pretend home:
// - Trillion's MCP entry in other AIs' configs only through the person's explicit action, with a preview that writes
//   nothing, a per-app result, a review hash that refuses a changed plan, custom entries left, and unregister
//   (harness/mcp-registration.mjs through setup.mjs);
// - a woken session's CLI event stream normalised to text / thinking / tool_start / tool_done / reply, kept as the
//   progress file report-progress shows, and the workspace allow-list passed as the CLI's own flag
//   (harness/session-runs.mjs, harness/wake-handlers/wake-named-session.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineDiff, registerMcp, tomlTable } from '../harness/mcp-registration.mjs';
import { settings as setupRules } from '../harness/setup.mjs';
import aiClients from '../../set-up-my-account/read-data/ai-clients.json' with { type: 'json' };
import toolRows from '../tool-rows.json' with { type: 'json' };
import { clearWorkspaceTools, eventsOfLine, lineSplitter, progressKeeper, runArgv, setWorkspaceTools, workspaceTools } from '../harness/session-runs.mjs';
import { loadHandlers, makeHelper, registerSession, settings as wakeRules } from '../harness/wake-sessions.mjs';
import progressRules from '../../run-on-a-persons-computer/report-progress.json' with { type: 'json' };
import { reportOf } from '../../run-on-a-persons-computer/report-progress.mjs';

const tempHome = t => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trillion-harness-'))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
// ---- F-0578 MCP registration --------------------------------------------------------------------------------------
const URL_ = 'https://app.gettrillion.ai/mcp';
test('every registration row is an AI app the connect catalogue knows, and the setup answer offers the four commands', () => {
  const ids = aiClients.clients.map(row => row.id);
  for (const row of setupRules.mcp_registration.clients) assert.ok(ids.includes(row.id), `${row.id} is a src/ai-clients.json client`);
  // The setup answer is this tool's row now (tool-rows.json, tool:connect-an-ai-app-on-this-computer-to-trillion): its
  // action is one of the four commands, run through harness/setup.mjs with no --mcp-url.
  const row = toolRows.records.map(record => record.payload).find(payload => payload.id === 'tool:connect-an-ai-app-on-this-computer-to-trillion');
  assert.deepEqual(row.input_schema.properties.action.enum.map(action => action.replace(/^mcp-/, '')), ['inspect', 'preview', 'register', 'unregister']);
  assert.match(row.invoke.run, /--action \{action\} --client \{client\}/);
  assert.doesNotMatch(row.invoke.run, /--mcp-url/);
  assert.match(setupRules.boundaries.find(row => row.id === 'mcp').reason, /only by the person's own explicit --action mcp-register/);
});

test('preview writes nothing; register writes each named app once with per-app results; unregister takes it out', t => {
  const home = tempHome(t);
  for (const folder of ['.claude', '.codex', '.cursor']) mkdirSync(join(home, folder));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { other: { url: 'https://x.test' } } }, null, 2));
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  const call = (action, extra = {}) => registerMcp({ action, clients: 'claude-code,codex,cursor,gemini-cli', home, env: {}, rules: setupRules, ...extra });
  const before = ['.claude.json', '.codex/config.toml'].map(file => readFileSync(join(home, file), 'utf8'));
  const preview = call('mcp-preview');
  assert.deepEqual(preview.results.map(row => [row.client, row.now]), [['claude-code', 'absent'], ['codex', 'absent'], ['cursor', 'absent'], ['gemini-cli', 'not_installed']]);
  assert.deepEqual(preview.results[1].diff.added, [
    '[mcp_servers.trillion]',
    'command = "/Applications/Trillion.app/Contents/MacOS/node"',
    'args = ["/Applications/Trillion.app/Contents/Resources/harness/keychain-mcp-bridge.mjs"]',
    '',
  ]);
  assert.deepEqual(['.claude.json', '.codex/config.toml'].map(file => readFileSync(join(home, file), 'utf8')), before, 'preview wrote nothing');
  assert.equal(existsSync(join(home, '.cursor', 'mcp.json')), false);
  // A plan reviewed earlier no longer matches once a file changed: nothing is written.
  writeFileSync(join(home, '.codex', 'config.toml'), before[1] + '# edited\n');
  const refused = call('mcp-register', { reviewed: preview.review_hash });
  assert.match(refused.refused, /changed since the reviewed preview/);
  assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before[0]);
  const fresh = call('mcp-preview');
  const done = call('mcp-register', { reviewed: fresh.review_hash });
  assert.deepEqual(done.results.map(row => [row.client, row.result]), [['claude-code', 'registered'], ['codex', 'registered'], ['cursor', 'registered'], ['gemini-cli', 'not_installed']]);
  const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(claude, { numStartups: 3, mcpServers: { other: { url: 'https://x.test' }, trillion: {
    command: '/Applications/Trillion.app/Contents/MacOS/node',
    args: ['/Applications/Trillion.app/Contents/Resources/harness/keychain-mcp-bridge.mjs'],
  } } });
  assert.ok(done.results[0].backup && existsSync(done.results[0].backup), 'the earlier bytes are kept');
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), `${before[1]}# edited\n\n[mcp_servers.trillion]\ncommand = "/Applications/Trillion.app/Contents/MacOS/node"\nargs = ["/Applications/Trillion.app/Contents/Resources/harness/keychain-mcp-bridge.mjs"]\n`);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')), { mcpServers: { trillion: { url: URL_ } } });
  assert.ok(done.results.every(row => row.sign_in), 'every result names the sign-in still to do');
  assert.deepEqual(call('mcp-register').results.map(row => row.result), ['already_registered', 'already_registered', 'already_registered', 'not_installed']);
  assert.deepEqual(call('mcp-inspect').results.map(row => row.now), ['registered', 'registered', 'registered', 'not_installed']);
  const gone = call('mcp-unregister');
  assert.deepEqual(gone.results.map(row => row.result), ['removed', 'removed', 'removed', 'not_installed']);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')), { numStartups: 3, mcpServers: { other: { url: 'https://x.test' } } });
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), `${before[1]}# edited\n`);
  assert.deepEqual(call('mcp-unregister').results.map(row => row.result), ['already_absent', 'already_absent', 'already_absent', 'not_installed']);
});

test("a same-named entry pointing elsewhere is the person's own and is never changed or removed; odd TOML is blocked", t => {
  const home = tempHome(t);
  mkdirSync(join(home, '.cursor')); mkdirSync(join(home, '.codex'));
  const mine = { mcpServers: { trillion: { url: 'https://my-proxy.test/mcp', headers: { a: 'b' } } } };
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify(mine));
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers]\ntrillion = { url = "x" }\n');
  const done = registerMcp({ action: 'mcp-register', clients: 'cursor,codex', home, env: {}, rules: setupRules });
  assert.deepEqual(done.results.map(row => [row.client, row.result]), [['cursor', 'custom'], ['codex', 'blocked']]);
  assert.deepEqual(registerMcp({ action: 'mcp-unregister', clients: 'cursor', home, env: {}, rules: setupRules }).results[0].result, 'custom');
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')), mine);
  // Trillion's own entry keeps every extra field the person added when it is updated.
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { trillion: { url: URL_, headers: { a: 'b' }, type: 'old' } } }));
  assert.equal(registerMcp({ action: 'mcp-register', clients: 'cursor', home, env: {}, rules: setupRules }).results[0].result, 'already_registered');
  assert.throws(() => registerMcp({ action: 'mcp-register', clients: 'nobody', home, env: {}, rules: setupRules }), /No MCP registration row/);
  assert.throws(() => registerMcp({ action: 'mcp-register', clients: 'cursor', url: 'http://plain.test/mcp', home, env: {}, rules: setupRules }), /https/);
  const table = tomlTable('[mcp_servers.trillion]\nurl = "u"\n\n[mcp_servers.trillion.env]\nA = "1"\n[other]\nb = 2\n', ['mcp_servers'], 'trillion');
  assert.deepEqual([table.state, table.from, table.mainTo, table.to, table.fields], ['found', 0, 3, 5, { url: 'u' }]);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nX\nc'), { at_line: 2, removed: ['b'], added: ['X'] });
});

test('the setup command runs the explicit action end to end on a pretend home', t => {
  const home = tempHome(t); mkdirSync(join(home, '.cursor'));
  const setupPath = fileURLToPath(new URL('../harness/setup.mjs', import.meta.url));
  const run = action => JSON.parse(execFileSync(process.execPath, [setupPath, '--action', action, '--client', 'cursor'], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  assert.equal(run('mcp-preview').results[0].now, 'absent');
  assert.equal(run('mcp-register').results[0].result, 'registered');
  assert.equal(run('mcp-unregister').results[0].result, 'removed');
});

// ---- F-0573 event normalisation and workspace allow-list -----------------------------------------------------------
const claudeStream = wakeRules.harnesses['claude-code'].stream;
const codexStream = wakeRules.harnesses.codex.stream;
test("each CLI's own stream lines become the same normalised events", () => {
  const claudeLines = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'plan it' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Read' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { type: 'result', result: 'All done.' },
  ].map(line => JSON.stringify(line));
  assert.deepEqual([...claudeLines, 'not json'].flatMap(line => eventsOfLine(claudeStream, line)), [
    { kind: 'thinking', text: 'plan it' }, { kind: 'text', text: 'Looking.' }, { kind: 'tool_start', name: 'Read', id: 't1' }, { kind: 'tool_done', id: 't1' }, { kind: 'reply', text: 'All done.' }]);
  const codexLines = [
    { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'think' } },
    { type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'ls' } },
    { type: 'item.started', item: { id: 'm', type: 'mcp_tool_call', server: 'trillion', tool: 'read_messages' } },
    { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Hi.' } },
  ].map(line => JSON.stringify(line));
  assert.deepEqual(codexLines.flatMap(line => eventsOfLine(codexStream, line)).map(item => [item.kind, item.name ?? item.text ?? item.id]),
    [['thinking', 'think'], ['tool_start', 'ls'], ['tool_done', 'c'], ['tool_start', 'read_messages'], ['text', 'Hi.']]);
  const seen = []; const lines = lineSplitter(line => seen.push(line));
  lines.push('{"a":'); lines.push('1}\n{"b"'); lines.push(':2}'); lines.end();
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}']);
});

test('the progress file counts tools, keeps bounded text, and report-progress shows it as a working card', () => {
  const written = [];
  let clock = 0;
  const keeper = progressKeeper({ path: '/p/progress.json', app: 'Claude Code', stream: claudeStream, now: () => clock, write: (path, value) => written.push(value) });
  keeper.event({ kind: 'tool_start', name: 'Edit' }); keeper.event({ kind: 'thinking', text: 'secret plan' });
  clock = 5000; keeper.event({ kind: 'text', text: 'x'.repeat(1000) });
  const last = keeper.end('finished');
  assert.equal(last.last_text.length, claudeStream.show_text_characters);
  assert.equal(written.length, 3, 'written when it starts, at most every progress_every_ms, and at the end');
  assert.ok(written.every(value => !JSON.stringify(value).includes('secret plan')), 'thinking text is never kept');
  const row = progressRules.rows.find(item => item.id === 'ai-session-run');
  const report = reportOf(row, { ...written.at(-1), tools_done: 0 }, { folder: 'session-x', computer: 'Mac', now: Date.parse(written.at(-1).updated_at) });
  assert.deepEqual([report.kind, report.state, report.title, report.chips[0].text], ['working', 'done', 'Claude Code finished on this computer', '0 of 1 tool steps done']);
});

test('the workspace allow-list is kept, read and cleared by folder, and rides only a CLI that has the flag', t => {
  const home = tempHome(t); const rules = { ...wakeRules, folder: join(home, 'wake') };
  assert.equal(workspaceTools(rules, home), null);
  assert.deepEqual(setWorkspaceTools(rules, home, 'Read, Edit,Read'), { folder: home, tools: ['Read', 'Edit'] });
  assert.deepEqual(workspaceTools(rules), { [home]: ['Read', 'Edit'] });
  const claude = runArgv(wakeRules.harnesses['claude-code'], ['claude', '--resume', 's', '-p', 'hi'], { tools: ['Read', 'Edit'] });
  assert.deepEqual(claude.argv.slice(0, 6), ['claude', '--allowedTools', 'Read,Edit', '--output-format', 'stream-json', '--verbose']);
  assert.equal(claude.tools_applied, true);
  const codex = runArgv(wakeRules.harnesses.codex, ['codex', 'exec', 'resume', 's', 'hi'], { tools: ['Read'] });
  assert.equal(codex.tools_applied, false, 'a CLI with no allow-list flag is answered as not applying');
  assert.equal(codex.argv.includes('--dangerously-skip-permissions'), false);
  assert.deepEqual(clearWorkspaceTools(rules, home), { folder: home, cleared: true });
  assert.equal(workspaceTools(rules, home), null);
  assert.throws(() => setWorkspaceTools(rules, join(home, 'gone'), 'Read'), /does not exist/);
  assert.throws(() => setWorkspaceTools(rules, home, ' , '), /Name the allowed tools/);
});

test('a woken Claude session streams, its reply is the result event, and its progress file lands under the helper folder', async t => {
  const home = tempHome(t);
  const rules = { ...wakeRules, folder: join(home, 'wake'), retries: 0 };
  const hosted = registerSession({ harness: 'claude-code', session_id: 'abcdef12-3456', cwd: home }, rules);
  setWorkspaceTools(rules, home, 'Read');
  const handoff = { handoff_id: 'h1', state: 'open', to_agent: hosted.agent_id, job: 'job' };
  const fetchImpl = async url => new Response(JSON.stringify(new URL(url).pathname.endsWith('/handoffs/read') ? { handoff } : {}), { status: 200 });
  let argv;
  const runImpl = async (command, options) => {
    argv = command;
    options.on_output(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'take_work' }] } })}\n${JSON.stringify({ type: 'result', result: 'Fin' })}`);
    handoff.state = 'taken'; handoff.taken_by = hosted.agent_id;
    return { code: 0, stdout: 'raw', stderr: '' };
  };
  const helper = makeHelper({ rules, key: 'k', fetchImpl, handlers: await loadHandlers(rules), runImpl, log: () => {} });
  const outcome = await helper.handle({ event_id: 'ev1', type: 'handoff.created', to_agent: hosted.agent_id, refs: { handoff_id: 'h1', handed_to: hosted.agent_id } });
  assert.equal(outcome.ok, true, outcome.error);
  assert.deepEqual(argv.slice(0, 3), ['claude', '--allowedTools', 'Read']);
  const file = JSON.parse(readFileSync(join(rules.folder, 'progress', hosted.agent_id, 'progress.json'), 'utf8'));
  assert.deepEqual([file.state, file.tools_started, file.tool, file.reply], ['finished', 1, 'take_work', 'Fin']);
});
