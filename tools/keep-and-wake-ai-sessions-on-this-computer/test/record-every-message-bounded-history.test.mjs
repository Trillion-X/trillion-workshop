import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { settings, rowsFrom, recordNew, drainTranscript } from '../harness/record-every-message.mjs';

function fixture(t, oversized = false) {
  const root = mkdtempSync(join(tmpdir(), 'trillion-history-reader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = 'bounded-history-session';
  const path = join(root, 'session.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id: session, source: 'vscode' } },
    { type: 'turn_context', payload: { model: 'original-model' } },
    { type: 'event_msg', payload: { detail: 'tool evidence '.repeat(80) } },
    { type: 'response_item', timestamp: '2026-07-01T10:00:00.000Z', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: oversized ? 'x'.repeat(3000) : 'Original café reply.\n' }] } },
    { type: 'response_item', timestamp: '2026-07-01T10:01:00.000Z', payload: {
      type: 'message', role: 'assistant', id: 'native-original-id', content: [{ type: 'output_text', text: 'Second original reply.' }] } },
  ];
  const lines = rows.map(row => JSON.stringify(row) + '\n');
  writeFileSync(path, lines.join(''));
  const rules = { ...settings, historical: true, cursor_folder: join(root, 'cursors'), transcript_read_bytes: 160,
    transcript_row_bytes: 2048, drain_wait_ms: { first: 1, most: 2 } };
  return { path, session, rules, rows, lines };
}

test('bounded history crosses tool-only pages without losing words, times, context or source positions', async t => {
  const f = fixture(t);
  const sent = [];
  const until = Date.now() + 2000;
  const result = await drainTranscript({ transcript_path: f.path, session_id: f.session }, {
    rules: f.rules, key: () => 'fictional-test-key', sourceReturn: () => {},
    send: async (messages, { deadline }) => { assert.ok(deadline <= until); sent.push(...messages); return true; }, until,
  });
  assert.equal(result.pending, 0);
  assert.equal(result.drained, 2);
  assert.deepEqual(sent.map(message => [message.text, message.at, message.model]), [
    ['Original café reply.\n', '2026-07-01T10:00:00.000Z', 'original-model'],
    ['Second original reply.', '2026-07-01T10:01:00.000Z', 'original-model'],
  ]);
  assert.equal(sent[0].source_ref, `transcript-row:${Buffer.byteLength(f.lines.slice(0, 4).join(''))}`);
  assert.equal(sent[1].source_ref, 'native-original-id');
  const replay = await recordNew({ transcript_path: f.path, session_id: f.session }, {
    rules: f.rules, key: () => 'fictional-test-key', send: async () => assert.fail('an acknowledged row must not resend'),
  });
  assert.equal(replay.sent, 0);
  assert.equal(replay.pending, 0);
});

test('a refused history send leaves the original message available to retry', async t => {
  const f = fixture(t);
  const event = { transcript_path: f.path, session_id: f.session };
  let result;
  let attempted = [];
  for (let pass = 0; pass < 8; pass++) {
    result = await recordNew(event, { rules: f.rules, key: () => 'fictional-test-key',
      send: async messages => { attempted = messages; return false; } });
    if (attempted.length) break;
  }
  assert.equal(result.sent, 0);
  assert.ok(result.pending > 0);
  const kept = JSON.parse(readFileSync(join(f.rules.cursor_folder, f.session + '.json'), 'utf8'));
  assert.ok(kept.offset <= Buffer.byteLength(f.lines.slice(0, 3).join('')));
  const retried = [];
  await recordNew(event, { rules: f.rules, key: () => 'fictional-test-key', send: async messages => { retried.push(...messages); return true; } });
  assert.deepEqual(retried, attempted);
});

test('an oversized source row stops at its original position instead of skipping it', t => {
  const f = fixture(t, true);
  const start = Buffer.byteLength(f.lines.slice(0, 3).join(''));
  const read = rowsFrom(f.path, start, f.rules);
  assert.equal(read.offset, start);
  assert.equal(read.more, true);
  assert.deepEqual(read.rows, []);
  assert.deepEqual(read.blocked_row, { offset: start, byte_limit: 2048 });
});

