// harness/record-every-message.mjs: at each turn end, every message the person wrote and every reply the AI wrote since
// the last turn end goes to Trillion word for word with its original time, from Claude Code and Codex transcripts read by
// shape; injected reminders, tool calls and tool results are never messages; the cursor moves only past what was kept,
// so a failed or slow send is retried at the next turn end and a long history arrives over several.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptedBatch, batchAt, drainTranscript, holdLock, messagesOf, personSpeaksIn, recordNew, recordSubmittedPrompt, recordSubmittedPromptWhenTranscriptArrives, sendToTrillion, sessionOfTranscript, settings, harnessOf, transcriptsBehind, wordsOf } from 'trillion-workshop/tools/keep-and-wake-ai-sessions-on-this-computer/harness/record-every-message.mjs';
import * as keepEveryMessage from '../harness/wake-handlers/keep-every-message.mjs';
import { sweeper } from '../harness/wake-handlers/keep-every-message.mjs';

// The Trillion address these tests talk to is the one the caller gives; no address is built in.
process.env.TRILLION_ORIGIN ??= 'https://app.example.com';

// The suite can itself run inside a background job; the hook's own environment must not decide these cases.
delete process.env.CLAUDE_CODE_SESSION_ATTENDED;

const folder = () => tempFolder(join(tmpdir(), 'record-every-message-'));
const lines = rows => rows.map(row => `${JSON.stringify(row)}\n`).join('');
const rulesIn = dir => ({ ...settings, executions_path: null, cursor_folder: join(dir, 'cursors') });

