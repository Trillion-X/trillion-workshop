// harness/ask-trillion-first.mjs: a turn that the person began is refused at its end until the AI has called a Trillion
// read tool; the harness row decides whether and how; the check never reads what the AI wrote; it refuses once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { consultsFor, judge, nativeReadOf, settings } from '../harness/ask-trillion-first.mjs';
import { currentTurn, turnDecided } from '../harness/decide-before-building.mjs';
import authorizationFailure from './fixtures/native-read-authorization-failure.json' with { type: 'json' };

const claude = rows => rows.map(row => JSON.stringify(row)).join('\n');
const asked = text => ({ type: 'user', message: { role: 'user', content: text } });
const said = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (id, name, input = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const end = (rows, extra = {}, options = {}) => judge({ transcript_path: 'x', ...extra }, { read: () => claude(rows), consults: settings.until_the_row_carries_it, ...options });
const nativeCommand = `node ~/.codex/hooks/trillion-mcp-call.mjs export_decision '{"case_id":"source:read-proof"}'`;
const command = (text = nativeCommand, exit_code = 0, output = '{}', status = 'completed') => ({
  type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'native-read',
    status, exit_code, command: ['/bin/zsh', '-lc', text], aggregated_output: output } },
});

test('an exact declared native read execution counts with structured arguments, including a failed attempt', () => {
  assert.equal(end([asked('continue'), command()]), null);
  const item = { kind: 'command_completed', exit_code: 1,
    command: ['node', join(homedir(), '.codex/hooks/trillion-mcp-call.mjs'), 'export_decision', '{"case_id":"source:read-proof"}'] };
  assert.deepEqual(nativeReadOf(item), { tool: 'export_decision', arguments: { case_id: 'source:read-proof' }, failed: true });
  assert.equal(end([asked('continue'), command(nativeCommand, 1, JSON.stringify(authorizationFailure))]), null);
  assert.equal(end([asked('continue'), command(nativeCommand.replace('node ', `"${process.execPath}" `))]), null);
});

test('a failed native read is consultation, never a completed decision or failed method credit', () => {
  const output = 'Status: Decided\n\n## Decision\nA choice was made.';
  const rows = [asked('continue'), command(nativeCommand, 1, output)];
  const turn = currentTurn(rows.map(row => JSON.stringify(row)));
  assert.equal(end(rows), null);
  assert.equal(turnDecided(turn), false, 'a nonzero native process cannot certify the text it printed');
});

test('echoed, quoted and composed commands never substitute for a native read', () => {
  for (const text of [
    `echo ${JSON.stringify(nativeCommand)}`, `printf '%s' ${JSON.stringify(nativeCommand)}`,
    `bash -c ${JSON.stringify(nativeCommand)}`, `node -e ${JSON.stringify(nativeCommand)}`,
    `node --input-type=module <<'JS'\n${nativeCommand}\nJS`,
    `${nativeCommand}; true`, `${nativeCommand} && true`, `${nativeCommand} || true`,
    `${nativeCommand} | cat`, `${nativeCommand} > result.json`, `${nativeCommand} # comment`,
    `echo done\n${nativeCommand}`, `node $(echo ~/.codex/hooks/trillion-mcp-call.mjs) export_decision '{}'`,
  ]) assert.match(end([asked('continue'), command(text)]), /Ask Trillion/, text);
});

test('a lookalike caller, rejected arguments and a non-read tool never count', () => {
  for (const text of [
    nativeCommand.replace('~/.codex/hooks/', '/tmp/'),
    nativeCommand.replace('trillion-mcp-call.mjs', 'trillion-mcp-call.mjs.bak'),
    nativeCommand.replace('~/.codex/hooks/trillion-mcp-call.mjs', "'~/.codex/hooks/trillion-mcp-call.mjs'"),
    nativeCommand.replace('export_decision', 'decide'),
    nativeCommand.replace('export_decision', 'read_messages'),
    nativeCommand.replace('{"case_id":"source:read-proof"}', '{}'),
    nativeCommand.replace('{"case_id":"source:read-proof"}', '[]'),
    nativeCommand.replace('{"case_id":"source:read-proof"}', 'null'),
    nativeCommand.replace('{"case_id":"source:read-proof"}', '{"case_id":42}'),
    nativeCommand.replace('{"case_id":"source:read-proof"}', '{"case_id":"   "}'),
    nativeCommand.replace('{"case_id":"source:read-proof"}', '{not-json}'),
    `${nativeCommand} extra`,
  ]) assert.match(end([asked('continue'), command(text)]), /Ask Trillion/, text);
  assert.match(end([asked('continue'), command(nativeCommand, null)]), /Ask Trillion/);
  assert.match(end([asked('continue'), command(nativeCommand, 0, '{}', 'in_progress')]), /Ask Trillion/);
  assert.match(end([asked('continue'), call('pending', 'exec_command', { cmd: nativeCommand })]), /Ask Trillion/);
});

