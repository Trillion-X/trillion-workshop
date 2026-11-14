// The mail tools against stand-in providers: the same operation, the same input words and the same neutral rows from two
// different providers; the key placed only in the Authorization header of a request to the provider's own host; a
// provider's refusal and a missing operation said in words. The Gmail wire rules carried over from the earlier mail
// screen's tests (composing, plain text only, links, attachments, drafts that would lose content).
import test from 'node:test';
import assert from 'node:assert/strict';
import { perform, providerFor, Refused } from '../read-data/mail.mjs';
import { HEADER_FIELDS } from '../read-data/neutral.mjs';
import { draftNeedsOriginal, messageAttachments, messageLinks, plainTextBody, rawMessage, toNeutral } from '../read-data/adapters/gmail.mjs';

const b64 = text => Buffer.from(text).toString('base64url');
const hdr = (name, value) => ({ name, value });
const KEY = 'held-key-value';
const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });

/** A stand-in provider: answers each request by `rules` (first whose test matches), records what it was asked. */
function standIn(rules) {
  const asked = [];
  const send = async (url, init) => {
    asked.push({ method: init.method, url: String(url), headers: init.headers, body: init.body });
    const rule = rules.find(row => row.when(String(url), init));
    if (!rule) return reply(404, { error: 'no stand-in for ' + url });
    return typeof rule.then === 'function' ? rule.then(String(url), init) : rule.then.clone();
  };
  return { asked, io: { read: () => KEY, send } };
}
const at = (method, part) => (url, init) => init.method === method && url.includes(part);

const gmailMessage = {
  id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], snippet: 'Pay at once', internalDate: '1700000000000',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [hdr('From', 'Laura <laura@example.com>'), hdr('To', 'me@example.org'), hdr('Subject', 'Invoice'), hdr('Date', 'Tue, 14 Nov 2023 22:13:20 +0000'), hdr('Message-ID', '<m1@example.com>')],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Pay at https://pay.example.com/x?a=1, thanks.') } },
      { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'a1', size: 2048 } },
    ],
  },
};
const graphMessage = {
  id: 'g1', conversationId: 'c1', subject: 'Invoice', bodyPreview: 'Pay at once', receivedDateTime: '2023-11-14T22:13:20Z', isRead: false, isDraft: false,
  flag: { flagStatus: 'notFlagged' }, importance: 'normal', internetMessageId: '<m1@example.com>', parentFolderId: 'inbox-id', hasAttachments: true,
  from: { emailAddress: { name: 'Laura', address: 'laura@example.com' } }, toRecipients: [{ emailAddress: { name: 'me', address: 'me@example.org' } }],
  body: { contentType: 'text', content: 'Pay at https://pay.example.com/x?a=1, thanks.' },
};
const graphRules = [
  { when: at('GET', '/mailFolders/inbox'), then: reply(200, { id: 'inbox-id' }) },
  { when: at('GET', '/mailFolders/sentitems'), then: reply(200, { id: 'sent-id' }) },
  { when: at('GET', '/mailFolders/deleteditems'), then: reply(200, { id: 'trash-id' }) },
  { when: at('GET', '/messages/g1/attachments'), then: reply(200, { value: [{ name: 'invoice.pdf', contentType: 'application/pdf', size: 2048 }] }) },
  { when: at('GET', '/messages/g1'), then: reply(200, graphMessage) },
];

test('the same read answers the same neutral row from two providers', async () => {
  const gmail = standIn([{ when: at('GET', '/messages/m1'), then: reply(200, gmailMessage) }]);
  const outlook = standIn(graphRules);
  const one = await perform('read-a-mail', { provider: 'gmail', message_id: 'm1', connection: { connection_id: 'service_connection:google-account' } }, gmail.io);
  const two = await perform('read-a-mail', { provider: 'outlook', message_id: 'g1' }, outlook.io);
  assert.deepEqual(Object.keys(one), Object.keys(two));
  assert.deepEqual(Object.keys(one.headers), Object.keys(HEADER_FIELDS));
  for (const row of [one, two]) {
    assert.equal(row.headers.from, 'Laura <laura@example.com>');
    assert.equal(row.headers.subject, 'Invoice');
    assert.equal(row.headers.message_id, '<m1@example.com>');
    assert.equal(row.text, 'Pay at https://pay.example.com/x?a=1, thanks.');
    assert.deepEqual(row.links, ['https://pay.example.com/x?a=1']);
    assert.deepEqual(row.attachments, [{ name: 'invoice.pdf', mime_type: 'application/pdf', size: 2048 }]);
    assert.deepEqual(row.labels.filter(label => label === 'unread'), ['unread']);
    assert.equal(row.date_ms, 1700000000000);
    assert.equal(row.needs_original, true);
  }
  assert.deepEqual(one.labels, ['inbox', 'unread']);
  assert.deepEqual(two.labels, ['inbox', 'unread']);
  assert.equal(one.thread_id, 't1');
  assert.equal(two.thread_id, 'c1');
});