// Rows shaped like ~/.claude/projects/<project>/<session>.jsonl.
const SESSION = '8c5a4d75-c324-4633-aa0a-986edabfc1d5';
// Claude Code marks a row a person typed origin human; the person rule is an allow-list on it.
const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', sessionId: SESSION, origin: { kind: 'human' } };
const claudeRows = [
  { type: 'custom-title', sessionId: SESSION, customTitle: 'x' },
  { ...base, type: 'user', isMeta: true, timestamp: '2026-09-27T18:19:28.357Z', message: { role: 'user', content: '<system-reminder>\nThe user named this session "x".\n</system-reminder>' } },
  { ...base, type: 'user', timestamp: '2026-09-27T18:19:20.677Z', origin: { kind: 'human' }, message: { role: 'user', content: 'You own what an AI sees  when it connects.\n\nRead your brief first.' } },
  { ...base, type: 'user', entrypoint: 'sdk-cli', promptSource: 'sdk', timestamp: '2026-09-27T18:19:21.000Z', message: { role: 'user', content: 'Reply with exactly OK.' } },
  { ...base, type: 'assistant', timestamp: '2026-09-27T18:19:43.943Z', message: { model: 'claude-opus-5-5', id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'abc' }] } },
  { ...base, type: 'assistant', timestamp: '2026-09-27T18:19:45.087Z', message: { model: 'claude-opus-5-5', id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } },
  { ...base, type: 'user', timestamp: '2026-09-27T18:20:25.373Z', toolUseResult: { stdout: 'a' }, message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'a\nb' }] } },
  { ...base, type: 'attachment', timestamp: '2026-09-27T18:20:26.000Z', attachment: { type: 'hook_success', content: 'ok' } },
  { ...base, type: 'attachment', timestamp: '2026-09-27T18:21:19.612Z', attachment: { type: 'queued_command', prompt: '<cross-session-message from="uds:/tmp/x.sock">\nhello\n</cross-session-message>' } },
  { ...base, type: 'attachment', timestamp: '2026-09-27T18:22:00.000Z', attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: 'also do the other thing' } },
  { ...base, type: 'assistant', uuid: 'claude-commentary-row', timestamp: '2026-09-27T18:22:05.762Z', message: { model: 'claude-opus-5-5', id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Now reading the Workshop code.' }] } },
  { ...base, type: 'assistant', timestamp: '2026-09-27T19:08:28.028Z', message: { model: '<synthetic>', id: 'x', role: 'assistant', content: [{ type: 'text', text: 'API Error: 500' }] } },
  { ...base, uuid: 'image-user-row', type: 'user', timestamp: '2026-09-28T00:25:38.933Z', message: { role: 'user', content: [{ type: 'text', text: 'why do i need to refresh[Image #2]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }] } },
  { ...base, type: 'user', isMeta: true, timestamp: '2026-09-28T00:25:38.933Z', message: { role: 'user', content: [{ type: 'text', text: '[Image: source: /private/tmp/2.png]' }] } },
  { ...base, type: 'user', isCompactSummary: true, timestamp: '2026-09-28T03:42:31.839Z', message: { role: 'user', content: 'This session is being continued from a previous conversation.' } },
  { ...base, isSidechain: true, type: 'assistant', timestamp: '2026-09-28T03:43:00.000Z', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'a subagent speaking' }] } },
  { ...base, type: 'user', timestamp: '2026-09-28T03:44:00.000Z', message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>' } },
];

// Rows shaped like ~/.codex/sessions/<y>/<m>/<d>/rollout-<time>-<session>.jsonl.
const CODEX = '01a0e619-c450-7b11-8126-d66630c52dda';
const codexRows = [
  { timestamp: '2026-09-28T03:40:50.486Z', type: 'session_meta', payload: { session_id: CODEX, id: CODEX, cwd: '/x', originator: 'Codex Desktop', source: 'vscode' } },
  { timestamp: '2026-09-28T03:40:59.300Z', type: 'response_item', payload: { type: 'message', id: 'msg_a', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>\n## Skills' }] } },
  { timestamp: '2026-09-28T03:40:59.300Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6', cwd: '/x' } },
  { timestamp: '2026-09-28T03:40:59.300Z', type: 'response_item', payload: { type: 'message', id: 'msg_b', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>\n- Dropbox' }, { type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nx' }, { type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' }] } },
  { timestamp: '2026-09-28T03:41:00.100Z', type: 'response_item', payload: { type: 'message', id: 'msg_c', role: 'user', content: [{ type: 'input_text', text: "Append the line '<!-- probe -->' at the end." }] } },
  { timestamp: '2026-09-28T03:41:00.200Z', type: 'event_msg', payload: { type: 'user_message', message: "Append the line '<!-- probe -->' at the end." } },
  { timestamp: '2026-09-28T03:41:10.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [] } },
  { timestamp: '2026-09-28T03:41:20.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: '*** Begin Patch' } },
  { timestamp: '2026-09-28T03:41:30.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'refused' } },
  { timestamp: '2026-09-28T03:41:49.490Z', type: 'response_item', payload: { type: 'message', id: 'msg_d', role: 'assistant', content: [{ type: 'output_text', text: 'Before changing files, decide it with Trillion.' }], phase: 'final_answer' } },
];

test('the transcript cursor requires a linked work arrival for every founder message', () => {
  const batch = [
    { conversation_id: 'codex:x', app: 'Codex', speaker: 'person', text: 'Fix this', at: '2026-09-28T03:00:00Z' },
    { conversation_id: 'codex:x', app: 'Codex', speaker: 'ai', text: 'Working on it', at: '2026-09-28T03:00:01Z' },
  ];
  assert.equal(acceptedBatch(batch, { ids: ['message:one', 'message:two'] }), false, 'a 200 that only stored words does not complete intake');
  assert.equal(acceptedBatch(batch, { ids: ['message:one', 'message:two'], arrivals: [{ message_id: 'message:one', arrival_id: 'arrival:one' }] }), true);
  assert.equal(acceptedBatch(batch, { ids: ['message:one', 'message:two'], arrivals: [] }), false);
  assert.equal(acceptedBatch(batch.slice(1), { ids: ['message:two'] }), true, 'an AI reply needs no work arrival');
});

test('only finished Codex and Claude replies are marked for device notices', () => {
  const codex = settings.harnesses.find(item => item.id === 'codex');
  const codexMessage = (id, phase) => ({ timestamp: '2026-10-06T21:00:00Z', type: 'response_item', payload: {
    type: 'message', id, role: 'assistant', phase, content: [{ type: 'output_text', text: phase }],
  } });
  const codexReplies = messagesOf([codexMessage('progress', 'commentary'), codexMessage('final', 'final_answer')], codex, { sessionId: CODEX }).messages;
  assert.deepEqual(codexReplies.map(row => row.final_reply), [undefined, true]);
  const claude = settings.harnesses.find(item => item.id === 'claude-code');
  const claudeMessage = (uuid, stop_reason) => ({ ...base, uuid, type: 'assistant', timestamp: '2026-10-06T21:00:00Z', message: {
    model: 'claude', stop_reason, content: [{ type: 'text', text: uuid }],
  } });
  const claudeReplies = messagesOf([claudeMessage('progress', null), claudeMessage('final', 'end_turn')], claude, { sessionId: SESSION }).messages;
  assert.deepEqual(claudeReplies.map(row => row.final_reply), [undefined, true]);
});

test('scheduled and goal continuation text is not misclassified as founder speech', () => {
  const shape = { part_types: ['input_text'] };
  assert.equal(wordsOf([{ type: 'input_text', text: '<heartbeat>\n  <automation_id>follow-through</automation_id>\n</heartbeat>' }], shape), '');
  assert.equal(wordsOf([{ type: 'input_text', text: '<codex_internal_context source="goal">Continue the goal</codex_internal_context>' }], shape), '');
  assert.equal(wordsOf([{ type: 'input_text', text: '<codex_delegation>Agent status</codex_delegation>' }], shape), '');
  assert.equal(wordsOf([{ type: 'input_text', text: '<hook_prompt hook_run_id="stop:6:/work/sample/.codex/hooks.json">Stop blocked.</hook_prompt>' }], shape), '');
});

test('Codex compaction context is not a founder turn, while the same text in a real user row is', () => {
  const harness = settings.harnesses.find(item => item.id === 'codex');
  const text = 'Another language model started to solve this problem and produced a summary of its thinking process.';
  const context = { timestamp: '2026-09-29T16:50:00Z', type: 'compacted', payload: { message: text } };
  const person = { timestamp: '2026-09-29T16:50:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
  assert.deepEqual(messagesOf([context], harness, { sessionId: CODEX }).messages, []);
  assert.equal(messagesOf([person], harness, { sessionId: CODEX }).messages[0].text, text);
});

test('Codex ambient UI content cannot become a person message, while typed words still can', async () => {
  const dir = folder();
  const path = join(dir, `${CODEX}.jsonl`);
  const at = '2026-10-02T09:23:41.733Z';
  const ambient = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
  const row = (text, kinds) => ({ timestamp: at, type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
  } });
  const harness = settings.harnesses.find(item => item.id === 'codex');
  assert.deepEqual(messagesOf([row(ambient, ['additional_content.codex_apps_open_page'])], harness, { sessionId: CODEX }).messages, []);
  assert.deepEqual(messagesOf([row('\n<in-app-browser-context source="ambient-ui-state">\nPage state</in-app-browser-context>', ['user.text'])], harness, { sessionId: CODEX }).messages, []);
  assert.deepEqual(messagesOf([row('\n# Files pasted by the user:\n\n## Screenshot: /work/sample/picture.png', ['user.text'])], harness, { sessionId: CODEX }).messages, []);
  assert.deepEqual(messagesOf([row('\n# Files mentioned by the user:\n\n## Screenshot: /work/sample/picture.png\n\n## My request:\nFix this', ['user.text'])], harness, { sessionId: CODEX }).messages.map(message => message.text), ['Fix this']);
  assert.deepEqual(messagesOf([row('Please fix the intake', ['user.text'])], harness, { sessionId: CODEX }).messages.map(message => message.text), ['Please fix the intake']);
  const mixed = { ...row(ambient, ['additional_content.codex_apps_open_page']), payload: {
    ...row(ambient, ['additional_content.codex_apps_open_page']).payload,
    content: [{ type: 'input_text', text: ambient }, { type: 'input_text', text: 'Please fix the intake' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['additional_content.codex_apps_open_page', 'user.text'] },
  } };
  assert.deepEqual(messagesOf([mixed], harness, { sessionId: CODEX }).messages.map(message => message.text), ['Please fix the intake']);
  writeFileSync(path, lines([codexRows[0], row(ambient, ['additional_content.codex_apps_open_page'])]));
  const sent = [];
  const rules = rulesIn(dir);
  const send = async batch => { sent.push(...batch); return true; };
  const now = () => Date.parse(at);
  assert.equal((await recordSubmittedPrompt({ transcript_path: path, session_id: CODEX, prompt: ambient, harness: 'codex' }, { rules, send, key: () => 'k', now })).sent, 0);
  assert.equal((await recordNew({ transcript_path: path, session_id: CODEX }, { rules, send, key: () => 'k', now })).sent, 0);
  appendFileSync(path, lines([row('Please fix the intake', ['user.text'])]));
  assert.equal((await recordSubmittedPrompt({ transcript_path: path, session_id: CODEX, prompt: 'Please fix the intake', harness: 'codex' }, { rules, send, key: () => 'k', now })).sent, 1);
  assert.deepEqual(sent.map(message => message.text), ['Please fix the intake']);
});

test('Codex prompt hook waits for a matching user transcript row before founder intake', async () => {
  const dir = folder();
  const path = join(dir, `${CODEX}.jsonl`);
  const prompt = 'Another language model started to solve this problem and produced a summary of its thinking process.';
  const event = { transcript_path: path, session_id: CODEX, prompt, harness: 'codex' };
  const sent = [];
  const send = async batch => { sent.push(...batch); return true; };
  const rules = rulesIn(dir);
  const now = () => Date.parse('2026-09-29T16:50:01.000Z');
  writeFileSync(path, lines([codexRows[0], { timestamp: '2026-09-29T16:50:00.000Z', type: 'compacted', payload: { message: prompt } }]));
  assert.equal((await recordSubmittedPrompt(event, { rules, send, key: () => 'k', now })).sent, 0);
  assert.equal((await recordNew(event, { rules, send, key: () => 'k' })).sent, 0);
  assert.deepEqual(sent, []);
  appendFileSync(path, lines([{ timestamp: '2026-09-29T16:50:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }]));
  assert.equal((await recordSubmittedPrompt(event, { rules, send, key: () => 'k', now })).sent, 1);
  assert.equal(sent[0].text, prompt);
});

test('detached Codex prompt capture waits for the real user row and ignores a compaction alone', async () => {
  assert.ok(settings.prompt_wait_ms > 18_000, 'Codex wrote a real user row 18 seconds after the prompt hook ran');
  const dir = folder();
  const path = join(dir, `${CODEX}.jsonl`);
  const prompt = 'Same words can appear in a generated summary or a real person turn.';
  const at = new Date().toISOString();
  const event = { transcript_path: path, session_id: CODEX, prompt, harness: 'codex' };
  const rules = rulesIn(dir);
  const sent = [];
  const send = async batch => { sent.push(...batch); return true; };
  writeFileSync(path, lines([codexRows[0], { timestamp: at, type: 'compacted', payload: { message: prompt } }]));
  const absent = await recordSubmittedPromptWhenTranscriptArrives(event, { rules, send, key: () => 'k', waitMs: 30, pollMs: 5 });
  assert.equal(absent.sent, 0);
  assert.deepEqual(sent, []);
  setTimeout(() => appendFileSync(path, lines([{ timestamp: at, type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }],
  } }])), 30);
  const admitted = await recordSubmittedPromptWhenTranscriptArrives(event, { rules, send, key: () => 'k', waitMs: 250, pollMs: 5 });
  assert.equal(admitted.sent, 1);
  assert.equal(sent[0].text, prompt);
  assert.equal(sent[0].at, at);
  assert.equal((await recordNew(event, { rules, send, key: () => 'k' })).sent, 1);
  assert.equal(sent[0].at, sent[1].at, 'transcript replay uses the prompt identity');
});

test('an agent-to-agent delegation is never sent as a founder prompt', async () => {
  const event = { session_id: CODEX, prompt: '<codex_delegation>Agent status</codex_delegation>', harness: 'codex' };
  assert.equal((await recordSubmittedPrompt(event, { send: async () => { throw new Error('must not send'); }, key: () => 'k' })).sent, 0);
});

test('Claude queued commands use origin provenance even when peer and human text match', async () => {
  const prompt = 'Same words from either sender';
  const at = '2026-09-29T19:00:00.000Z';
  const row = kind => ({ ...base, type: 'attachment', timestamp: at, attachment: { type: 'queued_command', origin: { kind }, prompt } });
  const harness = settings.harnesses.find(item => item.id === 'claude-code');
  assert.deepEqual(messagesOf([row('peer'), row('human')], harness, { sessionId: SESSION }).messages.map(message => message.text), [prompt]);
  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, lines([claudeRows[0], row('peer')]));
  const sent = [];
  const send = async batch => { sent.push(...batch); return true; };
  const now = () => Date.parse(at);
  const event = { hook_event_name: 'UserPromptSubmit', transcript_path: path, session_id: SESSION, prompt, harness: 'claude-code' };
  assert.equal((await recordSubmittedPrompt(event, { rules: rulesIn(dir), send, key: () => 'k', now })).sent, 0);
  assert.equal((await recordSubmittedPrompt({ ...event, origin: { kind: 'peer' } }, { rules: rulesIn(dir), send, key: () => 'k', now })).sent, 0);
  assert.equal((await recordSubmittedPrompt({ ...event, origin: { kind: 'human' } }, { rules: rulesIn(dir), send, key: () => 'k', now })).sent, 1);
  assert.deepEqual(sent.map(message => message.text), [prompt]);
});

test('Claude prompt capture waits for human provenance and never sends an SDK prompt as founder speech', async () => {
  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  const prompt = 'Reply connected after checking Trillion list_pursuits.';
  const at = '2026-09-29T20:57:45.151Z';
  const now = () => Date.parse(at);
  const event = { hook_event_name: 'UserPromptSubmit', transcript_path: path, session_id: SESSION, prompt, harness: 'claude-code' };
  const sent = [];
  const send = async batch => { sent.push(...batch); return true; };
  const rules = rulesIn(dir);
  writeFileSync(path, lines([claudeRows[0]]));
  assert.equal((await recordSubmittedPrompt(event, { rules, send, key: () => 'k', now })).sent, 0, 'an unproven Claude prompt waits for its transcript');
  const sdk = { ...base, type: 'user', timestamp: at, promptSource: 'sdk', turnOrigin: 'sdk', entrypoint: 'sdk-cli', message: { role: 'user', content: prompt } };
  appendFileSync(path, lines([sdk]));
  assert.equal((await recordSubmittedPrompt(event, { rules, send, key: () => 'k', now })).sent, 0);
  assert.equal((await recordSubmittedPrompt({ ...event, promptSource: 'sdk' }, { rules, send, key: () => 'k', now })).sent, 0);
  assert.equal((await recordNew(event, { rules, send, key: () => 'k' })).sent, 0);
  assert.deepEqual(sent, []);
  appendFileSync(path, lines([{ ...base, type: 'user', timestamp: '2026-09-29T20:57:46.151Z', origin: { kind: 'human' }, message: { role: 'user', content: prompt } }]));
  assert.equal((await recordNew(event, { rules, send, key: () => 'k' })).sent, 1, 'identical actual human words still arrive');
});

test('a background job\'s brief is its launcher\'s words, never the person\'s, from the transcript alone', async () => {
  const brief = 'You are an Opus 5.5 coordinator chat, working for the person.';
  const at = '2026-10-07T20:50:00.000Z';
  const bg = { ...base, sessionKind: 'bg' };
  const rows = [
    { ...bg, type: 'user', promptSource: 'typed', turnOrigin: 'human', origin: { kind: 'human' }, timestamp: at, message: { role: 'user', content: brief } },
    { ...bg, type: 'attachment', timestamp: '2026-10-07T20:55:00.000Z', attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: 'Next step from the launcher' } },
    { ...bg, type: 'assistant', timestamp: '2026-10-07T20:50:30.000Z', message: { model: 'claude-opus-5-5', id: 'm', role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } },
  ];
  const harness = settings.harnesses.find(item => item.id === 'claude-code');
  const said = messagesOf(rows, harness, { sessionId: SESSION }).messages;
  assert.deepEqual(said.map(message => [message.speaker, message.text]),
    [['peer', brief], ['peer', 'Next step from the launcher'], ['ai', 'On it.']]);
  // The same words in a session that is not a background job stay the person's.
  const typed = messagesOf([{ ...rows[0], sessionKind: undefined }], harness, { sessionId: SESSION }).messages;
  assert.deepEqual(typed.map(message => message.speaker), ['person']);

  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, lines([claudeRows[0], rows[0]]));
  const sent = [];
  const send = async batch => { sent.push(...batch); return true; };
  const now = () => Date.parse(at);
  const event = { hook_event_name: 'UserPromptSubmit', transcript_path: path, session_id: SESSION, prompt: brief, harness: 'claude-code', origin: { kind: 'human' } };
  const options = { rules: rulesIn(dir), send, key: () => 'k', now, env: {} };
  assert.equal((await recordSubmittedPrompt(event, options)).reason, 'peer prompt', 'the hook sees the brief is the launcher\'s');
  // Before its row is written, a daemon job's prompt waits for the transcript instead of being sent as the person's.
  const early = join(dir, 'early.jsonl');
  writeFileSync(early, lines([claudeRows[0]]));
  const waiting = { ...event, transcript_path: early };
  assert.equal((await recordSubmittedPrompt(waiting, { ...options, env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } })).reason, 'await human transcript');
  assert.equal((await recordSubmittedPrompt(waiting, { ...options, env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } })).sent, 1);
  assert.deepEqual(sent.map(message => message.speaker), ['person']);
  // A wakeup in a background job reaches the hook marked as typed, with no daemon variable; its session's rows decide.
  const wakeup = { ...event, prompt: 'Fleet check: read the release log', transcript_path: path };
  assert.equal((await recordSubmittedPrompt(wakeup, { ...options, env: {} })).reason, 'await human transcript');
  assert.equal(sent.length, 1, 'nothing more was sent as the person\'s');
});

test('founder words use the work intake door while AI replies use the message door', async () => {
  const previousFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => url.endsWith('/inbound') ? { message_id: 'message:one', arrival_id: 'arrival:one' } : { ids: ['message:two'] } };
  };
  try {
    const founder = { conversation_id: 'codex:chat-42', app: 'Codex', speaker: 'person', text: 'Fix this', at: '2026-09-28T03:00:00Z' };
    assert.equal(await sendToTrillion([founder], { rules: settings, deadline: Date.now() + 1000, key: 'test' }), true);
    assert.equal(await sendToTrillion([{ ...founder, speaker: 'ai' }], { rules: settings, deadline: Date.now() + 1000, key: 'test' }), true);
    assert.equal(seen[0].url, 'https://app.example.com/mcp/api/inbound');
    assert.deepEqual(seen[0].body, { route: 'Codex', source_id: 'codex:chat-42', conversation_id: 'codex:chat-42', text: 'Fix this', at: founder.at, from_person: true });
    assert.equal(seen[1].url, 'https://app.example.com/mcp/api/messages');
  } finally { globalThis.fetch = previousFetch; }
});

test('the shared sender stores binary files first and links them to the exact person message and conversation', async () => {
  const previousFetch = globalThis.fetch;
  const seen = [];
  const identity = `1f:${'a'.repeat(64)}`;
  globalThis.fetch = async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => url.endsWith('/namespace/write')
      ? { identity, name: '/messages/claude-code_abc/image-user-row-1.png' }
      : { message_id: 'message:one', arrival_id: 'arrival:one' } };
  };
  try {
    const message = { conversation_id: 'claude-code:session-abc', app: 'Claude Code', speaker: 'person', text: 'What is this?', at: '2026-09-28T00:25:38.933Z', source_ref: 'image-user-row', attachment_sources: [{ data: 'iVBOR', media_type: 'image/png' }] };
    assert.equal(await sendToTrillion([message], { rules: settings, deadline: Date.now() + 1000, key: 'test' }), true);
    assert.equal(seen[0].url, 'https://app.example.com/mcp/api/namespace/write');
    assert.equal(seen[0].body.content_base64, 'iVBOR');
    assert.equal(seen[1].url, 'https://app.example.com/mcp/api/inbound');
    assert.deepEqual(seen[1].body.files, [{ id: identity }]);
    assert.equal(seen[1].body.conversation_id, message.conversation_id);
    assert.equal(seen[1].body.source_ref, message.source_ref);
  } finally { globalThis.fetch = previousFetch; }
});

test('a Claude Code transcript yields the person\'s messages and the AI\'s replies, verbatim, and nothing injected', () => {
  const harness = harnessOf(claudeRows);
  assert.equal(harness.app, 'Claude Code');
  const { messages } = messagesOf(claudeRows, harness, { sessionId: SESSION });
  assert.deepEqual(messages.map(({ speaker, text, at }) => [speaker, text, at]), [
    ['person', 'You own what an AI sees  when it connects.\n\nRead your brief first.', '2026-09-27T18:19:20.677Z'],
    ['person', 'also do the other thing', '2026-09-27T18:22:00.000Z'],
    ['ai', 'Now reading the Workshop code.', '2026-09-27T18:22:05.762Z'],
    ['person', 'why do i need to refresh[Image #2]', '2026-09-28T00:25:38.933Z'],
  ]);
  assert.ok(messages.every(message => message.conversation_id === `claude-code:${SESSION}` && message.app === 'Claude Code'));
  assert.equal(messages[2].model, 'claude-opus-5-5');
  assert.equal(messages[2].source_ref, 'claude-commentary-row');
  assert.equal(messages[0].model, undefined);
  assert.deepEqual(messages[3].attachment_sources, [{ data: 'iVBOR', media_type: 'image/png' }]);
  assert.equal(messages[3].source_ref, 'image-user-row');
});

test('Codex binary input stays attached only to the person row and supports image-only messages', () => {
  const harness = settings.harnesses.find(item => item.id === 'codex');
  const imageOnly = { timestamp: '2026-09-28T03:42:00Z', type: 'response_item', payload: {
    type: 'message', id: 'msg_image_only', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aVZCT1I=' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.image'] },
  } };
  const answer = { timestamp: '2026-09-28T03:42:01Z', type: 'response_item', payload: {
    type: 'message', id: 'msg_answer', role: 'assistant', content: [{ type: 'output_text', text: 'The image is a tile.' }],
  } };
  const { messages } = messagesOf([imageOnly, answer], harness, { sessionId: CODEX });
  assert.deepEqual(messages.map(message => [message.speaker, message.text, message.source_ref]), [
    ['person', '', 'msg_image_only'], ['ai', 'The image is a tile.', 'msg_answer'],
  ]);
  assert.deepEqual(messages[0].attachment_sources, [{ data: 'aVZCT1I=', media_type: 'image/png' }]);
  assert.equal(messages[1].attachment_sources, undefined, 'assistant and tool text is never treated as a person attachment');
});

