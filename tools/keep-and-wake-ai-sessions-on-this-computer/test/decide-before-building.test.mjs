// harness/decide-before-building.mjs: a change to a file in a repository, or a commit, is refused until the turn has a
// terminal Trillion decision; Claude Code and Codex transcripts read the same way; free folders,
// files outside repositories and plain reads are never refused; merely naming a deciding tool decides nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { casesToConfirm, confirmDecided, currentTurn, decisionServerState, eventsOf, judge as judgeActual, lastingChange, settings, trillionDown, turnForDecisionFallback, turnRanLocalMethod, turnWithAskFromFile, turnDecided } from '../harness/decide-before-building.mjs';

// A lasting file is one inside a git repository, and a landing checks an export that has no .git of its own, so the
// fixture makes its own repository (a folder holding a .git folder) rather than relying on the tree the test runs in.
const repository = mkdtempSync(join(realpathSync(tmpdir()), 'decide-before-building-repository-'));
mkdirSync(join(repository, '.git'));
process.on('exit', () => rmSync(repository, { recursive: true, force: true }));
const repoFile = join(repository, 'src', 'inbound.mjs');
// The repository may sit under a free folder (the temp folder here, a managed Codex checkout elsewhere). The fixture
// must still exercise a protected file. Production rules remain untouched, and the free-folder checks use them.
const fixtureRules = { ...settings, free_folders: settings.free_folders.filter(folder => {
  const path = resolve(folder.replace(/^~(?=\/|$)/, homedir()));
  return repoFile !== path && !repoFile.startsWith(`${path}/`);
}) };
const judge = (event, options = {}) => judgeActual(event, { rules: fixtureRules, ...options });
const claude = rows => rows.map(row => JSON.stringify(row)).join('\n');
const asked = text => ({ type: 'user', message: { role: 'user', content: text } });

test('a shell_changes row is a pattern or { pattern, what }: an object row refuses a commit by its words and lets echo hi pass', () => {
  const rules = { shell_tools: ['Bash'], file_tools: [], path_fields: [], shell_changes: [{ pattern: '\\bgit\\s+commit\\b', what: 'a commit to the repo' }, '\\bgit\\s+push\\b'] };
  const call = command => lastingChange({ tool_name: 'Bash', tool_input: { command } }, rules);
  assert.equal(call('echo hi'), null);
  assert.deepEqual(call('git commit -m x'), ['a commit to the repo']);
  assert.deepEqual(call('git push origin main'), ['a commit'], 'a string row still reports a commit');
});
const call = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const answer = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const edit = transcript => judge({ tool_name: 'Edit', tool_input: { file_path: repoFile }, transcript_path: 'x' }, { read: () => transcript });
const terminal = JSON.stringify({ id: 'source:bm8tYnVpbGRpbmctd2l0aG91dA', status: 'needs_outcome', decided_at: '2026-09-29T14:00:00Z', decision: { option_id: 'fix', reason: 'The guard must require a choice.', next_action: 'Repair the hook.', success_measure: 'A pending case is refused.' } });

