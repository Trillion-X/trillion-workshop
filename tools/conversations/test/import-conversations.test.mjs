// tools/conversations/test/import-conversations.test.mjs
//
// The import of every app's conversations over the records door (read-data/chat-import.mjs), against the fake door of
// tools/records-door with exactly the import rows' rights, over a made-up home folder that holds one synthetic export
// or session folder for each source (a bakery's questions): a ChatGPT, a Claude.ai and a Grok account export, Google
// Takeout activity for Gemini Apps, Assistant and AI Mode, and the sessions of Claude Code, Codex (archived too),
// Gemini CLI and Hermes. It checks what each source keeps, that a second run adds nothing, that a door that answers
// 503 midway stops the run with its cursor rows where they were and a resume finishes with nothing kept twice, that a
// write the door does not answer in time is sent again with its own request key, and the counts read back per app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { conversationImportProgress, countConversationsPerApp, importConversationsFrom, keepWhatISaidToAnAi, listConversationSourcesHere, resumeConversationImports } from '../read-data/chat-import.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const importRow = rows.find(row => row.id === 'tool:import-my-conversations-from-a-source');
const RIGHTS = importRow.invoke.records.rights;
const NOW = new Date('2026-11-04T12:00:00Z');

const lines = list => list.map(row => JSON.stringify(row) + '\n').join('');
function put(home, path, text) { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), text); }