test('the key goes only in the Authorization header, to the provider\'s own host, and never in a url or body', async () => {
  for (const [provider, rules, input] of [['gmail', [{ when: at('GET', '/messages/m1'), then: reply(200, gmailMessage) }], { message_id: 'm1' }], ['outlook', graphRules, { message_id: 'g1' }]]) {
    const run = standIn(rules);
    await perform('read-a-mail', { provider, ...input }, run.io);
    const { hosts } = providerFor({ provider });
    for (const request of run.asked) {
      assert.ok(hosts.includes(new URL(request.url).hostname), `${provider} asked ${request.url}`);
      assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
      assert.ok(!request.url.includes(KEY) && !String(request.body ?? '').includes(KEY));
    }
  }
});

test('a provider\'s own refusal and an operation it does not offer are said in words, and nothing is sent for the second', async () => {
  const refusing = standIn([{ when: () => true, then: reply(403, { error: { message: 'insufficient scope' } }) }]);
  await assert.rejects(perform('find-my-mailbox', { provider: 'gmail' }, refusing.io), error => error instanceof Refused && /Gmail refused the request \(403\).*insufficient scope/.test(error.message));
  const none = standIn([]);
  await assert.rejects(perform('set-a-mail-signature', { provider: 'outlook', address: 'me@example.org', signature: 'x' }, none.io), /Outlook does not offer this: set a mail signature/);
  assert.equal(none.asked.length, 0);
  await assert.rejects(perform('find-my-mailbox', {}, none.io), /Give provider: one of gmail, outlook/);
  await assert.rejects(perform('find-my-mailbox', { provider: 'nope' }, none.io), /nope is not a mail provider here/);
});

test('a key held for nothing is refused before any request leaves', async () => {
  const run = standIn([]);
  await assert.rejects(perform('find-my-mailbox', { provider: 'gmail' }, { ...run.io, read: () => '  ' }), /holds no access key/);
  assert.equal(run.asked.length, 0);
});