test('a recent attested decision proves its turn without parsing older history, while a newer request cancels it', () => {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-decision-tail-'));
  const path = join(folder, 'session.jsonl');
  const decision = [call('t1', 'mcp__trillion__decide', {}), answer('t1', terminal)];
  try {
    writeFileSync(path, 'older incomplete history\n' + claude(decision) + '\n');
    assert.throws(() => turnWithAskFromFile(path), SyntaxError, 'full-turn readers retain complete-row refusal');
    const recent = turnWithAskFromFile(path, null, { stopWhenDecided: true });
    assert.equal(recent.asked, null);
    assert.equal(turnDecided(recent.turn), true);
    appendFileSync(path, JSON.stringify(asked('a different request')) + '\n');
    const later = turnWithAskFromFile(path, null, { stopWhenDecided: true });
    assert.equal(later.asked.text, 'a different request');
    assert.equal(turnDecided(later.turn), false);
    writeFileSync(path, 'older incomplete history\n' + claude([call('t2', 'mcp__trillion__start_decision', {}), answer('t2', terminal)]) + '\n');
    assert.throws(() => turnWithAskFromFile(path, null, { stopWhenDecided: true }), SyntaxError, 'a pending tool cannot certify terminal text');
    for (const invalid of [
      [answer('missing', terminal)],
      [call('t3', 'mcp__trillion__decide', {}), answer('t3', '{"error":"Question remains"}')],
      [call('t4', 'mcp__trillion__decide', {}), { ...answer('t4', terminal), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', content: terminal, is_error: true }] } }],
      [call('t5', 'functions.exec', { code: 'text("Status: Decided\\n## Decision")' }), answer('t5', '# Goal\nStatus: Decided\n## Decision\nA printed choice')],
      [decision[0], asked('between the call and answer'), decision[1]],
    ]) {
      writeFileSync(path, claude([asked('first'), ...invalid]) + '\n');
      assert.equal(turnDecided(turnWithAskFromFile(path, null, { stopWhenDecided: true }).turn), false, JSON.stringify(invalid));
    }
    const attested = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', id: 'nested', server: 'trillion', tool: 'decide', status: 'completed', arguments: {}, result: { structuredContent: JSON.parse(terminal) } } } };
    writeFileSync(path, 'older incomplete history\n' + JSON.stringify(attested) + '\n');
    assert.equal(turnDecided(turnWithAskFromFile(path, null, { stopWhenDecided: true }).turn), true, 'actual Codex completion is attested without relying on the wrapper');
    writeFileSync(path, 'older incomplete history\n' + claude(decision) + '\nmalformed newer complete row\n');
    assert.throws(() => turnWithAskFromFile(path, null, { stopWhenDecided: true }), SyntaxError, 'newer malformed rows cannot be skipped');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('Codex compaction continues the turn without inventing a person message', () => {
  const before = asked('earlier person request');
  const compacted = { type: 'compacted', payload: { resume_metadata: { last_started_turn_id: 'turn-2' } } };
  const turn = currentTurn(claude([before, compacted, call('t1', 'mcp__trillion__start_decision', {})]).split('\n'));
  assert.deepEqual(turn.map(item => item.kind), ['call']);
  assert.match(edit(claude([before, compacted, call('t1', 'mcp__trillion__start_decision', {})])), /finish a Trillion decision/);
});

test('Codex attested nested command and decision failure are read without trusting printed shell text', () => {
  const command = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'shell-1', status: 'completed', exit_code: 0, command: ['/bin/zsh', '-lc', 'node scripts/method-checks.mjs root'], aggregated_output: 'root checks' } } };
  const unavailable = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'trillion', tool: 'answer_question', status: 'failed', result: { structuredContent: { error: { code: 'resource-exhausted' } } } } } };
  const events = currentTurn(claude([asked('repair it'), command, unavailable]).split('\n'));
  assert.equal(turnRanLocalMethod(events), true);
  assert.equal(events.some(item => item.kind === 'decision_unavailable'), true);
  assert.equal(eventsOf({ ...unavailable, payload: { ...unavailable.payload, item: { ...unavailable.payload.item, result: { structuredContent: { error: { code: 'denied' } } } } } }).some(item => item.kind === 'decision_unavailable'), false);
});

test('an attested answer timeout opens the local-method fallback, but validation errors do not', () => {
  const failed = (server, tool, message) => ({ type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'McpToolCall', server, tool, status: 'failed', result: null, error: { message },
  } } });
  const direct = failed('trillion', 'answer_question', 'timed out awaiting tools/call after 300s');
  const app = failed('codex_apps', 'trillion.answer_question', 'Mcp error: -32603: MCP request timed out');
  const invalid = failed('trillion', 'answer_question', 'INVALID_ARGUMENT: missing field');
  assert.equal(eventsOf(direct).some(item => item.kind === 'decision_unavailable'), true);
  assert.equal(eventsOf(app).some(item => item.kind === 'decision_unavailable'), true);
  assert.equal(eventsOf(invalid).some(item => item.kind === 'decision_unavailable'), false);
});

