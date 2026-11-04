// A chat's turn at the drain always makes its first attempt, however late the turn began (a busy computer reached the
// test "a refused message does not spin on an execution-only page" after its 100 ms had run out, and nothing was tried).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { settings, drainTranscript } from '../harness/record-every-message.mjs';

test('a turn that begins after its time ran out still tries once', async t => {
  const root = mkdtempSync(join(tmpdir(), 'trillion-first-pass-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'chat.jsonl');
  writeFileSync(path, [{ type: 'session_meta', payload: { id: 'first-pass-session', source: 'vscode' } },
    { type: 'response_item', timestamp: '2026-07-01T10:00:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A reply.' }] } }]
    .map(row => JSON.stringify(row) + '\n').join(''));
  const sent = [];
  const result = await drainTranscript({ transcript_path: path, session_id: 'first-pass-session' }, {
    rules: { ...settings, cursor_folder: join(root, 'cursors') }, key: () => 'fictional-test-key', sourceReturn: () => {},
    send: async batch => { sent.push(...batch); return true; }, until: Date.now() - 1000 });
  assert.deepEqual(sent.map(message => message.text), ['A reply.']);
  assert.equal(result.pending, 0);
});