test('finding mail and saving, then sending a draft read the same on both providers', async () => {
  const gmail = standIn([
    { when: at('GET', '/messages?'), then: reply(200, { messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'n2' }) },
    { when: at('POST', '/drafts/send'), then: reply(200, { id: 'sent1', threadId: 't1' }) },
    { when: at('POST', '/drafts'), then: reply(200, { id: 'd1', message: { id: 'dm1', threadId: 't1' } }) },
  ]);
  const outlook = standIn([
    { when: (url, init) => init.method === 'GET' && url.includes('/mailFolders/inbox/messages'), then: reply(200, { value: [{ id: 'g1', conversationId: 'c1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=50' }) },
    { when: at('POST', '/messages/d2/send'), then: reply(202) },
    { when: at('POST', '/messages'), then: reply(201, { id: 'd2', conversationId: 'c2' }) },
  ]);
  const found = await Promise.all([perform('find-mail', { provider: 'gmail', folder: 'inbox' }, gmail.io), perform('find-mail', { provider: 'outlook', folder: 'inbox' }, outlook.io)]);
  assert.deepEqual(found.map(row => Object.keys(row)), [['messages', 'next_page_token'], ['messages', 'next_page_token']]);
  assert.deepEqual(found.map(row => row.messages[0].id), ['m1', 'g1']);
  assert.match(gmail.asked[0].url, /q=in%3Ainbox/);
  const draft = { from: 'me@example.org', to: 'you@example.org', subject: 'Hi', text: 'Hello' };
  const saved = await Promise.all([perform('save-a-mail-draft', { provider: 'gmail', ...draft }, gmail.io), perform('save-a-mail-draft', { provider: 'outlook', ...draft }, outlook.io)]);
  assert.deepEqual(saved.map(row => Object.keys(row)), [['draft_id', 'message_id', 'thread_id'], ['draft_id', 'message_id', 'thread_id']]);
  const sent = await Promise.all([perform('send-a-mail-draft', { provider: 'gmail', draft_id: 'd1' }, gmail.io), perform('send-a-mail-draft', { provider: 'outlook', draft_id: 'd2' }, outlook.io)]);
  assert.deepEqual(sent.map(row => Object.keys(row)), [['message_id', 'thread_id'], ['message_id', 'thread_id']]);
  assert.deepEqual(JSON.parse(gmail.asked.find(request => request.url.endsWith('/drafts/send')).body), { id: 'd1' });
  assert.equal(JSON.parse(outlook.asked.find(request => request.method === 'POST' && request.url.endsWith('/messages')).body).toRecipients[0].emailAddress.address, 'you@example.org');
});

test('typed words search all mail on a provider, an empty search is the folder, an unknown folder is refused', async () => {
  const gmail = standIn([{ when: at('GET', '/messages?'), then: reply(200, {}) }]);
  await perform('find-mail', { provider: 'gmail', text: 'from:laura', folder: 'trash' }, gmail.io);
  assert.match(gmail.asked[0].url, /q=from%3Alaura/);
  assert.match(gmail.asked[0].url, /includeSpamTrash=true/);
  await perform('find-mail', { provider: 'gmail', folder: 'trash' }, gmail.io);
  assert.match(gmail.asked[1].url, /q=in%3Atrash/);
  await assert.rejects(perform('find-mail', { provider: 'gmail', folder: 'nowhere' }, gmail.io), /Gmail has no folder called nowhere/);
});

test('labels asked for and answered are neutral names, with the provider\'s own words only behind its row', async () => {
  const gmail = standIn([{ when: at('POST', '/messages/m1/modify'), then: reply(200, { id: 'm1', threadId: 't1', labelIds: ['STARRED', 'CATEGORY_UPDATES'] }) }]);
  const answer = await perform('organize-mail', { provider: 'gmail', message_id: 'm1', add_labels: ['starred'], remove_labels: ['unread', 'inbox'] }, gmail.io);
  assert.deepEqual(JSON.parse(gmail.asked[0].body), { addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD', 'INBOX'] });
  assert.deepEqual(answer, { id: 'm1', thread_id: 't1', labels: ['starred', 'CATEGORY_UPDATES'] });
});

test('a conversation operation on the second provider touches exactly the conversation\'s messages', async () => {
  const outlook = standIn([
    { when: (url, init) => init.method === 'GET' && url.includes('conversationId'), then: reply(200, { value: [{ id: 'g1' }, { id: 'g2' }] }) },
    { when: at('POST', '/move'), then: reply(201, { id: 'moved' }) },
  ]);
  await perform('trash-a-conversation', { provider: 'outlook', thread_id: "c'1" }, outlook.io);
  const moves = outlook.asked.filter(request => request.method === 'POST');
  assert.deepEqual(moves.map(request => request.url.split('/messages/')[1]), ['g1/move', 'g2/move']);
  assert.deepEqual(JSON.parse(moves[0].body), { destinationId: 'deleteditems' });
  assert.match(new URL(outlook.asked[0].url).searchParams.get('$filter'), /^conversationId eq 'c''1'$/);
});

test('the send-as list and the signature save carry the neutral words on Gmail and are not offered on the other', async () => {
  const gmail = standIn([
    { when: at('GET', '/settings/sendAs'), then: reply(200, { sendAs: [{ sendAsEmail: 'me@example.org', isPrimary: true, signature: 'Jo<br>' }, { sendAsEmail: 'alias@example.org' }] }) },
    { when: at('PATCH', '/settings/sendAs/me%40example.org'), then: reply(200, { sendAsEmail: 'me@example.org', signature: 'New' }) },
  ]);
  assert.deepEqual(await perform('list-send-as-addresses', { provider: 'gmail' }, gmail.io), { addresses: [{ address: 'me@example.org', is_primary: true, signature: 'Jo<br>' }, { address: 'alias@example.org', is_primary: false, signature: '' }] });
  assert.deepEqual(await perform('set-a-mail-signature', { provider: 'gmail', address: 'me@example.org', signature: 'New' }, gmail.io), { address: 'me@example.org', signature: 'New' });
  assert.deepEqual(JSON.parse(gmail.asked[1].body), { signature: 'New' });
  const outlook = standIn([{ when: at('GET', '/me?'), then: reply(200, { mail: 'me@example.org' }) }]);
  assert.deepEqual(await perform('list-send-as-addresses', { provider: 'outlook' }, outlook.io), { addresses: [{ address: 'me@example.org', is_primary: true, signature: null }] });
});

// The wire rules of Gmail's message format, carried over from the earlier mail screen's tests.
test('draft editing retains inline MIME media, formatting and extra content', () => {
  assert.equal(draftNeedsOriginal({ mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: 'aGVsbG8' } }] }), false);
  for (const part of [{ mimeType: 'image/png', body: { data: 'aGVsbG8' } }, { mimeType: 'text/html', body: { data: 'aGVsbG8' } }, { mimeType: 'audio/wav', headers: [{ name: 'Content-ID', value: 'inline' }] }, { mimeType: 'application/pdf', filename: 'file.pdf' }]) assert.equal(draftNeedsOriginal({ mimeType: 'multipart/mixed', parts: [part] }), true);
  const provider = providerFor({ provider: 'gmail' });
  assert.equal(toNeutral(provider, { id: 'd', payload: { mimeType: 'text/plain', headers: [hdr('Bcc', 'x@example.com')], body: { data: b64('hi') } } }).needs_original, true);
});

test('composed mail preserves UTF-8, strips header newlines and keeps reply references', () => {
  const raw = rawMessage({ from: 'me@example.org', to: 'you@example.org', subject: 'Hello\r\nBcc: bad@example.org', text: 'A café ☕', in_reply_to: '<message@example.org>' });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.ok(!decoded.includes('\r\nBcc:'));
  assert.ok(decoded.includes('In-Reply-To: <message@example.org>'));
  assert.equal(Buffer.from(decoded.split('\r\n\r\n')[1], 'base64').toString('utf8'), 'A café ☕');
  const coded = Buffer.from(rawMessage({ from: 'me@example.org', to: 'a@example.com', subject: 'Café', text: 'B' }), 'base64url').toString('utf8');
  assert.match(coded, /Subject: =\?UTF-8\?B\?Q2Fmw6k=\?=/);
});

test('a Cc line is written to the message and replies keep their references in order', () => {
  const raw = rawMessage({ from: 'me@example.org', to: 'a@example.com', cc: 'c@example.com, e@example.com', subject: 'S', text: 'B', in_reply_to: '<m@x>', references: '<m@x>' });
  const head = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0].split('\r\n');
  assert.deepEqual(head.filter(line => /^(To|Cc|Subject|In-Reply-To|References):/.test(line)), ['To: a@example.com', 'Cc: c@example.com, e@example.com', 'Subject: S', 'In-Reply-To: <m@x>', 'References: <m@x>']);
});

