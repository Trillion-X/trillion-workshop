import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, sendToTrillion, historicalRules, recordNew } from '../harness/record-every-message.mjs';

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const messages = [
  { conversation_id: 'native:original-session', app: 'A transcript app', speaker: 'person', text: 'An old request.', at: '2026-06-01T10:00:00Z', source_ref: 'original-person-id' },
  { conversation_id: 'native:original-session', app: 'A transcript app', speaker: 'ai', text: 'The original reply.', at: '2026-06-01T10:01:00Z', source_ref: 'original-ai-id' },
];
function stub(t, answer) {
  const previous = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return answer(calls.at(-1)); };
  t.after(() => { globalThis.fetch = previous; }); return calls;
}
const options = () => ({ rules: { ...settings, historical: true }, deadline: Date.now() + 5000, key: 'fictional-key' });

test('historical person turns use the archive road and keep original identity and words', async t => {
  const calls = stub(t, () => Response.json({ into: 'private', conversation_id: messages[0].conversation_id, messages: 2, added: 2, already_there: 0, missing_attachments: [] }));
  assert.equal(await sendToTrillion(messages, options()), true);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/mcp/api/chats/import-history');
  assert.deepEqual(calls[0].body.conversation.messages.map(row => [row.id, row.speaker, row.text, row.at]), messages.map(row => [row.source_ref, row.speaker, row.text, row.at]));
  assert.equal(calls[0].body.space_id, undefined);
});

test('unavailable archive service never falls back to inbound; retry uses the same original data', async t => {
  let working = false; const calls = stub(t, () => working ? Response.json({ into: 'private', conversation_id: messages[0].conversation_id, messages: 2, added: 0, already_there: 2, missing_attachments: [] }) : Response.json({ error: 'unavailable' }, { status: 404 }));
  assert.equal(await sendToTrillion(messages, options()), false);
  working = true; assert.equal(await sendToTrillion(messages, options()), true);
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.ok(calls.every(call => new URL(call.url).pathname === '/mcp/api/chats/import-history'));
});

test('wrong conversation acknowledgement and missing attachments refuse cursor acceptance', async t => {
  stub(t, () => Response.json({ into: 'private', conversation_id: 'another-conversation', messages: 2, added: 2, already_there: 0, missing_attachments: [] }));
  assert.equal(await sendToTrillion(messages, options()), false);
});


test('a missing attachment acknowledgement never advances historical acceptance', async t => {
  stub(t, () => Response.json({ into: 'private', conversation_id: messages[0].conversation_id, messages: 2, added: 2, already_there: 0, missing_attachments: [{ id: 'original-file' }] }));
  assert.equal(await sendToTrillion(messages, options()), false);
});

test('full historical recording starts independently of an acknowledged live position', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-independent-history-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const session = 'original-history-session';
  const transcript = join(folder, 'original.jsonl');
  writeFileSync(transcript, [
    { type: 'session_meta', payload: { id: session, source: 'vscode' } },
    { type: 'response_item', timestamp: '2026-06-01T10:00:00Z', payload: { type: 'message', role: 'user', id: 'original-person-id', internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.input_text'] }, content: [{ type: 'input_text', text: 'An old request.' }] } },
    { type: 'response_item', timestamp: '2026-06-01T10:01:00Z', payload: { type: 'message', role: 'assistant', id: 'original-ai-id', content: [{ type: 'output_text', text: 'The original reply.' }] } },
  ].map(row => JSON.stringify(row) + '\n').join(''));
  const live = { ...settings, executions_path: undefined, cursor_folder: join(folder, 'live'), history: { ...settings.history, cursor_folder: join(folder, 'history') }, time_box_ms: 5000 };
  const event = { transcript_path: transcript, session_id: session };
  await recordNew(event, { rules: live, key: () => 'fictional-key', send: async () => true });
  const liveFile = join(live.cursor_folder, session + '.json');
  const liveBefore = readFileSync(liveFile, 'utf8');
  const archived = [];
  const rules = historicalRules(live);
  const result = await recordNew(event, { rules, key: () => 'fictional-key', send: async rows => { archived.push(...rows); return true; } });
  assert.equal(result.sent, 2);
  assert.deepEqual(archived.map(row => [row.speaker, row.text, row.at, row.source_ref]), messages.map(row => [row.speaker, row.text, new Date(row.at).toISOString(), row.source_ref]));
  assert.equal(readFileSync(liveFile, 'utf8'), liveBefore);
  const replay = await recordNew(event, { rules, key: () => 'fictional-key', send: async () => assert.fail('acknowledged history must not resend') });
  assert.equal(replay.sent, 0);
  assert.equal(replay.pending, 0);
});

test('historical recording refuses absent or shared checkpoints', () => {
  assert.throws(() => historicalRules({ ...settings, history: {} }), /own checkpoint/);
  assert.throws(() => historicalRules({ ...settings, history: { cursor_folder: settings.cursor_folder } }), /own checkpoint/);
  assert.throws(() => historicalRules({ ...settings, history: { cursor_folder: join(settings.cursor_folder, 'nested', '..') } }), /own checkpoint/);
});