// One synthetic export or session folder for each source the import knows.
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'conversations-home-'));
  const tree = (id, title, turns, start) => ({ id, title, create_time: start, current_node: `${id}-${turns.length}`,
    mapping: Object.fromEntries(turns.map(([role, text], index) => [`${id}-${index + 1}`, { id: `${id}-${index + 1}`, parent: index ? `${id}-${index}` : null,
      message: { author: { role }, create_time: start + index * 10, content: { parts: [text] }, metadata: { model_slug: role === 'assistant' ? 'gpt-4o' : undefined } } }])) });
  put(home, 'Downloads/chatgpt-export/conversations.json', JSON.stringify([
    tree('cg-1', 'Rye levain', [['user', 'How long does a rye levain ferment?'], ['assistant', 'Twelve to sixteen hours.']], 1735700000),
    tree('cg-2', 'Croissant butter', [['user', 'Which butter for croissants?'], ['assistant', 'A dry European butter, 82 percent fat.'], ['user', 'And the lamination temperature?'], ['assistant', 'Keep the butter near 13 C.']], 1735800000),
    tree('cg-3', 'A long recipe', [['user', `Here is my whole recipe book:\n${'flour, water, salt. '.repeat(2000)}`], ['assistant', 'That is a lot of bread.']], 1735900000),
  ]));
  put(home, 'Downloads/claude-data/conversations.json', JSON.stringify([
    { uuid: 'cl-1', name: 'Sourdough schedule', created_at: '2025-01-02T10:00:00.000000Z', chat_messages: [
      { uuid: 'cl-1-a', sender: 'human', text: 'When should I feed the starter?', content: [{ type: 'text', text: 'When should I feed the starter?' }], created_at: '2025-01-02T10:00:00.000000Z' },
      { uuid: 'cl-1-b', sender: 'assistant', text: 'Feed it every morning.', content: [{ type: 'text', text: 'Feed it every morning.' }], created_at: '2025-01-02T10:00:05.000000Z' }] },
    { uuid: 'cl-2', name: 'Oven spring', created_at: '2025-01-03T10:00:00.000000Z', chat_messages: [
      { uuid: 'cl-2-a', sender: 'human', text: 'Why no oven spring?', content: [{ type: 'text', text: 'Why no oven spring?' }], created_at: '2025-01-03T10:00:00.000000Z' },
      { uuid: 'cl-2-b', sender: 'assistant', text: 'Usually under-proofed dough.', content: [{ type: 'text', text: 'Usually under-proofed dough.' }], created_at: '2025-01-03T10:00:09.000000Z' }] },
  ]));
  put(home, 'Downloads/grok/prod-grok-backend.json', JSON.stringify({ conversations: [{ conversation: { id: 'gk-1', title: 'Hydration' }, responses: [
    { response: { _id: 'gk-1-a', sender: 'human', message: 'What hydration for a country loaf?', create_time: { $date: { $numberLong: '1736000000000' } } } },
    { response: { _id: 'gk-1-b', sender: 'ASSISTANT', message: 'About 75 percent.', create_time: { $date: { $numberLong: '1736000003000' } }, model: 'grok-3' } }] }] }));
  put(home, 'Downloads/Takeout/My Activity/Gemini Apps/MyActivity.json', JSON.stringify([
    { header: 'Gemini Apps', title: 'Prompted what flour for bagels', time: '2025-02-01T09:00:00.123Z', safeHtmlItem: [{ html: '<p>Use <b>high-gluten</b> flour &amp; malt.</p>' }] },
    { header: 'Gemini Apps', title: 'Prompted how long to boil bagels', time: '2025-02-01T09:05:00Z', safeHtmlItem: [{ html: '<p>One minute a side.</p>' }] }]));
  put(home, 'Downloads/Takeout/My Activity/Assistant/MyActivity.json', JSON.stringify([
    { header: 'Assistant', title: 'Said set a timer for 20 minutes', time: '2025-02-02T09:00:00Z', subtitles: [{ name: 'OK, 20 minutes, starting now.' }] }]));
  put(home, 'Downloads/Takeout/My Activity/AI Mode/MyActivity.json', JSON.stringify([
    { header: 'AI Mode', title: 'Searched for best proofing basket', time: '2025-02-03T09:00:00Z', safeHtmlItem: [{ html: 'A rattan banneton.' }] }]));
  const claudeSession = '11111111-2222-3333-4444-555555555555';
  put(home, `.claude/projects/-bakery/${claudeSession}.jsonl`, lines([
    { type: 'user', sessionId: claudeSession, uuid: 'cc-1', timestamp: '2026-10-01T10:00:00Z', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'Add a sourdough recipe page.' } },
    { type: 'assistant', sessionId: claudeSession, uuid: 'cc-2', timestamp: '2026-10-01T10:00:30Z', message: { role: 'assistant', model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'I added the page.' }] } },
  ]));
  const codex = (id, text, reply) => lines([
    { type: 'session_meta', timestamp: '2026-10-02T10:00:00Z', payload: { id, source: 'cli' } },
    { type: 'response_item', timestamp: '2026-10-02T10:00:01Z', payload: { type: 'message', role: 'user', id: `${id}-u`, internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.input_text'] }, content: [{ type: 'input_text', text }] } },
    { type: 'response_item', timestamp: '2026-10-02T10:00:09Z', payload: { type: 'message', role: 'assistant', id: `${id}-a`, phase: 'final_answer', content: [{ type: 'output_text', text: reply }] } },
  ]);
  put(home, '.codex/sessions/2026/10/02/rollout-aaaaaaaa-0001.jsonl', codex('aaaaaaaa-0001', 'Price the rye loaf.', 'Six dollars.'));
  put(home, '.codex/archived_sessions/rollout-aaaaaaaa-0002.jsonl', codex('aaaaaaaa-0002', 'Print the order sheet.', 'Printed.'));
  put(home, '.gemini/tmp/abc123/chats/session-2026-10-03.json', JSON.stringify({ sessionId: 'gem-1', projectHash: 'abc123', messages: [
    { type: 'user', timestamp: '2026-10-03T10:00:00Z', content: 'List the oven temperatures.' },
    { type: 'gemini', timestamp: '2026-10-03T10:00:04Z', model: 'gemini-x', content: 'Bread 230 C, pastry 200 C.' }] }));
  put(home, '.hermes/sessions/session_20261004.json', JSON.stringify({ session_id: 'hermes-1', session_start: '2026-10-04T10:00:00Z', model: 'hermes-x', messages: [
    { role: 'user', timestamp: '2026-10-04T10:00:00Z', content: 'Remind me to order flour.' },
    { role: 'assistant', timestamp: '2026-10-04T10:00:02Z', content: 'I will remind you on Friday.' }] }));
  put(home, 'Downloads/notes/conversations.json', JSON.stringify([{ unrelated: true }]));
  return { home, codexLive: '.codex/sessions/2026/10/02/rollout-aaaaaaaa-0001.jsonl' };
}

// The fake door with the row's rights, reached through a fetch that can answer 503 or hold a call for a stretch of calls.
async function doorFor({ records = [] } = {}) {
  const fake = await startFakeDoor({ rights: RIGHTS, records });
  const trouble = { busyFrom: Infinity, busyCalls: 0, hangOnce: null, calls: 0 };
  const fetchImpl = async (url, init) => {
    trouble.calls += 1;
    if (trouble.calls >= trouble.busyFrom && trouble.busyCalls > 0) { trouble.busyCalls -= 1; return new Response('', { status: 503 }); }
    if (trouble.hangOnce && init.body.includes('"records:write"') && trouble.calls >= trouble.hangOnce) {
      trouble.hangOnce = null;
      // The write lands at the door, but its answer never comes back within the call's time.
      await fetch(url, init);
      return new Promise(() => {});
    }
    return fetch(url, init);
  };
  const door = openRecordsDoor({ descriptor: fake.descriptor, fetchImpl, wait: async () => {} });
  return { fake, door, trouble, context: { door, wait: async () => {}, now: () => NOW } };
}

const ofType = (fake, type) => [...fake.kept.values()].filter(record => record.type === type);
const request = (home, input) => ({ input, folder: home });
const SOURCES = ['chatgpt-export', 'claude-ai-export', 'grok-export', 'gemini-apps-activity', 'google-assistant-activity', 'google-ai-mode-activity', 'claude-code-sessions', 'codex-sessions', 'gemini-cli-sessions', 'hermes-sessions'];

test('the sources on this computer are found where their rows say, each export told apart by what it holds', async t => {
  const { home } = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { sources } = await listConversationSourcesHere(request(home, {}));
  const files = Object.fromEntries(sources.map(source => [source.source, source.found]));
  assert.deepEqual(files['chatgpt-export'], ['Downloads/chatgpt-export/conversations.json']);
  assert.deepEqual(files['claude-ai-export'], ['Downloads/claude-data/conversations.json']);
  assert.deepEqual(files['grok-export'], ['Downloads/grok/prod-grok-backend.json']);
  assert.deepEqual(files['gemini-apps-activity'], ['Downloads/Takeout/My Activity/Gemini Apps/MyActivity.json']);
  assert.deepEqual(files['google-assistant-activity'], ['Downloads/Takeout/My Activity/Assistant/MyActivity.json']);
  assert.deepEqual(files['google-ai-mode-activity'], ['Downloads/Takeout/My Activity/AI Mode/MyActivity.json']);
  assert.equal(files['claude-code-sessions'].length, 1);
  assert.deepEqual(files['codex-sessions'], ['.codex/archived_sessions/rollout-aaaaaaaa-0002.jsonl', '.codex/sessions/2026/10/02/rollout-aaaaaaaa-0001.jsonl']);
  assert.equal(files['gemini-cli-sessions'].length, 1);
  assert.equal(files['hermes-sessions'].length, 1);
  await assert.rejects(listConversationSourcesHere({ input: {} }), /folder the person granted/);
});

test('each source keeps one row per conversation and its messages, and a second run adds nothing', async t => {
  const { home } = makeHome();
  const { fake, context } = await doorFor();
  t.after(async () => { rmSync(home, { recursive: true, force: true }); await fake.close(); });
  const kept = {};
  for (const source of SOURCES) {
    const result = await importConversationsFrom(request(home, { source }), context);
    assert.equal(result.done, true, `${source}: ${JSON.stringify(result)}`);
    assert.equal(result.more, false);
    assert.deepEqual(result.conversations_refused, [], source);
    kept[source] = [result.conversations_kept, result.messages_added];
  }
  assert.deepEqual(kept, {
    'chatgpt-export': [3, 10], 'claude-ai-export': [2, 4], 'grok-export': [1, 2], 'gemini-apps-activity': [2, 4],
    'google-assistant-activity': [1, 2], 'google-ai-mode-activity': [1, 2], 'claude-code-sessions': [1, 2],
    'codex-sessions': [2, 4], 'gemini-cli-sessions': [1, 2], 'hermes-sessions': [1, 2],
  });
  // ChatGPT's long message is kept in parts that each fit one door write; 8 messages are 10 kept messages.
  const messages = ofType(fake, 'message').map(record => record.value);
  assert.equal(messages.length, 34);
  const parts = messages.filter(message => message.source_ref?.startsWith('cg-3-1:part-'));
  assert.equal(parts.length, 3);
  assert.ok(parts.every(message => message.text.length <= 16000));
  assert.equal(ofType(fake, 'message-source-key').length, 34);
  // Messages carry where they came from and their original time; the row the list keeps names the facts only.
  const rye = messages.find(message => message.source_ref === 'cg-1-2');
  assert.deepEqual([rye.conversation_id, rye.app, rye.speaker, rye.text, rye.at, rye.model, rye.captured_road], ['ChatGPT:cg-1', 'ChatGPT', 'ai', 'Twelve to sixteen hours.', '2025-01-01T02:53:30.000Z', 'gpt-4o', 'chat_import']);
  const codex = messages.find(message => message.source_ref === 'aaaaaaaa-0001-u');
  assert.deepEqual([codex.conversation_id, codex.app, codex.speaker], ['codex:aaaaaaaa-0001', 'Codex', 'person']);
  const row = fake.kept.get('record:ai-conversation:cg-2').value;
  assert.deepEqual(row, { title: 'Croissant butter', app: 'ChatGPT', conversation_id: 'ChatGPT:cg-2', messages: 4, started: '2025-01-02T06:40:00.000Z', last: '2025-01-02T06:40:30.000Z', models: ['gpt-4o'], original_file: 'Downloads/chatgpt-export/conversations.json' });
  assert.equal(fake.kept.get('record:ai-conversation:codex-aaaaaaaa-0002').value.messages, 2);
  assert.equal(fake.kept.get('record:ai-conversation:cl-1').value.title, 'Sourdough schedule');
  assert.ok(fake.kept.get('list:ai-conversations'), 'the list is made once');

  const counted = await countConversationsPerApp({ input: {} }, context);
  assert.equal(counted.conversations, 15);
  assert.deepEqual(Object.fromEntries(counted.apps.map(app => [app.app, [app.conversations, app.messages]])), {
    ChatGPT: [3, 10], Claude: [2, 4], Codex: [2, 4], Gemini: [2, 4], Grok: [1, 2], 'Google Assistant': [1, 2], 'Google AI Mode': [1, 2], 'Claude Code': [1, 2], 'Gemini CLI': [1, 2], Hermes: [1, 2],
  });

  // A label the person set on a row stays through a re-import, and the second run skips every file it finished.
  const labelled = fake.kept.get('record:ai-conversation:cg-1');
  fake.kept.set(labelled.id, { ...labelled, value: { ...labelled.value, labels: ['bread'] } });
  const again = await resumeConversationImports(request(home, {}), context);
  assert.equal(again.more, false);
  assert.ok(again.sources.every(source => source.done && source.messages_added === 0 && source.files_skipped === source.files_found), JSON.stringify(again.sources));
  assert.equal(ofType(fake, 'message').length, 34);
  assert.deepEqual(fake.kept.get('record:ai-conversation:cg-1').value.labels, ['bread']);

  const progress = await conversationImportProgress({ input: {} }, context);
  assert.equal(progress.sources.length, SOURCES.length);
  assert.ok(progress.sources.every(source => source.state === 'done' && source.files_done === source.files_seen));
  assert.deepEqual(progress.sources.find(source => source.source === 'chatgpt-export'), { source: 'chatgpt-export', app: 'ChatGPT', files_seen: 1, files_done: 1, conversations_kept: 3, messages_added: 10, messages_already_kept: 0, attachments_kept: 0, attachments_not_kept: 0, attachments_too_large: 0, state: 'done', updated_at: NOW.toISOString(), files_found: 1 });
});

test('a session that grew is read on from its byte offset, and only the new rows are kept', async t => {
  const { home, codexLive } = makeHome();
  const { fake, context } = await doorFor();
  t.after(async () => { rmSync(home, { recursive: true, force: true }); await fake.close(); });
  await importConversationsFrom(request(home, { source: 'codex-sessions' }), context);
  appendFileSync(join(home, codexLive), lines([
    { type: 'response_item', timestamp: '2026-10-02T11:00:00Z', payload: { type: 'message', role: 'user', id: 'aaaaaaaa-0001-u2', internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.input_text'] }, content: [{ type: 'input_text', text: 'And the spelt loaf?' }] } },
  ]));
  const later = await importConversationsFrom(request(home, { source: 'codex-sessions' }), context);
  assert.deepEqual([later.messages_added, later.messages_already_kept, later.files_skipped], [1, 0, 1]);
  assert.equal(fake.kept.get('record:ai-conversation:codex-aaaaaaaa-0001').value.messages, 3);
});

// The sweep old Trillion's recorder ran every few minutes (record-every-message.mjs --sweep, sweep.changed_within_days 7),
// as a run of the resume tool on a clock: only the AI apps' sessions changed within the window are read, a turn added
// since the last run is kept and nothing before it again, and a run with no window still reads the older session.
test('a sweep reads only the sessions changed within its window, and keeps each new turn once', async t => {
  const { home } = makeHome();
  const { fake, context } = await doorFor();
  t.after(async () => { rmSync(home, { recursive: true, force: true }); await fake.close(); });
  const daysBefore = days => new Date(NOW.getTime() - days * 86_400_000);
  const claudeLive = '.claude/projects/-bakery/11111111-2222-3333-4444-555555555555.jsonl';
  const codexOld = '.codex/archived_sessions/rollout-aaaaaaaa-0002.jsonl';
  for (const file of [claudeLive, '.codex/sessions/2026/10/02/rollout-aaaaaaaa-0001.jsonl', '.gemini/tmp/abc123/chats/session-2026-10-03.json', '.hermes/sessions/session_20261004.json']) utimesSync(join(home, file), daysBefore(1), daysBefore(1));
  utimesSync(join(home, codexOld), daysBefore(30), daysBefore(30));
  const sweep = { sources: ['claude-code-sessions', 'codex-sessions', 'gemini-cli-sessions', 'hermes-sessions'], changed_within_days: 7, time_box_seconds: 100 };

  const first = await resumeConversationImports(request(home, sweep), context);
  assert.equal(first.more, false);
  assert.deepEqual(Object.fromEntries(first.sources.map(source => [source.source, [source.files_found, source.messages_added]])),
    { 'claude-code-sessions': [1, 2], 'codex-sessions': [1, 2], 'gemini-cli-sessions': [1, 2], 'hermes-sessions': [1, 2] });
  assert.ok(!fake.kept.has('record:ai-conversation:codex-aaaaaaaa-0002'), 'a session older than the window is not read');

  appendFileSync(join(home, claudeLive), lines([
    { type: 'user', sessionId: '11111111-2222-3333-4444-555555555555', uuid: 'cc-3', timestamp: '2026-11-04T11:59:00Z', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'Now the rye page.' } },
  ]));
  utimesSync(join(home, claudeLive), daysBefore(0), daysBefore(0));
  const next = await resumeConversationImports(request(home, sweep), context);
  assert.deepEqual(next.sources.map(source => [source.source, source.messages_added, source.messages_already_kept]),
    [['claude-code-sessions', 1, 0], ['codex-sessions', 0, 0], ['gemini-cli-sessions', 0, 0], ['hermes-sessions', 0, 0]]);
  const said = ofType(fake, 'message').filter(record => record.value.speaker === 'person' && record.value.conversation_id === 'claude-code:11111111-2222-3333-4444-555555555555');
  assert.deepEqual(said.map(record => [record.value.text, record.value.at]).sort(), [['Add a sourdough recipe page.', '2026-10-01T10:00:00.000Z'], ['Now the rye page.', '2026-11-04T11:59:00.000Z']]);

  const whole = await resumeConversationImports(request(home, { sources: ['codex-sessions'] }), context);
  assert.deepEqual([whole.sources[0].files_found, whole.sources[0].messages_added], [2, 2]);
});

// A grant of only the AI apps' session folders, not the whole home: the run is handed one of them and told the home they
// are under, so the apps' roots are found where their rows say; a home the granted folder is not inside is refused.
test('a run granted only a session folder reads the apps under the home it names, and refuses a home outside the grant', async t => {
  const { home } = makeHome();
  const { fake, context } = await doorFor();
  t.after(async () => { rmSync(home, { recursive: true, force: true }); await fake.close(); });
  const granted = join(home, '.claude/projects');
  const run = await resumeConversationImports({ input: { sources: ['claude-code-sessions'], home }, folder: granted }, context);
  assert.deepEqual(run.sources.map(source => [source.source, source.files_found, source.messages_added]), [['claude-code-sessions', 1, 2]]);
  await assert.rejects(resumeConversationImports({ input: { home: join(home, 'Downloads') }, folder: granted }, context), /home must be a folder the granted folder is inside/);
});

test('a door that answers 503 midway stops the run where it was kept, and a resume finishes with nothing kept twice', async t => {
  const { home } = makeHome();
  const clean = await doorFor();
  const busy = await doorFor();
  t.after(async () => { rmSync(home, { recursive: true, force: true }); await clean.fake.close(); await busy.fake.close(); });
  for (const source of SOURCES) await importConversationsFrom(request(home, { source }), clean.context);

  // From the 60th call the door answers 503 for longer than the door's own five tries and the run's eight retries.
  Object.assign(busy.trouble, { busyFrom: 60, busyCalls: 1000 });
  const first = await resumeConversationImports(request(home, {}), busy.context);
  assert.equal(first.more, true);
  const stopped = first.sources.find(source => source.stopped);
  assert.match(stopped.stopped, /stayed busy or slow through 9 tries/);
  const keptBefore = ofType(busy.fake, 'message').length;
  assert.ok(keptBefore > 0 && keptBefore < 34, `kept ${keptBefore} before the door went busy`);
  // Every message kept so far has its source key: a message is never written without it, nor a key without its message.
  assert.equal(ofType(busy.fake, 'message-source-key').length, keptBefore);

  busy.trouble.busyCalls = 0;
  const resumed = await resumeConversationImports(request(home, {}), busy.context);
  assert.equal(resumed.more, false, JSON.stringify(resumed));
  const ids = fake => ofType(fake, 'message').map(record => record.id).sort();
  assert.deepEqual(ids(busy.fake), ids(clean.fake));
  assert.equal(ofType(busy.fake, 'record:ai-conversation').length, 15);
  const rowsOf = fake => Object.fromEntries(ofType(fake, 'record:ai-conversation').map(record => [record.id, record.value]));
  assert.deepEqual(rowsOf(busy.fake), rowsOf(clean.fake));
});

test('a short 503 spell is waited out with the same request key, and the run goes on', async t => {
  const { home } = makeHome();
  const { fake, context, trouble } = await doorFor();
  t.after(async () => { rmSync(home, { recursive: true, force: true }); await fake.close(); });
  Object.assign(trouble, { busyFrom: 20, busyCalls: 9 });
  const waits = [];
  const result = await importConversationsFrom(request(home, { source: 'chatgpt-export' }), { ...context, wait: async ms => { waits.push(ms); } });
  assert.equal(result.done, true);
  assert.equal(result.messages_added, 10);
  assert.ok(waits.length >= 1 && waits[0] === 1000, `the run waited ${JSON.stringify(waits)}`);
});

test('a write the door does not answer in time is sent again with its key, and lands once', async t => {
  const { home } = makeHome();
  const { fake, context, trouble } = await doorFor();
  t.after(async () => { rmSync(home, { recursive: true, force: true }); await fake.close(); });
  trouble.hangOnce = 30;
  const result = await importConversationsFrom(request(home, { source: 'chatgpt-export' }), { ...context, rules: { call_timeout_ms: 200 } });
  assert.equal(result.done, true);
  assert.equal(result.messages_added, 10);
  const writes = fake.calls.filter(call => call.method === 'records:write');
  const keys = writes.map(call => call.key);
  assert.ok(keys.length > new Set(keys).size, 'one write was sent again with the key it had');
  assert.equal(ofType(fake, 'message').length, 10);
});

test('a file named directly is read, and a path that leaves the granted folder is refused in words', async t => {
  const { home } = makeHome();
  const { fake, context } = await doorFor();
  t.after(async () => { rmSync(home, { recursive: true, force: true }); await fake.close(); });
  put(home, 'elsewhere/my-claude.json', readFileSync(join(home, 'Downloads/claude-data/conversations.json')));
  const named = await importConversationsFrom(request(home, { source: 'claude-ai-export', files: ['elsewhere/my-claude.json'] }), context);
  assert.deepEqual([named.done, named.conversations_kept, named.messages_added], [true, 2, 4]);
  await assert.rejects(importConversationsFrom(request(home, { source: 'claude-ai-export', files: ['../outside.json'] }), context), /not a file inside the folder you granted/);
  await assert.rejects(importConversationsFrom(request(home, { source: 'some-app' }), context), /source is one of/);
});

// An AI that keeps its chats on its own service (no store on this computer) sends a turn, as old Trillion's record_messages
// took it: the person's words and its reply are kept as messages with their own times, a resend adds nothing, and the
// next turn of the same conversation adds only itself.
test('an AI with no store here keeps a turn through the tool, and the same turn sent again adds nothing', async t => {
  const keepRow = rows.find(row => row.id === 'tool:keep-what-i-said-to-an-ai');
  const fake = await startFakeDoor({ rights: keepRow.invoke.records.rights });
  t.after(() => fake.close());
  const door = openRecordsDoor({ descriptor: fake.descriptor, wait: async () => {} });
  const context = { door, wait: async () => {}, now: () => NOW };
  const turn = { app: 'Muse', conversation_id: 'bakery-1', messages: [
    { id: 'm1', speaker: 'person', text: 'How long does rye proof?', at: '2026-11-04T11:00:00Z' },
    { id: 'm2', speaker: 'ai', text: 'About two hours.', at: '2026-11-04T11:00:05Z' }] };
  assert.deepEqual(await keepWhatISaidToAnAi({ input: turn }, context), { conversation_id: 'Muse:bakery-1', messages: 2, added: 2, already_kept: 0 });
  assert.deepEqual(await keepWhatISaidToAnAi({ input: turn }, context), { conversation_id: 'Muse:bakery-1', messages: 2, added: 0, already_kept: 2 });
  await keepWhatISaidToAnAi({ input: { ...turn, messages: [{ id: 'm3', speaker: 'person', text: 'And spelt?', at: '2026-11-04T11:01:00Z' }] } }, context);
  const kept = ofType(fake, 'message').map(record => [record.value.speaker, record.value.text, record.value.at, record.value.app]).sort((a, b) => a[2].localeCompare(b[2]));
  assert.deepEqual(kept, [['person', 'How long does rye proof?', '2026-11-04T11:00:00.000Z', 'Muse'], ['ai', 'About two hours.', '2026-11-04T11:00:05.000Z', 'Muse'], ['person', 'And spelt?', '2026-11-04T11:01:00.000Z', 'Muse']]);
  await assert.rejects(keepWhatISaidToAnAi({ input: { conversation_id: 'x', messages: [] } }, context), /app is required/);
});

// The engine refuses a Workshop install whose rows declare one record kind twice (record_model_policy installed.rs
// `duplicates`): a row copied from another must not carry its record_model along (Nov 13, a copied row stopped the install).
test('no record kind is declared by two of these rows', () => {
  const declared = rows.flatMap(row => (row.record_model?.kinds ?? []).map(kind => [kind.type, row.id]));
  const seen = new Map();
  for (const [type, id] of declared) { assert.ok(!seen.has(type), `${type} is declared by ${seen.get(type)} and ${id}`); seen.set(type, id); }
});