test('native callers and read eligibility remain DATA, with prior turns and generated context excluded', () => {
  const consults = { ...settings.until_the_row_carries_it, read_tools: ['read_messages'] };
  assert.match(end([asked('continue'), command()], {}, { consults }), /Ask Trillion/);
  assert.match(end([asked('before'), command(), asked('after')]), /Ask Trillion/);
  assert.match(end([asked('continue'), { ...command(), isMeta: true }]), /Ask Trillion/);
  assert.match(end([asked('continue'), { ...command(), origin: { kind: 'peer' } }]), /Ask Trillion/);
  assert.match(end([asked('continue'), { ...command(), isCompactSummary: true }]), /Ask Trillion/);
  const custom = { ...settings, native_callers: [{ executables: ['python3'], script: '/declared/read.py', tools: { read_messages: { query: 'string' } } }] };
  assert.equal(end([asked('continue'), command(`python3 /declared/read.py read_messages '{"query":"hello"}'`)], {}, { rules: custom }), null);
});

test('the recorded inline authorization failure is evidence of a failed read, not an eligible native wrapper', () => {
  assert.equal(authorizationFailure.isError, true);
  assert.equal(authorizationFailure.structuredContent.error.correlation.last_worker_phase, 'authorization');
  assert.equal(authorizationFailure.structuredContent.error.correlation.calls[0].dispatch, 'not_observed');
  const inline = `node --input-type=module <<'JS'\nconst receipt = {tool:'export_decision'};\nJS`;
  const rows = [asked('continue'), command(inline, 0, JSON.stringify(authorizationFailure))];
  assert.match(end(rows), /Ask Trillion/);
  assert.equal(turnDecided(currentTurn(rows.map(row => JSON.stringify(row)))), false);
});

test('a turn the person began with no Trillion read is refused, naming the read tools and the missing-claim case', () => {
  const reason = end([asked('can you reach my github'), said('I have no GitHub access.')]);
  assert.match(reason, /Ask Trillion before you finish/);
  assert.match(reason, /read_messages/);
  assert.match(reason, /missing, not connected or not possible/);
});

test('a listed Trillion read tool in the turn allows the end, wherever in the turn it was called', () => {
  assert.equal(end([asked('hi'), call('t1', 'mcp__trillion__take_work'), said('done')]), null);
  assert.equal(end([asked('hi'), call('t1', 'mcp__trillion__list_connections', { app: 'github' }), call('t2', 'Bash', { command: 'ls' }), said('done')]), null);
});

test('only a call counts: naming a tool in text, another server, or a Trillion tool that is not a read tool does not', () => {
  assert.match(end([asked('hi'), said('I will call mcp__trillion__take_work')]), /Ask Trillion/);
  assert.match(end([asked('hi'), call('t1', 'mcp__github__list_repos')]), /Ask Trillion/);
  assert.match(end([asked('hi'), call('t1', 'mcp__trillion__write_file')]), /Ask Trillion/);
});

test('a read in an earlier turn does not count for the current one', () => {
  assert.match(end([asked('first'), call('t1', 'mcp__trillion__take_work'), asked('second'), said('ok')]), /Ask Trillion/);
});

test('Codex nested Trillion calls count as reads', () => {
  const nested = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', id: 'm1', server: 'codex_apps', tool: 'trillion.read_messages', status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: '{}' }] } } } };
  assert.equal(end([asked('hi'), nested]), null);
});

test('the turn is refused once: a hook-active end, no person message and an unreadable transcript all end', () => {
  assert.equal(end([asked('hi')], { stop_hook_active: true }), null);
  assert.equal(end([said('a scheduled thought')]), null);
  assert.equal(judge({ transcript_path: 'x' }, { read: () => { throw new Error('gone'); }, consults: settings.until_the_row_carries_it }), null);
});

test('a harness whose row names another road is never refused, and its own read tools replace the default list', () => {
  assert.equal(end([asked('hi')], {}, { consults: { road: 'instructions-only', read_tools: ['take_work'], claims_need_read: true } }), null);
  const custom = { road: 'turn-end-hook', read_tools: ['find_file'], claims_need_read: false };
  assert.equal(end([asked('hi'), call('t1', 'mcp__trillion__find_file')], {}, { consults: custom }), null);
  const reason = end([asked('hi'), call('t1', 'mcp__trillion__take_work')], {}, { consults: custom });
  assert.match(reason, /find_file/);
  assert.doesNotMatch(reason, /not connected/);
});

test('consultsFor reads the harness row, falls back to the default row, then to the settings shape', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ask-first-'));
  try {
    const rows = join(folder, 'harnesses.json');
    assert.deepEqual(consultsFor('muse', settings, folder), settings.until_the_row_carries_it);
    const one = { road: 'prompt-hook', read_tools: ['take_work'], claims_need_read: false };
    const other = { road: 'turn-end-hook', read_tools: ['search'], claims_need_read: true };
    writeFileSync(rows, JSON.stringify({ harnesses: [{ id: 'default', consults_trillion: other }, { id: 'muse', consults_trillion: one }] }));
    assert.deepEqual(consultsFor('muse', settings, folder), one);
    assert.deepEqual(consultsFor('never-heard-of-it', settings, folder), other);
    assert.deepEqual(consultsFor('muse', settings, join(folder, 'empty')), settings.until_the_row_carries_it);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