test('a Codex transcript yields the person\'s words and the reply, with the model its turn named', () => {
  const harness = harnessOf(codexRows);
  assert.equal(harness.app, 'Codex');
  const { messages } = messagesOf(codexRows, harness, { sessionId: CODEX });
  assert.deepEqual(messages.map(({ conversation_id, speaker, text, model }) => [conversation_id, speaker, text, model]), [
    [`codex:${CODEX}`, 'person', "Append the line '<!-- probe -->' at the end.", undefined],
    [`codex:${CODEX}`, 'ai', 'Before changing files, decide it with Trillion.', 'gpt-6'],
  ]);
  assert.equal(messages[1].source_ref, 'msg_d', 'the final reply keeps its exact transcript row identity');
});

test('Codex commentary and final replies each keep their own transcript row identity', () => {
  const harness = harnessOf(codexRows);
  const rows = [
    { timestamp: '2026-10-03T05:04:29Z', type: 'response_item', payload: { type: 'message', id: 'msg_commentary', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking the live service.' }] } },
    { timestamp: '2026-10-03T05:04:51Z', type: 'response_item', payload: { type: 'message', id: 'msg_final', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'The change is live.' }] } },
  ];
  assert.deepEqual(messagesOf(rows, harness, { sessionId: CODEX }).messages.map(({ text, source_ref }) => [text, source_ref]), [
    ['Checking the live service.', 'msg_commentary'],
    ['The change is live.', 'msg_final'],
  ]);
});