test('text, links and attachments are read from the message parts; html is read only for its links', () => {
  const payload = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', body: { data: b64('Pay at https://pay.example.com/x?a=1, thanks. https://pay.example.com/x?a=1') } },
    { mimeType: 'text/html', body: { data: b64('<b>never handed on</b><a href="https://site.example.com/a&amp;b">x</a><a href="javascript:alert(1)">y</a>') } },
    { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'a1', size: 2048 } }] };
  assert.deepEqual(messageLinks(payload), ['https://pay.example.com/x?a=1', 'https://site.example.com/a&b']);
  assert.deepEqual(messageAttachments(payload), [{ name: 'invoice.pdf', mime_type: 'application/pdf', size: 2048 }]);
  assert.equal(plainTextBody(payload), 'Pay at https://pay.example.com/x?a=1, thanks. https://pay.example.com/x?a=1');
  assert.equal(plainTextBody({ mimeType: 'text/html', body: { data: b64('<b>x</b>') } }), null);
});

// Carried over from the earlier conversation-tools contract test: a headers-only read of a conversation, and done, delete
// and restore acting on the whole conversation at exactly the thread endpoints.
test('reading a conversation asks for its headers only; done, delete and restore act on the whole conversation', async () => {
  const thread = { id: 'thread-1', messages: [{ id: 'm1', threadId: 'thread-1', labelIds: ['INBOX'], snippet: 'Hi', internalDate: '1792300000000', payload: { headers: [hdr('From', 'user-fb98d44a@example.com')] } }] };
  const gmail = standIn([
    { when: at('GET', '/threads/thread-1'), then: reply(200, thread) },
    { when: at('POST', '/threads/thread-1/modify'), then: reply(200, { id: 'thread-1' }) },
    { when: at('POST', '/threads/thread-1/trash'), then: reply(200, { id: 'thread-1' }) },
    { when: at('POST', '/threads/thread-1/untrash'), then: reply(200, { id: 'thread-1' }) },
  ]);
  const read = await perform('read-a-conversation', { provider: 'gmail', thread_id: 'thread-1' }, gmail.io);
  assert.deepEqual(read.messages.map(row => row.id), ['m1']);
  assert.deepEqual(read.messages[0].labels, ['inbox']);
  const url = new URL(gmail.asked[0].url);
  assert.equal(url.origin + url.pathname, 'https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1');
  assert.equal(url.searchParams.get('format'), 'metadata');
  assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID']);
  await perform('organize-a-conversation', { provider: 'gmail', thread_id: 'thread-1', remove_labels: ['inbox'] }, gmail.io);
  assert.deepEqual(JSON.parse(gmail.asked[1].body), { removeLabelIds: ['INBOX'] });
  await perform('trash-a-conversation', { provider: 'gmail', thread_id: 'thread-1' }, gmail.io);
  await perform('restore-a-conversation', { provider: 'gmail', thread_id: 'thread-1' }, gmail.io);
  assert.deepEqual(gmail.asked.slice(1).map(request => `${request.method} ${request.url}`), [
    'POST https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/modify',
    'POST https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/trash',
    'POST https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/untrash',
  ]);
  const refusing = standIn([{ when: () => true, then: reply(403, { error: 'insufficient authentication scopes' }) }]);
  await assert.rejects(perform('trash-a-conversation', { provider: 'gmail', thread_id: 'thread-1' }, refusing.io), /refused the request \(403\)/);
});