test('execution history drains across bounded pages when messages were already acknowledged', async t => {
  const f = fixture(t);
  const receipt = { type: 'response_item', timestamp: '2026-07-01T10:02:00.000Z', payload: {
    type: 'function_call', call_id: 'original-call', name: 'read_file', arguments: '{"name_or_identity":"file:original"}' } };
  const bytes = f.lines.join('') + JSON.stringify(receipt) + '\n';
  writeFileSync(f.path, bytes);
  mkdirSync(f.rules.cursor_folder, { recursive: true });
  const cursorFile = join(f.rules.cursor_folder, f.session + '.json');
  writeFileSync(cursorFile, JSON.stringify({ transcript: f.path, harness: 'codex', offset: Buffer.byteLength(bytes),
    context: { model: 'original-model' }, execution_offset: 0, execution_context: {} }));
  const captured = [];
  const result = await drainTranscript({ transcript_path: f.path, session_id: f.session }, {
    rules: { ...f.rules, historical: false }, key: () => 'fictional-test-key', sourceReturn: () => {},
    send: async () => assert.fail('acknowledged messages must not resend'),
    sendExecution: async value => { captured.push(value); return true; }, until: Date.now() + 2000,
  });
  assert.equal(result.pending, 0);
  assert.deepEqual(captured.map(value => value.claimed.tool_call_id), ['original-call']);
  assert.equal(captured[0].claimed.model, 'original-model');
  const current = JSON.parse(readFileSync(cursorFile, 'utf8'));
  assert.equal(current.offset, Buffer.byteLength(bytes));
  assert.equal(current.execution_offset, current.offset);
});

test('an oversized execution page stays pending at its original cursor when messages are at EOF', async t => {
  const f = fixture(t, true);
  mkdirSync(f.rules.cursor_folder, { recursive: true });
  const cursorFile = join(f.rules.cursor_folder, f.session + '.json');
  const executionStart = Buffer.byteLength(f.lines.slice(0, 3).join(''));
  const messageEnd = Buffer.byteLength(f.lines.join(''));
  writeFileSync(cursorFile, JSON.stringify({ transcript: f.path, harness: 'codex', offset: messageEnd,
    context: {}, execution_offset: executionStart, execution_context: {} }));
  const result = await drainTranscript({ transcript_path: f.path, session_id: f.session }, {
    rules: { ...f.rules, historical: false }, key: () => 'fictional-test-key', sourceReturn: () => {},
    send: async () => assert.fail('acknowledged messages must not resend'),
    sendExecution: async () => assert.fail('oversized execution rows must not skip'), until: Date.now() + 2000,
  });
  assert.equal(result.pending, 1);
  assert.deepEqual(result.execution_blocked_row, { offset: executionStart, byte_limit: 2048 });
  const current = JSON.parse(readFileSync(cursorFile, 'utf8'));
  assert.equal(current.offset, messageEnd);
  assert.equal(current.execution_offset, executionStart);
});

test('a refused message does not spin on an execution-only page whose progress was never persisted', async t => {
  const f = fixture(t);
  const receipt = { type: 'response_item', timestamp: '2026-07-01T10:02:00.000Z', payload: {
    type: 'function_call', call_id: 'original-call', name: 'read_file', arguments: '{}' } };
  const bytes = f.lines.join('') + JSON.stringify(receipt) + '\n';
  writeFileSync(f.path, bytes);
  mkdirSync(f.rules.cursor_folder, { recursive: true });
  const cursorFile = join(f.rules.cursor_folder, f.session + '.json');
  const messageStart = Buffer.byteLength(f.lines.slice(0, 3).join(''));
  const messageContext = { model: 'original-model' };
  writeFileSync(cursorFile, JSON.stringify({ transcript: f.path, harness: 'codex', offset: messageStart,
    context: messageContext, execution_offset: 0, execution_context: {} }));
  const captured = [];
  const refused = [];
  const result = await drainTranscript({ transcript_path: f.path, session_id: f.session }, {
    rules: { ...f.rules, historical: false }, key: () => 'fictional-test-key', sourceReturn: () => {},
    send: async batch => { refused.push(batch); return false; },
    sendExecution: async value => { captured.push(value); return true; }, until: Date.now() + 100,
  });
  assert.equal(result.pending, 1, 'the message refusal remains unfinished');
  assert.deepEqual(captured.map(value => value.claimed.tool_call_id), ['original-call'], 'the later execution was accepted exactly once');
  const current = JSON.parse(readFileSync(cursorFile, 'utf8'));
  assert.equal(current.offset, messageStart, 'no refused message was acknowledged');
  assert.deepEqual(current.context, messageContext);
  assert.equal(current.execution_offset, Buffer.byteLength(bytes));
  assert.ok(refused.length > 0);
  assert.ok(refused.every(batch => batch[0].text === 'Original café reply.\n'), 'each retry starts at the original refused row');
});
