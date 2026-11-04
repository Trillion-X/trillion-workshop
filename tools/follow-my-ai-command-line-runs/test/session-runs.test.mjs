// The session-runs cases of Trillion-X/trillion test/harness-guidance-mcp-and-runs.test.mjs, moved with the module.
// The progress case's last step (computer/report-progress.mjs showing the file as a card) stays with that Mac
// program; the progress file's own assertions are kept. One case is added for this folder's command line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearWorkspaceTools, eventsOfLine, lineSplitter, progressKeeper, progressPath, runArgv, setWorkspaceTools, workspaceTools } from '../do-work/session-runs.mjs';
import wakeRules from '../read-data/ai-command-lines.json' with { type: 'json' };

const tempHome = t => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trillion-harness-'))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
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

test('the progress file counts tools and keeps bounded text', () => {
  const written = [];
  let clock = 0;
  const keeper = progressKeeper({ path: '/p/progress.json', app: 'Claude Code', stream: claudeStream, now: () => clock, write: (path, value) => written.push(value) });
  keeper.event({ kind: 'tool_start', name: 'Edit' }); keeper.event({ kind: 'thinking', text: 'secret plan' });
  clock = 5000; keeper.event({ kind: 'text', text: 'x'.repeat(1000) });
  const last = keeper.end('finished');
  assert.equal(last.last_text.length, claudeStream.show_text_characters);
  assert.equal(written.length, 3, 'written when it starts, at most every progress_every_ms, and at the end');
  assert.ok(written.every(value => !JSON.stringify(value).includes('secret plan')), 'thinking text is never kept');
  assert.deepEqual([written.at(-1).state, written.at(-1).tools_started, written.at(-1).tool], ['finished', 1, 'Edit']);
  assert.match(progressPath({ ...wakeRules, folder: '/h/wake' }, 'agent one/x'), /^\/h\/wake\/progress\/agent-one-x\/progress\.json$/);
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

test('the command line reads a stream on standard input and refuses an unknown command line', () => {
  const script = fileURLToPath(new URL('../do-work/follow-runs.mjs', import.meta.url));
  const out = execFileSync('node', [script, '--events', 'claude-code'], { input: `${JSON.stringify({ type: 'result', result: 'Done.' })}\nnot json\n`, encoding: 'utf8' });
  assert.deepEqual(out.trim().split('\n').map(line => JSON.parse(line)), [{ kind: 'reply', text: 'Done.' }]);
  assert.throws(() => execFileSync('node', [script, '--events', 'nobody'], { stdio: 'pipe' }), /No command line/);
});