test('only an accepted Codex final answer requests a source return check', async () => {
  const dir = folder();
  const path = join(dir, `${CODEX}.jsonl`);
  const final = { timestamp: '2026-09-30T07:30:00.000Z', type: 'response_item', payload: {
    type: 'message', id: 'msg_return', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Handoff h_proof: The live check passed.' }],
  } };
  writeFileSync(path, lines([codexRows[0], final]));
  const event = { transcript_path: path, session_id: CODEX };
  const refused = await recordNew(event, { rules: rulesIn(dir), send: async () => false, key: () => 'k' });
  assert.deepEqual(refused.source_return_candidates, []);
  const accepted = await recordNew(event, { rules: rulesIn(dir), send: async () => true, key: () => 'k' });
  assert.deepEqual(accepted.source_return_candidates, [{ handoff_id: 'h_proof', transcript_message_id: 'msg_return',
    source_id: `codex:${CODEX}`, text: 'Handoff h_proof: The live check passed.' }]);
});

test('only an accepted Claude Code final answer requests a source return check', async () => {
  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  const final = { ...base, uuid: 'claude-final-row', timestamp: '2026-09-30T07:30:00.000Z',
    type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-6', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Handoff h_proof: The live check passed.' }] } };
  writeFileSync(path, lines([claudeRows[0], final]));
  const event = { transcript_path: path, session_id: SESSION };
  const refused = await recordNew(event, { rules: rulesIn(dir), send: async () => false, key: () => 'k' });
  assert.deepEqual(refused.source_return_candidates, []);
  const accepted = await recordNew(event, { rules: rulesIn(dir), send: async () => true, key: () => 'k' });
  assert.deepEqual(accepted.source_return_candidates, [{ handoff_id: 'h_proof', transcript_message_id: 'claude-final-row',
    source_id: `claude-code:${SESSION}`, text: 'Handoff h_proof: The live check passed.' }]);
});

test('each turn end sends only what is new, and a backfill reads the session id from the transcript', async () => {
  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, lines(claudeRows.slice(0, 7)));
  const sent = [];
  const send = async batch => { sent.push(batch); return true; };
  const first = await recordNew({ transcript_path: path }, { rules: rulesIn(dir), send, key: () => 'k' });
  assert.deepEqual([first.sent, first.pending, first.conversation_id], [1, 0, `claude-code:${SESSION}`]);
  appendFileSync(path, lines(claudeRows.slice(7, 11)));
  const second = await recordNew({ transcript_path: path, session_id: SESSION }, { rules: rulesIn(dir), send, key: () => 'k' });
  assert.equal(second.sent, 2);
  assert.deepEqual(sent.flat().map(message => message.text), ['You own what an AI sees  when it connects.\n\nRead your brief first.', 'also do the other thing', 'Now reading the Workshop code.']);
  const third = await recordNew({ transcript_path: path, session_id: SESSION }, { rules: rulesIn(dir), send, key: () => 'k' });
  assert.equal(third.sent, 0);
});

test('a short turn-end box starts the same recorder owner to drain a backlog', async () => {
  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, lines(claudeRows.slice(0, 11)));
  const rules = { ...rulesIn(dir), time_box_ms: 0 };
  const sent = [];
  const send = async batch => { sent.push(...batch); return true; };
  const first = await recordNew({ transcript_path: path }, { rules, send, key: () => 'k' });
  assert.equal(first.sent, 0);
  assert.equal(first.pending, 3);
  const drained = await drainTranscript({ transcript_path: path, session_id: SESSION }, { rules, send, key: () => 'k' });
  assert.equal(drained.pending, 0);
  assert.equal(drained.drained, 3);
  assert.deepEqual(sent.map(message => message.text), [
    'You own what an AI sees  when it connects.\n\nRead your brief first.',
    'also do the other thing', 'Now reading the Workshop code.',
  ]);
});