test('an edit in a repository with no decision this turn is refused, and allowed once a decision came back', () => {
  assert.match(edit(claude([asked('make the door')])), /Before changing files, finish a Trillion decision/);
  const pending = claude([asked('make the door'), call('t1', 'mcp__trillion__start_decision', { goal: 'g' }), answer('t1', '{"case_id":"source:bm8tYnVpbGRpbmctd2l0aG91dA","question":{"step_id":"scope"}}')]);
  assert.match(edit(pending), /finish a Trillion decision/);
  const pendingExport = claude([asked('make the door'), call('t1', 'mcp__trillion__export_decision', { case_id: 'source:bm8tYnVpbGRpbmctd2l0aG91dA' }), answer('t1', '# Goal\nMethod: Any decision\nStatus: Needs decision\n\nNo choice yet')]);
  assert.match(edit(pendingExport), /finish a Trillion decision/);
  const failedDecide = claude([asked('make the door'), call('t1', 'mcp__trillion__decide', {}), answer('t1', '{"case_id":"source:bm8tYnVpbGRpbmctd2l0aG91dA","error":"Question remains"}')]);
  assert.match(edit(failedDecide), /finish a Trillion decision/);
  const decided = claude([asked('make the door'), call('t1', 'mcp__trillion__decide', { case_id: 'source:bm8tYnVpbGRpbmctd2l0aG91dA' }), answer('t1', terminal)]);
  assert.equal(edit(decided), null);
});

test('a decide sent again for a case already decided counts; an already_decided answer with no decision does not', () => {
  const again = JSON.stringify({ case_id: 'source:bm8tYnVpbGRpbmctd2l0aG91dA', already_decided: true, decision: { option_id: 'fix', reason: 'The guard must require a choice.', next_action: 'Repair the hook.', success_measure: 'A pending case is refused.' } });
  assert.equal(edit(claude([asked('make the door'), call('t1', 'mcp__trillion__decide', {}), answer('t1', again)])), null);
  const empty = JSON.stringify({ case_id: 'source:bm8tYnVpbGRpbmctd2l0aG91dA', already_decided: true });
  assert.match(edit(claude([asked('make the door'), call('t1', 'mcp__trillion__decide', {}), answer('t1', empty)])), /finish a Trillion decision/);
});

test('a successful decide reply with a complete choice counts even before export is available', () => {
  const fresh = JSON.stringify({ case_id: 'source:bm8tYnVpbGRpbmctd2l0aG91dA', decision: {
    option_id: 'fix', reason: 'The guard must recognize the choice.', next_action: 'Repair the hook.', success_measure: 'The edit is allowed.' } });
  assert.equal(edit(claude([asked('repair it'), call('t1', 'mcp__trillion__decide', {}), answer('t1', fresh)])), null);
});

test('a decision from an earlier message does not cover a new one', () => {
  const earlier = claude([asked('first'), call('t1', 'mcp__trillion__decide', {}), answer('t1', terminal), asked('now something else')]);
  assert.match(edit(earlier), /finish a Trillion decision/);
});

test('naming a deciding tool in a command decides nothing; an unfinished case never authorizes edits', () => {
  const faked = claude([asked('go'), call('b1', 'Bash', { command: 'echo start_decision' }), answer('b1', 'start_decision')]);
  assert.match(edit(faked), /finish a Trillion decision/);
  const real = claude([asked('go'), call('b1', 'Bash', { command: 'node caller.mjs answer_question "{...}"' }), answer('b1', '{"case_id":"source:bm8tYnVpbGRpbmctd2l0aG91dA","question":null}')]);
  assert.match(edit(real), /finish a Trillion decision/);
  const shellPrinted = claude([asked('go'), call('b1', 'Bash', { command: 'node caller.mjs decide "{...}"' }), answer('b1', terminal)]);
  assert.match(edit(shellPrinted), /finish a Trillion decision/);
  // A chat whose sign-in dropped decides through its saved-key caller; that terminal answer counts, an opened case does not.
  const savedKey = claude([asked('go'), call('b2', 'Bash', { command: "python3 ~/dev/sample-checkout/trillion-decision/call.py decide '{...}'" }), answer('b2', terminal)]);
  assert.equal(edit(savedKey), null);
  const savedKeyExport = claude([asked('go'), call('b3', 'Bash', { command: "node ~/dev/sample-checkout/2026-09-27/trillion-mcp-call.mjs export_decision '{...}'" }), answer('b3', terminal)]);
  assert.equal(edit(savedKeyExport), null);
  const savedKeyOpened = claude([asked('go'), call('b4', 'Bash', { command: "node ~/dev/sample-checkout/2026-09-27/trillion-mcp-call.mjs next_question '{...}'" }), answer('b4', terminal)]);
  assert.match(edit(savedKeyOpened), /finish a Trillion decision/);
  const failed = claude([asked('go'), call('t1', 'mcp__trillion__start_decision', {}), answer('t1', 'error: goal is required')]);
  assert.match(edit(failed), /finish a Trillion decision/);
});

