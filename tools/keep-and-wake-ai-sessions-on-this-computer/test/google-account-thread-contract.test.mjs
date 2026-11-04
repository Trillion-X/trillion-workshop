// The Gmail conversation tools are read from the Gmail descriptor, run as the connected account, and ask Gmail for exactly
// the thread endpoints: a headers-only read, and organise / trash / untrash of the whole conversation. Gmail's answers
// are the shape its thread resource has (an id and a list of messages with labels, preview and time).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordsList, rowsFromList } from '../parts/ai-tool-catalog/do-work/derive-tool-rows-from-sources.mjs';
import { buildInvocation, httpJson } from '../src/workshop.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const descriptors = read('../parts/service-connections/records.json').things;
const sources = read('../records/workshop-tool-records.json').records.map(row => row.payload)
  .filter(row => ['source:service-connection-descriptors', 'source:how-to-ask-something-else-to-do-things'].includes(row.id));
const derived = sources.map(source => rowsFromList(source, recordsList(source.list.records).filter(entry => /^(google-account)(-|$)/.test(entry.record_name))));
assert.deepEqual(derived.flatMap(result => result.refused), []);
const tool = id => derived.flatMap(result => result.rows).find(row => row.id === id);
const readThread = tool('tool:google-account-read_mail_thread');
const modifyThread = tool('tool:google-account-modify_mail_thread');
const trashThread = tool('tool:google-account-trash_mail_thread');
const restoreThread = tool('tool:google-account-restore_mail_thread');

async function run(descriptor, input, reply) {
  const invocation = await buildInvocation(descriptor.invoke, { input, request: true });
  const requests = [];
  const answer = await httpJson({ invocation, send: async request => { requests.push(request); return reply; } });
  return { answer, requests };
}

test('the conversation tools are Gmail use, on the connected account', () => {
  const service = descriptors.find(row => row.address === 'package::service-connections::published-record::google-account').payload;
  const gmailUse = service.capabilities.find(item => item.id === 'gmail.use');
  for (const descriptor of [readThread, modifyThread, trashThread, restoreThread]) {
    assert.ok(descriptor, 'the descriptor-derived Gmail tool is available');
    assert.ok(gmailUse.tool_ids.includes(descriptor.id));
    assert.equal(descriptor.invoke.connection_id, 'service_connection:google-account');
    assert.ok(descriptor.invoke.credential_injections.some(item => item.field_id === 'access_token'));
  }
  const scopes = id => gmailUse.required_scope_alternatives_by_tool[id].map(set => set[0].replace('https://www.googleapis.com/auth/', ''));
  assert.deepEqual(scopes(readThread.id), ['https://mail.google.com/', 'gmail.modify', 'gmail.readonly', 'gmail.metadata']);
  for (const descriptor of [modifyThread, trashThread, restoreThread]) assert.deepEqual(scopes(descriptor.id), ['https://mail.google.com/', 'gmail.modify']);
});

test('reading a conversation asks for its headers only, and the answer lists the messages', async () => {
  const thread = { id: 'thread-1', messages: [{ id: 'm1', threadId: 'thread-1', labelIds: ['INBOX'], snippet: 'Hi', internalDate: '1792300000000', payload: { headers: [{ name: 'From', value: 'a@b.com' }] } }] };
  const { answer, requests } = await run(readThread, { thread_id: 'thread-1' }, { status_code: 200, body: JSON.stringify(thread) });
  assert.equal(requests[0].method, 'GET');
  const url = new URL(requests[0].url);
  assert.equal(url.origin + url.pathname, 'https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1');
  assert.equal(url.searchParams.get('format'), 'metadata');
  assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID']);
  assert.deepEqual(answer.messages.map(message => message.id), ['m1']);
});

test('done, delete and restore act on the whole conversation', async () => {
  const done = await run(modifyThread, { thread_id: 'thread-1', remove_label_ids: ['INBOX'] }, { status_code: 200, body: JSON.stringify({ id: 'thread-1' }) });
  assert.equal(done.requests[0].method, 'POST');
  assert.equal(done.requests[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/modify');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(done.requests[0].body)), { removeLabelIds: ['INBOX'] });
  const trashed = await run(trashThread, { thread_id: 'thread-1' }, { status_code: 200, body: JSON.stringify({ id: 'thread-1' }) });
  assert.equal(trashed.requests[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/trash');
  const restored = await run(restoreThread, { thread_id: 'thread-1' }, { status_code: 200, body: JSON.stringify({ id: 'thread-1' }) });
  assert.equal(restored.requests[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/untrash');
  await assert.rejects(() => run(trashThread, { thread_id: 'thread-1' }, { status_code: 403, body: '{"error":"insufficient authentication scopes"}' }), /answered 403/i);
});