test('a drained final answer still requests its source return check', async () => {
  const dir = folder();
  const path = join(dir, `${CODEX}.jsonl`);
  const final = { timestamp: '2026-09-30T07:30:00.000Z', type: 'response_item', payload: {
    type: 'message', id: 'msg_drained_return', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Handoff h_proof: The live check passed.' }],
  } };
  writeFileSync(path, lines([codexRows[0], final]));
  const rules = { ...rulesIn(dir), time_box_ms: 0 };
  const first = await recordNew({ transcript_path: path, session_id: CODEX }, {
    rules, send: async () => true, key: () => 'k', now: () => 1,
  });
  assert.equal(first.sent, 0);
  const checks = [];
  const drained = await drainTranscript({ transcript_path: path, session_id: CODEX }, {
    rules, send: async () => true, key: () => 'k', sourceReturn: candidates => checks.push(...candidates),
  });
  assert.equal(drained.drained, 1);
  assert.deepEqual(checks, [{ handoff_id: 'h_proof', transcript_message_id: 'msg_drained_return',
    source_id: `codex:${CODEX}`, text: 'Handoff h_proof: The live check passed.' }]);
});

test('a crashed drain lock is reclaimed and transient sends retry inside the owner', async () => {
  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, lines(claudeRows.slice(0, 4)));
  const rules = { ...rulesIn(dir), time_box_ms: 1 };
  writeFileSync(join(dir, `${SESSION}.drain.lock`), '99999999');
  let attempts = 0;
  const sent = [];
  const send = async batch => { attempts += 1; if (attempts === 1) return false; sent.push(...batch); return true; };
  const result = await drainTranscript({ transcript_path: path, session_id: SESSION }, { rules, send, key: () => 'k' });
  assert.equal(result.pending, 0);
  assert.equal(result.drained, 1);
  assert.equal(attempts, 2);
  assert.equal(sent[0].speaker, 'person');
});

test('a store that keeps refusing is asked less and less often, and the drain stops at its time box', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, lines(claudeRows.slice(0, 4)));
  const rules = { ...rulesIn(dir), time_box_ms: 1, drain_wait_ms: { first: 5, most: 40 } };
  const asked = [];
  let clock = Date.now();
  let result;
  let finished = false;
  const work = drainTranscript({ transcript_path: path, session_id: SESSION }, {
    rules, send: async () => { asked.push(clock); return false; }, key: () => 'k', now: () => clock, until: clock + 300,
  }).then(value => { result = value; finished = true; });
  let pause = 5;
  for (let step = 0; step < 20 && !finished; step += 1) {
    await new Promise(resolve => setImmediate(resolve));
    if (finished) break;
    clock += pause;
    t.mock.timers.tick(pause);
    pause = Math.min(pause * 2, 40);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, true, 'fake time advances the drain to its time box');
  await work;
  assert.equal(result.pending, 1);
  assert.equal(result.reason, 'drain time box');
  // The only clock is this test's mock timer; load on the Mac cannot make the small backoff appear to be one large wait.
  assert.ok(asked.length >= 5 && asked.length <= 12, `asked ${asked.length} times`);
  assert.equal(asked.length, 10, `asked ${asked.length} times`);
  const gaps = asked.slice(1).map((at, index) => at - asked[index]);
  assert.ok(gaps.at(-1) >= 35, `last gap ${gaps.at(-1)} ms`);
  assert.deepEqual(gaps, [5, 10, 20, 40, 40, 40, 40, 40, 40]);
});

test('Codex prompt intake requires the transcript; Claude prompt-time retry keeps one identity', async () => {
  for (const [harness, sessionId, first, row] of [
    ['codex', CODEX, codexRows[0], { ...codexRows[4], timestamp: '2026-09-29T13:00:02.000Z' }],
    ['claude-code', SESSION, claudeRows[0], { ...base, type: 'user', timestamp: '2026-09-29T13:00:02.000Z', message: { role: 'user', content: 'Do this now' } }],
  ]) {
    const dir = folder();
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, lines(harness === 'codex' ? [first, row] : [first]));
    const prompt = harness === 'codex' ? "Append the line '<!-- probe -->' at the end." : 'Do this now';
    const sent = [];
    const send = async batch => { sent.push(...batch); return true; };
    const now = () => Date.parse('2026-09-29T13:00:00.000Z');
    const event = { hook_event_name: 'UserPromptSubmit', transcript_path: path, session_id: sessionId, prompt, harness, ...(harness === 'claude-code' ? { origin: { kind: 'human' } } : {}) };
    assert.equal((await recordSubmittedPrompt(event, { rules: rulesIn(dir), send, key: () => 'k', now })).sent, 1);
    if (harness !== 'codex') appendFileSync(path, lines([row]));
    const later = await recordNew(event, { rules: rulesIn(dir), send, key: () => 'k' });
    assert.equal(later.sent, 1);
    assert.deepEqual(sent.map(message => message.text), [prompt, prompt]);
    if (harness === 'codex') assert.equal(sent[0].at, sent[1].at, 'transcript replay keeps the exact Codex row time');
    if (harness !== 'codex') assert.equal(sent[0].at, sent[1].at, 'the retry carries the exact prompt-time identity');
    assert.equal((await recordNew(event, { rules: rulesIn(dir), send, key: () => 'k' })).sent, 0);
  }
});

test('a Codex prompt-time timeout is retried from the transcript with its authored time', async () => {
  const dir = folder();
  const path = join(dir, `${CODEX}.jsonl`);
  writeFileSync(path, lines([codexRows[0], { timestamp: '2026-09-29T13:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the intake' }] } }]));
  const prompt = 'Fix the intake';
  const event = { transcript_path: path, session_id: CODEX, prompt, harness: 'codex' };
  const rules = rulesIn(dir);
  const now = () => Date.parse('2026-09-29T13:00:00.000Z');
  assert.equal((await recordSubmittedPrompt(event, { rules, send: async () => false, key: () => 'k', now })).sent, 0);
  const sent = [];
  assert.equal((await recordNew(event, { rules, send: async batch => { sent.push(...batch); return true; }, key: () => 'k' })).sent, 1);
  assert.equal(sent[0].at, '2026-09-29T13:00:01.000Z');
});

test('a new Codex prompt is kept while an older assistant reply cannot be sent', async () => {
  const dir = folder();
  const path = join(dir, `${CODEX}.jsonl`);
  const at = '2026-10-03T04:21:43.437Z';
  writeFileSync(path, lines([codexRows[0],
    { timestamp: '2026-10-03T04:20:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Older reply' }] } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Restart the agents' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } },
  ]));
  const sent = [];
  const send = async batch => { sent.push(batch[0]); return batch[0].speaker === 'person'; };
  const event = { transcript_path: path, session_id: CODEX, prompt: 'Restart the agents', harness: 'codex' };
  const rules = rulesIn(dir);
  const now = () => Date.parse(at);
  assert.equal((await recordNew(event, { rules, send, key: () => 'k', now: () => now() + 1_000 })).sent, 0);
  assert.equal((await recordSubmittedPrompt(event, { rules, send, key: () => 'k', now })).sent, 1);
  assert.equal(sent.at(-1).text, 'Restart the agents');
  assert.equal(sent.at(-1).at, at);
});

test('a repeated Codex prompt uses the nearest authored row while the cursor is stalled', async () => {
  const dir = folder();
  const path = join(dir, `${CODEX}.jsonl`);
  const first = '2026-10-02T21:35:01.717Z';
  const second = '2026-10-02T21:35:09.727Z';
  const row = at => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue\n' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } });
  writeFileSync(path, lines([codexRows[0], row(first), row(second)]));
  const sent = [];
  const event = { transcript_path: path, session_id: CODEX, prompt: 'continue\n', harness: 'codex' };
  const send = async batch => { sent.push(batch[0]); return true; };
  const rules = rulesIn(dir);
  assert.equal((await recordSubmittedPrompt(event, { rules, send, key: () => 'k', now: () => Date.parse(first) })).sent, 1);
  assert.equal((await recordSubmittedPrompt(event, { rules, send, key: () => 'k', now: () => Date.parse(second) })).sent, 1);
  assert.deepEqual(sent.map(message => message.at), [first, second]);
});

