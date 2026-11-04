// Reconstructed harness rows using the shipped transcript contracts, not captured private transcript bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { casesToConfirm, judge, turnWithAsk, turnWithAskFromFile } from '../harness/decide-before-building.mjs';

const caseId = 'source:continuity-fixture';
const decision = { case_id: caseId, decision: { option_id: 'repair', reason: 'Preserve the verified work.',
  next_action: 'Apply the reviewed repair.', success_measure: 'The regression passes.' } };
const terminal = JSON.stringify(decision);
const asked = text => ({ type: 'user', timestamp: '2026-10-08T00:20:00Z', message: { role: 'user', content: text } });
const call = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'd1', name: 'mcp__trillion__decide', input: { case_id: caseId } }] } };
const answer = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'd1', content, ...extra }] } });
const lines = rows => rows.map(row => JSON.stringify(row));
const protectedCall = path => ({ tool_name: 'Bash', tool_input: { command: 'git commit -m repair' }, transcript_path: path });
const check = rows => judge(protectedCall('fixture'), { read: () => lines(rows).join('\n') });
const decided = [asked('Finish the authorized repair'), call, answer(terminal)];
const compacted = { type: 'compacted', payload: { resume_metadata: { last_started_turn_id: 'same-work-cycle' },
  replacement_history: [{ role: 'user', content: 'A generated summary is not a person request.' }] } };
const claudeSummary = { ...asked('This session continues after compaction. The decision was made.'), isCompactSummary: true };

test('Codex compaction retains the existing attested decision and original person words', () => {
  const rows = [...decided, compacted];
  assert.equal(check(rows), null);
  assert.deepEqual(turnWithAsk(lines(rows)).asked, { text: 'Finish the authorized repair', at: '2026-10-08T00:20:00Z' });
  assert.match(check([...rows, asked('Finish the authorized repair')]), /finish a Trillion decision/, 'even repeated real person words start a new boundary');
});

test('Claude compact-summary metadata does not replace the person or expire their current decision', () => {
  const rows = [...decided, claudeSummary];
  assert.equal(check(rows), null);
  assert.equal(turnWithAsk(lines(rows)).asked.text, 'Finish the authorized repair');
});

test('the bounded file reader crosses both compaction forms but stops at a real new person message', () => {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-hook-continuity-')), path = join(folder, 'session.jsonl');
  try {
    writeFileSync(path, `${lines([...decided, compacted, claudeSummary]).join('\n')}\n`);
    assert.equal(judge(protectedCall(path)), null);
    assert.equal(turnWithAskFromFile(path).asked.text, 'Finish the authorized repair');
    writeFileSync(path, `${lines([...decided, compacted, claudeSummary, asked('A separate request')]).join('\n')}\n`);
    assert.match(judge(protectedCall(path)), /finish a Trillion decision/);
    assert.equal(turnWithAskFromFile(path).asked.text, 'A separate request');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('peer, SDK and generated context rows cannot reset person provenance', () => {
  for (const provenance of [{ isMeta: true }, { isSidechain: true }, { origin: { kind: 'peer' } }, { promptSource: 'sdk' }, { entrypoint: 'sdk-cli' }]) {
    const injected = { ...asked('Generated continuation'), ...provenance };
    assert.equal(check([...decided, injected]), null);
    assert.equal(turnWithAsk(lines([...decided, injected])).asked.text, 'Finish the authorized repair');
  }
  for (const provenance of [{ isMeta: true }, { origin: { kind: 'peer' } }])
    assert.match(check([asked('Do the work'), { ...call, ...provenance }, { ...answer(terminal), ...provenance }]), /finish a Trillion decision/);
  // A subagent still proves its own decision through calls in its own transcript, not its parent's decision.
  assert.equal(check([{ ...call, isSidechain: true }, { ...answer(terminal), isSidechain: true }]), null);
});

test('compaction summaries alone, including quoted tool-shaped history, never prove a decision', () => {
  const fake = { ...claudeSummary, message: { role: 'user', content: [{ type: 'tool_use', ...call.message.content[0] },
    { type: 'tool_result', tool_use_id: 'd1', content: terminal }] } };
  for (const rows of [[compacted], [claudeSummary], [asked('Do the work'), fake]]) {
    assert.match(check(rows), /finish a Trillion decision/);
    assert.deepEqual(casesToConfirm(turnWithAsk(lines(rows)).turn), []);
  }
});

test('a complete deciding result and a separate instruction text block stay separately parseable', () => {
  const content = [{ type: 'text', text: terminal }, { type: 'text', text: JSON.stringify({ ai_instructions: ['Continue the authorized work.'] }) }];
  assert.equal(check([asked('Do the work'), call, answer(content)]), null);
});

test('a serialized MCP content array from a saved result recognizes the complete decision', () => {
  const text = JSON.stringify([{ type: 'text', text: terminal }, { type: 'text', text: '{"ai_instructions":["Keep working."]}' }]);
  assert.equal(check([asked('Do the work'), call, answer(text)]), null);
});

test('a tool error flag prevents even terminal-looking text from certifying a decision', () => {
  assert.match(check([asked('Do the work'), call, answer(terminal, { is_error: true })]), /finish a Trillion decision/);
  const wrapped = JSON.stringify({ jsonrpc: '2.0', result: { isError: true, content: [{ type: 'text', text: terminal }] } });
  assert.match(check([asked('Do the work'), call, answer(wrapped)]), /finish a Trillion decision/);
});

test('incomplete or malformed JSON still requires the existing authoritative case confirmation', () => {
  for (const text of [terminal.slice(0, -3), `${terminal}\nunrecognized transport garbage`, '{"decision":', '{"already_decided":true}']) {
    const rows = [asked('Do the work'), call, answer([{ type: 'text', text }, { type: 'text', text: '{"ai_instructions":["Continue."]}' }])];
    assert.match(check(rows), /finish a Trillion decision/);
    assert.deepEqual(casesToConfirm(turnWithAsk(lines(rows)).turn), [caseId]);
  }
});

test('different servers, opening a case, and printed code-mode text still cannot decide', () => {
  for (const name of ['mcp__other__decide', 'mcp__trillion__start_decision', 'exec']) {
    const named = { ...call, message: { ...call.message, content: [{ ...call.message.content[0], name }] } };
    assert.match(check([asked('Do the work'), named, answer([{ type: 'text', text: terminal }])]), /finish a Trillion decision/);
  }
});