test('a commit is refused without a decision; free folders, files outside repositories and other tools are not', () => {
  const none = claude([asked('go')]);
  assert.match(judge({ tool_name: 'Bash', tool_input: { command: 'git add x && git commit -m "y"' }, transcript_path: 'x' }, { read: () => none }), /Refused: a commit/);
  assert.equal(judge({ tool_name: 'Bash', tool_input: { command: 'git status && npm test' }, transcript_path: 'x' }, { read: () => none }), null);
  assert.equal(judgeActual({ tool_name: 'Write', tool_input: { file_path: join(homedir(), 'dev/sample-checkout/2026-09-27/a.json') }, transcript_path: 'x' }, { read: () => none }), null);
  assert.equal(judge({ tool_name: 'Write', tool_input: { file_path: '/nowhere-in-a-repository/notes.md' }, transcript_path: 'x' }, { read: () => none }), null);
  assert.equal(judge({ tool_name: 'Read', tool_input: { file_path: repoFile }, transcript_path: 'x' }, { read: () => none }), null);
});

test('a turn that cannot be read is refused with the reason, never assumed decided', () => {
  const reason = judge({ tool_name: 'Edit', tool_input: { file_path: repoFile }, transcript_path: '/no/such/transcript.jsonl' }, { read: () => { throw new Error('missing'); } });
  assert.match(reason, /could not be read from \/no\/such\/transcript\.jsonl/);
});

test('Codex rows read the same way: a patch into the repository waits for a decision', () => {
  const codex = rows => rows.map(row => JSON.stringify({ type: 'response_item', payload: row })).join('\n');
  const patch = { tool_name: 'apply_patch', tool_input: { command: ['apply_patch', `*** Begin Patch\n*** Update File: ${repoFile}\n@@\n-a\n+b\n*** End Patch`] }, transcript_path: 'x' };
  const start = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build it' }] };
  assert.match(judge(patch, { read: () => codex([start]) }), /finish a Trillion decision/);
  const decided = codex([start, { type: 'function_call', call_id: 'c1', name: 'mcp__trillion__export_decision', arguments: '{"case_id":"source:bm8tYnVpbGRpbmctd2l0aG91dA"}' }, { type: 'function_call_output', call_id: 'c1', output: terminal }]);
  assert.equal(judge(patch, { read: () => decided }), null);
});

test('a subagent is judged by its own transcript, not the session that started it', () => {
  const session = claude([asked('port the engines')]);
  const agent = claude([call('b1', 'mcp__trillion__decide', { case_id: 'source:bm8tYnVpbGRpbmctd2l0aG91dA' }), answer('b1', terminal)]);
  const read = path => ({ 'session.jsonl': session, 'agent.jsonl': agent })[path];
  const commit = extra => judge({ tool_name: 'Bash', tool_input: { command: 'git commit -m "y"' }, transcript_path: 'session.jsonl', ...extra }, { read });
  assert.equal(commit({ agent_transcript_path: 'agent.jsonl' }), null);
  // An agent id whose transcript is not beside the session falls back to the session's turn.
  assert.match(commit({ agent_id: 'no-such-agent' }), /Refused: a commit/);
});