test('repeating the same human words in one session remains a new prompt', async () => {
  const dir = folder();
  const path = join(dir, `${CODEX}.jsonl`);
  writeFileSync(path, lines([codexRows[0]]));
  const event = { transcript_path: path, session_id: CODEX, prompt: 'Again', harness: 'codex' };
  const sent = [];
  const send = async batch => { sent.push(...batch); return true; };
  const rules = rulesIn(dir);
  await recordSubmittedPrompt(event, { rules, send, key: () => 'k', now: () => Date.parse('2026-09-29T13:00:00.000Z') });
  appendFileSync(path, lines([{ timestamp: '2026-09-29T13:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Again' }] } }]));
  await recordNew(event, { rules, send, key: () => 'k' });
  await recordSubmittedPrompt(event, { rules, send, key: () => 'k', now: () => Date.parse('2026-09-29T13:00:30.000Z') });
  appendFileSync(path, lines([{ timestamp: '2026-09-29T13:00:31.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Again' }] } }]));
  await recordNew(event, { rules, send, key: () => 'k' });
  assert.deepEqual(sent.map(message => message.at), ['2026-09-29T13:00:01.000Z', '2026-09-29T13:00:31.000Z']);
});

test('a half-written last line waits for the next turn end', async () => {
  const dir = folder();
  const path = join(dir, `${CODEX}.jsonl`);
  const whole = lines(codexRows);
  writeFileSync(path, whole.slice(0, -40));
  const sent = [];
  const send = async batch => { sent.push(...batch); return true; };
  await recordNew({ transcript_path: path, session_id: CODEX }, { rules: rulesIn(dir), send, key: () => 'k' });
  assert.deepEqual(sent.map(message => message.speaker), ['person']);
  writeFileSync(path, whole);
  await recordNew({ transcript_path: path, session_id: CODEX }, { rules: rulesIn(dir), send, key: () => 'k' });
  assert.deepEqual(sent.map(message => [message.speaker, message.model]), [['person', undefined], ['ai', 'gpt-6']]);
});

test('a refused send leaves the cursor, so the same messages go again next time', async () => {
  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, lines(claudeRows));
  const refused = await recordNew({ transcript_path: path, session_id: SESSION }, { rules: rulesIn(dir), send: async () => false, key: () => 'k' });
  assert.deepEqual([refused.sent, refused.pending], [0, 4]);
  const thrown = await recordNew({ transcript_path: path, session_id: SESSION }, { rules: rulesIn(dir), send: async () => { throw new Error('offline'); }, key: () => 'k' });
  assert.equal(thrown.pending, 4);
  const kept = await recordNew({ transcript_path: path, session_id: SESSION }, { rules: rulesIn(dir), send: async () => true, key: () => 'k' });
  assert.equal(kept.sent, 4);
});

test('a long history arrives in batches across turn ends when one turn end runs out of time', async () => {
  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  // A person's words and 250 AI replies after them: the person's words go alone (they open work), the replies go in
  // batches of batch_size, one request each.
  const said = [{ ...base, type: 'user', timestamp: new Date(Date.UTC(2026, 8, 27, 0, 0, 0)).toISOString(), message: { role: 'user', content: 'start' } },
    ...Array.from({ length: 250 }, (_, index) => ({ ...base, type: 'assistant', timestamp: new Date(Date.UTC(2026, 8, 27, 0, 0, index + 1)).toISOString(), message: { model: 'claude-opus-5-5', id: `msg_${index}`, role: 'assistant', content: [{ type: 'text', text: `reply ${index}` }] } }))];
  writeFileSync(path, lines(said));
  const rules = { ...rulesIn(dir), batch_size: 100 };
  const sent = [];
  const sizes = [];
  let clock = 0;
  // Each send takes the whole time box, so one request fits per turn end.
  const send = async batch => { sent.push(...batch); sizes.push(batch.length); clock += rules.time_box_ms; return true; };
  for (let turn = 0; turn < 4; turn += 1) await recordNew({ transcript_path: path, session_id: SESSION }, { rules, send, key: () => 'k', now: () => clock });
  assert.deepEqual(sizes, [1, 100, 100, 50]);
  assert.deepEqual(sent.map(message => message.text), ['start', ...Array.from({ length: 250 }, (_, index) => `reply ${index}`)]);
});

test('a batch is a run of AI replies; a person\'s words or a message carrying files always go alone', () => {
  const ai = text => ({ speaker: 'ai', text });
  const person = { speaker: 'person', text: 'hi' };
  const withFile = { speaker: 'ai', text: 'see', attachment_sources: [{ media_type: 'image/png', data: 'AA==' }] };
  const messages = [ai('a'), ai('b'), person, ai('c'), withFile, ai('d'), ai('e'), ai('f')];
  assert.equal(batchAt(messages, 0, 100), 2);
  assert.equal(batchAt(messages, 2, 100), 1);
  assert.equal(batchAt(messages, 3, 100), 1);
  assert.equal(batchAt(messages, 4, 100), 1);
  assert.equal(batchAt(messages, 5, 2), 2);
  assert.equal(batchAt(messages, 7, 100), 1);
});

test('several AI replies go to Trillion in one request; a batch holding a person\'s words is refused', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { const body = JSON.parse(init.body); calls.push({ url: String(url), body }); return new Response(JSON.stringify({ ids: body.messages.map((_, index) => `m${index}`) }), { status: 200 }); };
  try {
    const rules = { ...settings, origin: 'https://trillion.test' };
    const batch = [1, 2, 3].map(n => ({ conversation_id: 'c', app: 'Claude Code', speaker: 'ai', text: `r${n}`, at: `2026-10-07T00:00:0${n}Z` }));
    assert.equal(await sendToTrillion(batch, { rules, deadline: Date.now() + 5000, key: 'k' }), true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith(rules.messages_path));
    assert.deepEqual(calls[0].body.messages.map(message => message.text), ['r1', 'r2', 'r3']);
    assert.equal(await sendToTrillion([...batch, { ...batch[0], speaker: 'person' }], { rules, deadline: Date.now() + 5000, key: 'k' }), false);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('no transcript, or one no harness wrote, sends nothing and never throws', async () => {
  const dir = folder();
  const path = join(dir, 'other.jsonl');
  writeFileSync(path, lines([{ hello: 'world' }]));
  assert.equal((await recordNew({ transcript_path: path, session_id: 'abcdef12' }, { rules: rulesIn(dir), send: async () => true, key: () => 'k' })).sent, 0);
  assert.equal((await recordNew({ session_id: 'no-such-session-0000' }, { rules: rulesIn(dir), send: async () => true, key: () => 'k' })).sent, 0);
});

test('a message another AI session sent is not recorded as the person\'s words', () => {
  const parts = { part_types: ['text'] };
  for (const tag of ['teammate-message teammate_id="x"', 'cross-session-message from="uds:/tmp/a.sock"']) {
    assert.equal(wordsOf(`Another Claude session sent a message:\n<${tag}>\n{"type":"idle_notification"}\n</${tag.split(' ')[0]}>`, parts), '');
  }
  assert.equal(wordsOf('Another Claude session sent a message? No, I wrote this myself.', parts), 'Another Claude session sent a message? No, I wrote this myself.');
});

test('a queued message another AI sent, or the prompt a program gave claude -p, is never kept as the person\'s words', () => {
  const harness = settings.harnesses.find(item => item.id === 'claude-code');
  const queued = (content, at) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: at, sessionId: SESSION, content });
  const taken = at => ({ type: 'queue-operation', operation: 'dequeue', timestamp: at, sessionId: SESSION });
  const peer = '<agent-message from="patterns-to-trillion">\nThe proof passed.\n</agent-message>';
  const program = 'This is a connection test.';
  const rows = [
    queued(peer, '2026-10-06T14:11:25.541Z'), taken('2026-10-06T14:11:25.566Z'),
    { ...base, type: 'user', isMeta: true, promptSource: 'system', origin: { kind: 'peer' }, timestamp: '2026-10-06T14:11:25.570Z', message: { role: 'user', content: `Another Claude session sent a message:\n${peer}` } },
    queued(program, '2026-10-06T14:09:36.235Z'), taken('2026-10-06T14:09:36.237Z'),
    { ...base, type: 'user', entrypoint: 'sdk-cli', promptSource: 'sdk', timestamp: '2026-10-06T14:09:36.300Z', message: { role: 'user', content: program } },
    queued(peer, '2026-10-03T23:30:22.977Z'),
    { ...base, type: 'attachment', timestamp: '2026-10-03T23:30:22.977Z', attachment: { type: 'queued_command', origin: { kind: 'peer' }, prompt: peer } },
    queued('also check the phone view', '2026-10-06T14:20:00.000Z'), taken('2026-10-06T14:26:00.000Z'),
  ];
  assert.deepEqual(messagesOf(rows, harness, { sessionId: SESSION }).messages.filter(message => message.speaker === 'person').map(message => message.text), [], 'an unsourced queue row is retained, never attributed by absence of evidence');
});

