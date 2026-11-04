import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageIdOf } from '../src/messages.mjs';

test('the source receiver can identify a later final answer in the exact Codex transcript', () => {
  const root = mkdtempSync(join(tmpdir(), 'trillion-source-return-'));
  const folder = join(root, 'sessions', '2026', '09', '30');
  mkdirSync(folder, { recursive: true });
  const thread = '01a0cee9-02df-76e2-a6ea-6f202cbd0668';
  const handoff_id = 'h_1244a791e9d2e9e657de820b';
  const at = '2026-09-30T07:30:00.000Z';
  const said = `Handoff ${handoff_id}: The live check passed.`;
  writeFileSync(join(folder, `rollout-${thread}.jsonl`), [
    { type: 'session_meta', timestamp: '2026-09-30T07:00:00.000Z', payload: { id: thread } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', id: 'msg_final', role: 'assistant',
      phase: 'final_answer', content: [{ type: 'output_text', text: said }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const handoff = { handoff_id, state: 'finished', finished_at: '2026-09-30T07:20:00.000Z',
    input: { arrived: { source_id: `codex:${thread}` } }, result: { state: 'completed', outcome: 'The live check passed.' } };
  const run = (value, id = 'msg_final') => JSON.parse(execFileSync(process.execPath,
    ['harness/verify-source-return.mjs', '--harness', 'codex', '--session', thread], {
      cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, CODEX_HOME: root },
      input: JSON.stringify({ handoff: value, transcript_message_id: id }), encoding: 'utf8',
    }));
  assert.deepEqual(run(handoff), { message_id: messageIdOf({ conversation_id: `codex:${thread}`, app: 'Codex',
    speaker: 'ai', at, text: said }), transcript_message_id: 'msg_final' });
  assert.throws(() => run({ ...handoff, input: { arrived: { source_id: 'codex:other' } } }), /does not belong/);
  assert.throws(() => run(handoff, 'msg_other'), /not present/);
});

test('the same receiver script checks an answer in the exact Claude Code transcript, chosen by the row', () => {
  const home = mkdtempSync(join(tmpdir(), 'trillion-source-return-claude-'));
  const folder = join(home, '.claude', 'projects', 'proof');
  mkdirSync(folder, { recursive: true });
  const session = '11a0cee9-02df-76e2-a6ea-6f202cbd0668';
  const handoff_id = 'h_2244a791e9d2e9e657de820b';
  const at = '2026-09-30T07:30:00.000Z';
  const said = `Handoff ${handoff_id}: The live check passed.`;
  writeFileSync(join(folder, `${session}.jsonl`), [
    { type: 'assistant', uuid: 'row-final', sessionId: session, timestamp: at, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: said }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const handoff = { handoff_id, state: 'finished', finished_at: '2026-09-30T07:20:00.000Z',
    input: { arrived: { source_id: `claude-code:${session}` } }, result: 'The live check passed.' };
  const run = (harness, id = 'row-final') => execFileSync(process.execPath,
    ['harness/verify-source-return.mjs', '--harness', harness, '--session', session], {
      cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HOME: home },
      input: JSON.stringify({ handoff, transcript_message_id: id }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.deepEqual(JSON.parse(run('claude-code')), { message_id: messageIdOf({ conversation_id: `claude-code:${session}`,
    app: 'Claude Code', speaker: 'ai', at, text: said }), transcript_message_id: 'row-final' });
  assert.throws(() => run('claude-code', 'row-other'), /not present/);
  assert.throws(() => run('muse'), /No transcript verifier/);
});