test('Codex code mode and its app connector: a real decision counts, a tool list that mentions case_id does not', () => {
  const codex = rows => rows.map(row => JSON.stringify({ type: 'response_item', payload: row })).join('\n');
  const patch = { tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${repoFile}\n@@\n+b\n*** End Patch` }, transcript_path: 'x' };
  const start = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build it' }] };
  const exec = (id, code) => ({ type: 'custom_tool_call', call_id: id, name: 'exec', input: code });
  const out = (id, text) => ({ type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text }] });
  // The live false positive: searching the tool list for read_decision returned descriptions naming case_id.
  const searched = codex([start, exec('e1', 'ALL_TOOLS.filter(x => /export_decision|trillion/i.test(x.name))'), out('e1', '[{"name":"x","inputSchema":{"case_id":{"type":"string"}}}]')]);
  assert.match(judge(patch, { read: () => searched }), /finish a Trillion decision/);
  const unavailable = codex([start, exec('e1', 'const fn = tools.mcp__codex_apps__trillion_export_decision; text(fn ? await fn({}) : "UNAVAILABLE")'), out('e1', 'Script completed\nOutput:\nUNAVAILABLE')]);
  assert.match(judge(patch, { read: () => unavailable }), /finish a Trillion decision/);
  const printed = codex([start, exec('e1', 'text(await tools.mcp__codex_apps__trillion_export_decision({case_id:"source:bm8tYnVpbGRpbmctd2l0aG91dA"}))'), out('e1', 'Script completed\nOutput:\n# The goal\n\nMethod: Any decision\nStatus: Decided: waiting to hear how it went\n\n## Decision\n\n**Choose repair**')]);
  assert.match(judge(patch, { read: () => printed }), /finish a Trillion decision/);
  const attested = codex([start, { type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: 'text("short output")' }]);
  const completed = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', id: 'm1', server: 'codex_apps', tool: 'trillion.export_decision', status: 'completed', arguments: { case_id: 'source:bm8tYnVpbGRpbmctd2l0aG91dA' }, result: { structuredContent: JSON.parse(terminal) } } } };
  assert.equal(judge(patch, { read: () => `${attested}\n${JSON.stringify(completed)}` }), null);
  const pending = { ...completed, payload: { ...completed.payload, item: { ...completed.payload.item, result: { structuredContent: { id: 'source:bm8tYnVpbGRpbmctd2l0aG91dA', status: 'needs_decision', decision: null } } } } };
  assert.match(judge(patch, { read: () => `${attested}\n${JSON.stringify(pending)}` }), /finish a Trillion decision/);
  const markdown = { ...completed, payload: { ...completed.payload, item: { ...completed.payload.item, server: 'trillion', tool: 'export_decision', result: { structuredContent: { text: '# Goal\nMethod: Any decision\nStatus: Decided: waiting to hear how it went\n\n## Decision\n\n**Choose repair**', new_since_you_last_looked: [] } } } } };
  assert.equal(judge(patch, { read: () => `${attested}\n${JSON.stringify(markdown)}` }), null);
  const connector = codex([start, { type: 'function_call', call_id: 'c1', name: 'mcp__codex_apps__trillion_export_decision', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: '# G\n\nMethod: Any decision\nStatus: Decided: waiting to hear how it went\n\n## Decision\n\n**Choose repair**' }]);
  assert.equal(judge(patch, { read: () => connector }), null);
  // Another server's tool with the same suffix decides nothing.
  const other = codex([start, { type: 'function_call', call_id: 'c1', name: 'mcp__notes__export_decision', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'Method: x\nStatus: y' }]);
  assert.match(judge(patch, { read: () => other }), /finish a Trillion decision/);
});

test('Codex code-mode printed output needs an attested Trillion completion before it authorizes a protected operation', () => {
  const forged = claude([asked('go'), call('e1', 'exec', { text: 'text("Status: Decided\\n## Decision")' }), answer('e1', 'Status: Decided\n## Decision')]);
  assert.match(edit(forged), /finish a Trillion decision/);
});

test('an answer the harness saved to its own file because it was too long is read there; only from the harness folder, and only a decided case counts', () => {
  const saved = join(homedir(), '.claude', 'projects', 'p', 's', 'tool-results', 'mcp-trillion-export_decision-1.txt');
  const spill = path => `Error: result (499,807 characters) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: JSON`;
  const turn = (path, contents) => judge({ tool_name: 'Edit', tool_input: { file_path: repoFile }, transcript_path: 'x' }, {
    read: at => (at === 'x' ? claude([asked('ship it'), call('e1', 'mcp__trillion__export_decision', { case_id: 'c' }), answer('e1', spill(path))]) : at === path ? contents : (() => { throw new Error('unread'); })()),
  });
  assert.equal(turn(saved, terminal), null, 'the saved decided case counts');
  assert.equal(turn(saved, JSON.stringify({ text: 'Status: Decided\n\n## Decision\n' })), null, 'a saved markdown export counts');
  assert.match(turn(saved, JSON.stringify({ id: 'c', status: 'needs_decision' })), /finish a Trillion decision/, 'a saved open case does not');
  assert.match(turn('/Users/example/elsewhere/tool-results/x.txt', terminal), /finish a Trillion decision/, 'a file outside the harness folder is never read');
  assert.match(turn(join(homedir(), '.claude', 'projects', 'p', 'notes.txt'), terminal), /finish a Trillion decision/, 'only the harness saved-answers folder');
});

test('a shell answer too long to show is read from the file the harness names, and the caller\'s JSON-RPC answer counts', () => {
  const saved = join(homedir(), '.claude', 'projects', 'p', 's', 'tool-results', 'b1.txt');
  const exported = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '# Goal\n\nStatus: Decided: waiting to hear how it went\n\n## Decision\n\n**Ship it**' }] } });
  const open = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '# Goal\n\nStatus: Needs a decision' }] } });
  const shell = `<persisted-output>\nOutput too large (71.9KB). Full output saved to: ${saved}\n\nPreview (first 2KB):\n{`;
  const turn = contents => judge({ tool_name: 'Edit', tool_input: { file_path: repoFile }, transcript_path: 'x' }, {
    read: at => (at === 'x' ? claude([asked('ship it'), call('e1', 'Bash', { command: `node ~/dev/sample-checkout/2026-09-27/trillion-mcp-call.mjs export_decision '{"case_id":"c"}'` }), answer('e1', shell)]) : at === saved ? contents : (() => { throw new Error('unread'); })()),
  });
  assert.equal(turn(exported), null, 'the saved decided export counts');
  assert.match(turn(open), /finish a Trillion decision/, 'a saved undecided case does not');
});

// ---- A decision whose printed answer was trimmed is confirmed with the decisions' own server ----

const serverAnswering = text => async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
  const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : { content: [{ type: 'text', text }] };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'mcp-session-id': 's1' } });
};
const confirm = { url: 'https://decisions.example/mcp', keychain_item: 'k' };
const decidedExport = '# Goal\nStatus: Decided\n\n## Decision\n\n**fix**';

const serverTurn = (count = 2, local = true) => [
  ...Array.from({ length: count }, (_, n) => ({ kind: 'call', name: 'mcp__trillion__export_decision', input: { case_id: `source:${n}` } })),
  ...(local ? [{ kind: 'call', name: 'Bash', input: { command: 'node scripts/method-checks.mjs proof' } }] : []),
];
const serverRules = { ...settings, confirm_with: { ...confirm, timeout_ms: 500, total_timeout_ms: 1000 } };

test('case confirmations and fallback share one initialized connection, including write-only unavailability', async () => {
  const calls = [];
  const request = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    const text = body.params?.name === 'decide' ? 'Saving is used up this hour.' : '# Goal\nStatus: Needs decision';
    const result = body.method === 'initialize' ? {} : { content: [{ type: 'text', text }] };
    return Response.json({ result }, { headers: { 'mcp-session-id': 'shared' } });
  };
  assert.deepEqual(await decisionServerState(serverTurn(), serverRules, { request, keyOf: () => 'key' }), { decided: false, down: true, timed_out: false });
  assert.equal(calls.filter(call => call.method === 'initialize').length, 1);
  assert.deepEqual(calls.filter(call => call.method === 'tools/call').map(call => call.params.name), ['export_decision', 'export_decision', 'list_decisions', 'decide']);
  assert.equal(calls.at(-1).params.arguments.case_id, 'source:no-such-case-down-probe');
  assert.deepEqual(await decisionServerState(serverTurn(2, false), serverRules, { request, keyOf: () => 'key' }), { decided: false, down: false, timed_out: false });
  assert.deepEqual(await decisionServerState(serverTurn(), serverRules, { request: serverAnswering(decidedExport), keyOf: () => 'key' }), { decided: true, down: false, timed_out: false });
});

test('the overall deadline cancels a slow confirmation and refuses instead of inventing server-down permission', async () => {
  let aborted = false;
  let initialized = 0;
  const request = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') { initialized += 1; return Response.json({ result: {} }); }
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true }));
  };
  const started = performance.now();
  const answer = await decisionServerState(serverTurn(100), { ...serverRules, confirm_with: { ...serverRules.confirm_with, total_timeout_ms: 30 } }, { request, keyOf: () => 'key' });
  assert.deepEqual(answer, { decided: false, down: false, timed_out: true });
  assert.equal(aborted, true);
  assert.equal(initialized, 1);
  assert.ok(performance.now() - started < 500, 'the per-request timeout and case count cannot extend the overall deadline');
});

test('an individual unanswered request retains local-method fallback, while refused or absent keys never certify a decision', async () => {
  const unavailable = async () => { throw new Error('network timeout'); };
  assert.deepEqual(await decisionServerState(serverTurn(), serverRules, { request: unavailable, keyOf: () => 'key' }), { decided: false, down: true, timed_out: false });
  assert.deepEqual(await decisionServerState(serverTurn(2, false), serverRules, { request: unavailable, keyOf: () => 'key' }), { decided: false, down: false, timed_out: false });
  assert.deepEqual(await decisionServerState(serverTurn(), serverRules, { request: async () => new Response('Unauthorized', { status: 401 }), keyOf: () => 'key' }), { decided: false, down: false, timed_out: false });
  let keys = 0;
  assert.deepEqual(await decisionServerState(serverTurn(100), serverRules, { request: unavailable, keyOf: () => { keys += 1; return null; } }), { decided: false, down: false, timed_out: false });
  assert.equal(keys, 1, 'one absent credential does not cause one lookup for every named case');
});

test('a trimmed caller answer names its case, and the server confirms it decided or not', async () => {
  const command = `node trillion-mcp-call.mjs export_decision '{"case_id":"source:abc"}' | python3 -c "print(True)"`;
  const rows = claude([asked('commit it'), call('t1', 'Bash', { command }), answer('t1', 'True True')]);
  assert.match(edit(rows), /finish a Trillion decision/);
  const turn = currentTurn(rows.split('\n'));
  assert.deepEqual(casesToConfirm(turn), ['source:abc']);
  assert.equal(await confirmDecided('source:abc', confirm, { request: serverAnswering(decidedExport), keyOf: () => 'key' }), true);
  assert.equal(await confirmDecided('source:abc', confirm, { request: serverAnswering('# Goal\nStatus: Needs decision'), keyOf: () => 'key' }), false);
  assert.equal(await confirmDecided('source:abc', confirm, { request: async () => { throw new Error('offline'); }, keyOf: () => 'key' }), false);
  assert.equal(await confirmDecided('source:abc', confirm, { request: serverAnswering(decidedExport), keyOf: () => null }), false);
});

test('only deciding calls name cases to confirm; opening or answering a case never does', () => {
  const rows = claude([asked('x'), call('t1', 'mcp__trillion__next_question', { case_id: 'source:open' }), call('t2', 'Bash', { command: `echo '{"case_id":"source:echoed"}'` }), call('t3', 'mcp__trillion__export_decision', { case_id: 'source:real' })]);
  assert.deepEqual(casesToConfirm(currentTurn(rows.split('\n'))), ['source:real']);
});

test('when the decisions server cannot keep a decision, a turn that ran the method here may change files', async () => {
  const down = { down_answers: ['Exceeded the maximum database size', 'Something broke on our side'], local_method_commands: ['scripts/method-checks\\.mjs'] };
  const full = serverAnswering('Exceeded the maximum database size.');
  assert.equal(await trillionDown(confirm, down, { request: full, keyOf: () => 'key' }), true);
  assert.equal(await trillionDown(confirm, down, { request: async () => new Response('{"error":"x"}', { status: 503 }), keyOf: () => 'key' }), true);
  assert.equal(await trillionDown(confirm, down, { request: async () => { throw new Error('offline'); }, keyOf: () => 'key' }), true);
  assert.equal(await trillionDown(confirm, down, { request: serverAnswering('Fix the door, decided'), keyOf: () => 'key' }), false);
  assert.equal(await trillionDown(confirm, down, { request: full, keyOf: () => null }), false);
  const ran = currentTurn(claude([asked('fix it'), call('t1', 'Bash', { command: 'node scripts/method-checks.mjs risk' }), answer('t1', 'risk: 99 checks')]).split('\n'));
  const didNot = currentTurn(claude([asked('fix it'), call('t1', 'Bash', { command: 'ls' }), answer('t1', 'a')]).split('\n'));
  assert.equal(turnRanLocalMethod(ran, down), true);
  assert.equal(turnRanLocalMethod(didNot, down), false);
});

test('a long JSONL session reads only the newest complete turn and ignores an unfinished trailing row', () => {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-decision-hook-'));
  const path = join(folder, 'session.jsonl');
  const event = { tool_name: 'Edit', tool_input: { file_path: repoFile }, transcript_path: path };
  try {
    const noise = `${JSON.stringify({ type: 'event_msg', payload: { type: 'status', filler: 'x'.repeat(1024) } })}\n`;
    writeFileSync(path, noise.repeat(4096));
    appendFileSync(path, claude([asked('current work'), call('d1', 'mcp__trillion__decide', {}), answer('d1', terminal)]));
    assert.equal(judge(event), null, 'a complete final row without a newline counts');
    appendFileSync(path, '\n');
    assert.equal(judge(event), null, 'the decided latest turn is accepted');
    appendFileSync(path, `${JSON.stringify(asked('a new request'))}\n{"type":"response_item","payload":`);
    assert.match(judge(event), /finish a Trillion decision/, 'the earlier decision is never borrowed and an incomplete tail is ignored');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('local-method fallback recovers an attested completion after unreadable old history and obeys newer user boundaries', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-decision-fallback-'));
  const path = join(folder, 'session.jsonl');
  const command = code => ({ type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'CommandExecution', id: `method-${code}`, status: 'completed', exit_code: code,
    command: ['/bin/zsh', '-lc', 'node scripts/method-checks.mjs root'],
  } } });
  try {
    writeFileSync(path, `unreadable older history\n${JSON.stringify(command(0))}\n`);
    assert.throws(() => turnWithAskFromFile(path), SyntaxError, 'the ordinary full-turn reader still refuses malformed history');
    const recovered = turnForDecisionFallback(path);
    assert.equal(turnRanLocalMethod(recovered), true);
    assert.equal(recovered.some(event => event.kind === 'command_completed' && event.exit_code === 0), true,
      'only the attested successful command is retained as evidence');
    assert.deepEqual(await decisionServerState(recovered, serverRules, {
      request: serverAnswering('Exceeded the maximum database size'), keyOf: () => 'key',
    }), { decided: false, down: true, timed_out: false }, 'only the independent unavailable-server check grants fallback');
    writeFileSync(path, 'unreadable older history\n' + claude([
      call('printed-method', 'exec_command', { cmd: 'node scripts/method-checks.mjs proof' }),
      answer('printed-method', '{"exit_code":0}'),
    ]) + '\n');
    assert.deepEqual(turnForDecisionFallback(path), [], 'printed native-shell output without an attested completion is refused');
    writeFileSync(path, `unreadable older history\n${JSON.stringify(command(0))}\n${JSON.stringify({ type: 'compacted' })}\n`);
    assert.equal(turnRanLocalMethod(turnForDecisionFallback(path)), true, 'compaction never ends an attested method turn');
    const withCase = [{ kind: 'call', name: 'mcp__trillion__export_decision', input: { case_id: 'source:local-fallback' } }, ...recovered];
    assert.deepEqual(await decisionServerState(withCase, serverRules, {
      request: serverAnswering('# Goal\nStatus: Needs a decision'), keyOf: () => 'key',
    }), { decided: false, down: false, timed_out: false }, 'an available server never grants local fallback');
    assert.deepEqual(await decisionServerState(withCase, serverRules, {
      request: async () => new Response('Unauthorized', { status: 401 }), keyOf: () => 'key',
    }), { decided: false, down: false, timed_out: false }, 'an authorization refusal is not server-down permission');
    const timedOut = await decisionServerState(withCase, {
      ...serverRules, confirm_with: { ...serverRules.confirm_with, total_timeout_ms: 20 },
    }, { request: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })), keyOf: () => 'key' });
    assert.deepEqual(timedOut, { decided: false, down: false, timed_out: true }, 'a timeout does not grant local fallback');

    appendFileSync(path, `${JSON.stringify(asked('a newer request'))}\n`);
    const newerRequest = turnForDecisionFallback(path);
    assert.deepEqual(newerRequest, [], 'the current turn contains only events after the newer request');
    assert.equal(turnRanLocalMethod(newerRequest), false, 'method evidence before the newest request is discarded');

    writeFileSync(path, `unreadable older history\n${JSON.stringify(asked('current request'))}\n${JSON.stringify(command(1))}\n`);
    assert.equal(turnRanLocalMethod(turnForDecisionFallback(path)), false, 'a nonzero attested command is not fallback evidence');

    appendFileSync(path, 'malformed newer complete row\n');
    assert.deepEqual(turnForDecisionFallback(path), [], 'a malformed newer complete row cannot be skipped to reach old evidence');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