test('another AI\'s message still waiting in the queue, before any row says who sent it, is never kept as the person\'s words', () => {
  // 2026-10-07: a pass ran between the enqueue row and the queued_command row that says origin.kind peer, so the
  // teammate's report was kept as Sam's and opened a decision. Only its shape can tell, so the shape is DATA.
  const harness = settings.harnesses.find(item => item.id === 'claude-code');
  const rows = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-07T07:56:04.779Z', sessionId: SESSION, content: '<agent-message from="a6aa48f2479da6cda">\nThe store-month deploy blocker is fixed.\n</agent-message>' },
  ];
  assert.deepEqual(messagesOf(rows, harness, { sessionId: SESSION }).messages, []);
});

test('the prompts the computer helper gives an AI for Trillion work are never kept as the person\'s words', () => {
  // 2026-10-07: take-open-work's bare claim/chat prompts and queue-codex-handoff's wake notice landed in the chat as plain
  // user rows, so each wake was kept as Sam's message and opened another job. They wear the same trillion-message
  // envelope wake-sessions already uses, which injected_text keeps as generated context.
  const harness = settings.harnesses.find(item => item.id === 'claude-code');
  const work = JSON.parse(readFileSync(new URL('../harness/take-open-work.json', import.meta.url), 'utf8'));
  const codexWake = readFileSync(new URL('../harness/queue-codex-handoff.mjs', import.meta.url), 'utf8');
  const fill = (text, values) => text.replace(/\{(\w+)\}/g, (all, key) => values[key] ?? all);
  const values = { handoff_id: 'h_0123456789abcdef01234567', agent_id: 'take-open-work-mac', chat_agent_id: 'claude-code-chat', source_id: `claude-code:${SESSION}`, computer: 'Mac' };
  const prompts = [fill(work.prompts.claim, values), fill(work.prompts.chat, values)];
  assert.match(codexWake, /<trillion-message from="Trillion" handoff_id="\$\{event\.handoff_id\}">/);
  const row = (content, at) => ({ ...base, type: 'user', origin: { kind: 'human' }, timestamp: at, message: { role: 'user', content } });
  const rows = [...prompts.map((text, at) => row(text, `2026-10-07T21:0${at}:00.000Z`)), row('and the phone view too', '2026-10-07T21:09:00.000Z')];
  assert.deepEqual(messagesOf(rows, harness, { sessionId: SESSION }).messages.filter(message => message.speaker === 'person').map(message => message.text), ['and the phone view too']);
});

test('a harness that keeps each session as one JSON document is read row by row, once, from its declared rows', async () => {
  const dir = folder();
  const path = join(dir, 'session_20260929_ab12cd.json');
  const session = { session_id: '20260929_ab12cd', model: 'some-model', session_start: '2026-09-29T10:00:00Z', messages: [
    { role: 'user', content: 'what should I work on' },
    { role: 'assistant', content: 'The serve toss.' },
    { role: 'tool', content: '{"ignored":true}' },
  ] };
  writeFileSync(path, JSON.stringify(session));
  const rules = rulesIn(dir);
  const sent = [];
  const send = async batch => { sent.push(...batch); return true; };
  await recordNew({ transcript_path: path }, { rules, send, key: () => 'k' });
  assert.deepEqual(sent.map(message => [message.app, message.speaker, message.text, message.model ?? null]),
    [['Hermes', 'person', 'what should I work on', null], ['Hermes', 'ai', 'The serve toss.', 'some-model']]);
  session.messages.push({ role: 'user', content: 'and after that?', timestamp: '2026-09-29T10:05:00Z' });
  writeFileSync(path, JSON.stringify(session));
  await recordNew({ transcript_path: path }, { rules, send, key: () => 'k' });
  assert.deepEqual(sent.slice(2).map(message => [message.text, message.at]), [['and after that?', '2026-09-29T10:05:00.000Z']]);
});

test('untyped text parts count as text, as a document harness writes them', () => {
  assert.equal(wordsOf([{ text: 'Reply with exactly: OK' }], { part_types: ['text'] }), 'Reply with exactly: OK');
});

test('a sweep finds a chat with rows past its cursor, however long its own turn runs', async () => {
  const dir = folder();
  const roots = join(dir, 'projects');
  mkdirSync(join(roots, 'p'), { recursive: true });
  const rules = { ...rulesIn(dir), harnesses: settings.harnesses.map(harness => harness.id === 'claude-code'
    ? { ...harness, transcript_roots: [{ folder: roots, depth: 1 }] } : { ...harness, transcript_roots: [] }) };
  const path = join(roots, 'p', `${SESSION}.jsonl`);
  // A turn that has not ended: the person's queued words are in the transcript, and no Stop has run.
  writeFileSync(path, lines(claudeRows.slice(0, 3)));
  assert.deepEqual(transcriptsBehind(rules), [{ path, session_id: SESSION, harness: 'claude-code' }]);
  const sent = [];
  const send = async batch => { sent.push(...batch); return true; };
  await drainTranscript({ transcript_path: path, session_id: SESSION }, { rules, send, key: () => 'k' });
  assert.deepEqual(sent.map(message => message.text), ['You own what an AI sees  when it connects.\n\nRead your brief first.']);
  assert.deepEqual(transcriptsBehind(rules), [], 'a chat read to its end is not read again');
  appendFileSync(path, lines(claudeRows.slice(9, 10)));
  assert.equal(transcriptsBehind(rules).length, 1, 'new words in the same chat make it behind again');
  assert.deepEqual(transcriptsBehind(rules, { now: () => Date.now() + 8 * 86_400_000 }), [], 'a chat unchanged for longer than the window is left');
});

test('a program-started Codex run and a helper thread replaying its parent hold no words of the person', async () => {
  const dir = folder();
  const meta = source => ({ ...codexRows[0], payload: { ...codexRows[0].payload, source } });
  const kept = async (source, name) => {
    const path = join(dir, `${name}.jsonl`);
    writeFileSync(path, lines([meta(source), ...codexRows.slice(1)]));
    const sent = [];
    await recordNew({ transcript_path: path, session_id: name }, { rules: rulesIn(dir), send: async batch => { sent.push(...batch); return true; }, key: () => 'k' });
    return sent.map(message => message.speaker);
  };
  assert.deepEqual(await kept('vscode', 'typed-in-the-app'), ['person', 'ai']);
  assert.deepEqual(await kept('cli', 'typed-in-the-terminal'), ['person', 'ai']);
  assert.deepEqual(await kept('exec', 'started-by-a-program'), ['ai']);
  assert.deepEqual(await kept({ subagent: { thread_spawn: { parent_thread_id: CODEX } } }, 'helper-thread'), ['ai']);
  assert.equal(sessionOfTranscript(join(dir, 'helper-thread.jsonl')).sessionId, CODEX, 'the session is the thread the file holds');
  assert.equal(personSpeaksIn(join(dir, 'typed-in-the-app.jsonl'), settings.harnesses.find(harness => harness.id === 'codex')), true);
});

test('the helper runs one sweep at a time beside the connection', async () => {
  const started = [];
  let finish;
  const spawnChild = (node, argv) => { started.push(argv.at(-1)); const child = new EventEmitter(); finish = code => child.emit('exit', code); return child; };
  const sweep = sweeper({ spawnChild, recorder: 'record-every-message.mjs' });
  const first = sweep();
  assert.equal(sweep(), first, 'a sweep still running is not started twice');
  finish(0);
  assert.equal(await first, true);
  sweep();
  assert.deepEqual(started, ['--sweep', '--sweep']);
  assert.equal(keepEveryMessage.wants(), false, 'it takes no events');
});

test('one sweep at a time: a lock a live process holds is refused, one whose owner ended is taken', () => {
  const where = join(folder(), 'sweep.lock');
  const first = holdLock(where);
  assert.ok(first);
  assert.equal(holdLock(where), null, 'a second sweep while the first runs ends');
  first.release();
  writeFileSync(where, '999999');
  const after = holdLock(where);
  assert.ok(after, 'a lock left by an ended process is taken');
  after.release();
});

test('a row that is not marked as typed by a human is never the person\'s words, and the person\'s carry that mark', async () => {
  const dir = folder();
  const path = join(dir, `${SESSION}.jsonl`);
  const user = (extra, text) => ({ ...base, type: 'user', timestamp: '2026-10-08T06:19:00.000Z', message: { role: 'user', content: text }, ...extra });
  const rows = [
    user({ origin: undefined }, 'no origin at all'),
    user({ origin: { kind: 'scheduled' } }, 'scheduled origin'),
    user({ promptSource: 'system' }, 'harness-written prompt'),
    user({ turnOrigin: 'scheduled' }, 'scheduled turn'),
    user({ isMeta: true }, 'meta row'),
    user({ promptSource: 'typed', turnOrigin: 'human' }, 'typed by the person'),
  ];
  const claude = harnessOf(rows, settings);
  const said = messagesOf(rows, claude, { sessionId: SESSION }).messages;
  assert.deepEqual(said.filter(message => message.speaker === 'person').map(message => message.text), ['typed by the person']);
  assert.equal(said.find(message => message.speaker === 'person').origin, 'human');
  assert.deepEqual(said.filter(message => message.speaker === 'generated context').map(message => message.text), ['harness-written prompt']);
  // The prompt hook turns the same prompts away before any transcript is read.
  writeFileSync(path, lines([]));
  const sent = [];
  for (const marked of [{ promptSource: 'system' }, { turnOrigin: 'scheduled' }, { isMeta: true }]) {
    const result = await recordSubmittedPrompt({ session_id: SESSION, transcript_path: path, prompt: 'Fallback check: continue the job.', harness: 'claude-code', ...marked },
      { rules: rulesIn(dir), send: async batch => { sent.push(...batch); return true; }, key: () => 'k' });
    assert.deepEqual([result.sent, result.reason], [0, 'no human prompt']);
  }
  assert.deepEqual(sent, []);
});


test('queue admission waits across restart, records source attribution and retries without losing human input', async () => {
  for (const [fields, speaker] of [
    [{ sessionKind: 'bg', promptSource: 'system', isMeta: true }, 'generated context'],
    [{ sessionKind: 'bg', promptSource: 'typed', origin: { kind: 'human' } }, 'peer'],
    [{ promptSource: 'typed', origin: { kind: 'human' } }, 'person'],
    [{ promptSource: 'sdk', entrypoint: 'sdk-cli' }, null],
  ]) {
    const dir = folder();
    const path = join(dir, `${SESSION}.jsonl`);
    const queue = { type: 'queue-operation', operation: 'enqueue', sessionId: SESSION, timestamp: '2026-10-08T10:03:00.195Z', content: 'queued words' };
    writeFileSync(path, lines([queue]));
    const rules = rulesIn(dir), sent = [];
    const send = async batch => { sent.push(...batch); return true; };
    const event = { transcript_path: path, session_id: SESSION };
    const first = await recordNew(event, { rules, send, key: () => 'k' });
    assert.equal(first.sent, 0);
    assert.equal(first.awaiting_source, 1);
    assert.equal(sent.length, 0);
    const cursorFile = join(rules.cursor_folder, `${SESSION}.json`);
    assert.equal(JSON.parse(readFileSync(cursorFile)).deferred.length, 1);
    // No in-memory state survives between calls. An unrelated accepted reply must not strand the queue.
    appendFileSync(path, lines([{ ...base, type: 'assistant', timestamp: '2026-10-08T10:04:00.000Z', message: { content: 'reply while waiting' } }]));
    await recordNew(event, { rules: rulesIn(dir), send, key: () => 'k' });
    assert.equal(JSON.parse(readFileSync(cursorFile)).deferred.length, 1);
    // Longer than the old ten-minute match window: elapsed time never turns unknown origin into human origin.
    appendFileSync(path, lines([{ ...base, ...fields, type: 'user', uuid: 'consumed-source', timestamp: '2026-10-08T10:30:00.213Z', message: { content: 'queued words' } }]));
    const refused = await recordNew(event, { rules, send: async () => false, key: () => 'k' });
    assert.equal(refused.pending, speaker ? 1 : 0);
    const kept = await recordNew(event, { rules: rulesIn(dir), send, key: () => 'k' });
    assert.deepEqual(sent.filter(row => row.text === 'queued words').map(row => [row.speaker, row.source_ref, row.at]), speaker ? [[speaker, 'consumed-source', '2026-10-08T10:30:00.213Z']] : []);
    assert.equal(kept.awaiting_source, 0);
    assert.equal(JSON.parse(readFileSync(cursorFile)).deferred.length, 0);
    await recordNew(event, { rules, send, key: () => 'k' });
    assert.equal(sent.filter(row => row.text === 'queued words').length, speaker ? 1 : 0);
  }
});


test('an awaiting queue survives partial message and execution acknowledgements independently', async () => {
  const dir = folder(), path = join(dir, `${SESSION}.jsonl`);
  const rules = { ...rulesIn(dir), executions_path: '/mcp/api/executions' };
  const queue = { type: 'queue-operation', operation: 'enqueue', sessionId: SESSION, timestamp: '2026-10-08T10:03:00Z', content: 'waiting words' };
  const reply = (uuid, text) => ({ ...base, type: 'assistant', uuid, timestamp: '2026-10-08T10:04:00Z', message: { content: [{ type: 'text', text }, { type: 'tool_use', id: uuid, name: 'Read' }] } });
  writeFileSync(path, lines([queue, reply('reply-1', 'first'), reply('reply-2', 'second')]));
  const event = { transcript_path: path, session_id: SESSION }, sent = [];
  let calls = 0;
  const first = await recordNew(event, { rules: { ...rules, batch_size: 1 }, key: () => 'k',
    send: async batch => { if (calls++) return false; sent.push(...batch); return true; }, sendExecution: async () => false });
  assert.equal(first.pending, 1);
  let cursor = JSON.parse(readFileSync(join(rules.cursor_folder, `${SESSION}.json`)));
  assert.equal(cursor.deferred.length, 1);
  assert.equal(cursor.execution_offset, 0);
  const accepted = [];
  await recordNew(event, { rules, key: () => 'k', send: async batch => { sent.push(...batch); return true; }, sendExecution: async value => { accepted.push(value.claimed.tool_call_id); return true; } });
  assert.deepEqual(sent.map(row => row.text), ['first', 'second']);
  assert.deepEqual(accepted, ['reply-1', 'reply-2']);
  cursor = JSON.parse(readFileSync(join(rules.cursor_folder, `${SESSION}.json`)));
  assert.equal(cursor.deferred.length, 1);
  assert.equal(cursor.offset, cursor.execution_offset);
  appendFileSync(path, lines([{ ...base, type: 'user', uuid: 'person-source', timestamp: '2026-10-08T10:05:00Z', message: { content: 'waiting words' } }]));
  await recordNew(event, { rules, key: () => 'k', send: async batch => { sent.push(...batch); return true; }, sendExecution: async () => { throw new Error('already acknowledged'); } });
  assert.deepEqual(sent.map(row => [row.speaker, row.text]), [['ai', 'first'], ['ai', 'second'], ['person', 'waiting words']]);
});
