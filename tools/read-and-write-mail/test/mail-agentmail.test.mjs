// tools/read-and-write-mail/test/mail-agentmail.test.mjs
// The AgentMail provider against a stand-in AgentMail server: each read answers the neutral rows; the vault key goes only
// in the Authorization header to the provider's own host; a page token carries each inbox's own next page; a plain-text
// part is preferred and an HTML-only message is read as text; a refusal, an unoffered job and a bad id are said in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { perform, providerFor, keepAMailAttachment, Refused } from '../read-data/mail.mjs';
import { HEADER_FIELDS } from '../read-data/neutral.mjs';
import { blake3 } from '../../content-identity/read-data/blake3.mjs';

const KEY = 'agentmail-held-key-value';
const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const INBOXES = {
  inboxes: [
    { inbox_id: 'stand-in-one@example.com', email: 'stand-in-one@example.com', status: 'active', signature: { text: 'Sent by the stand-in' } },
    { inbox_id: 'stand-in-off@example.com', email: 'stand-in-off@example.com', status: 'deactivated' },
    { inbox_id: 'stand-in-two@example.com', email: 'stand-in-two@example.com' },
  ],
  count: 3,
};

const message = (id, extra = {}) => ({
  inbox_id: 'stand-in-one@example.com', thread_id: `thread-${id}`, message_id: id, labels: ['received', 'unread'],
  timestamp: '2026-11-20T10:00:00Z', from: 'Laura <laura@example.com>', to: ['stand-in-one@example.com'], size: 10,
  updated_at: '2026-11-20T10:00:00Z', created_at: '2026-11-20T10:00:00Z', subject: 'Invoice', preview: 'Pay at once',
  ...extra,
});

/** A stand-in AgentMail: routes by method and path, records every request it was asked. */
function standIn(routes) {
  const asked = [];
  const send = async (url, init) => {
    const target = new URL(url);
    asked.push({ method: init.method, url: target.toString(), headers: init.headers, body: init.body, search: target.searchParams });
    const route = routes.find(([method, pattern]) => method === init.method && pattern.test(target.pathname + target.search));
    if (!route) return json(404, { name: 'NotFoundError', message: 'no stand-in', code: 'not_found' });
    return route[2](target, init);
  };
  return { asked, io: { read: () => KEY, send } };
}

const decodeToken = token => JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));

test('find-my-mailbox answers the first inbox the key reaches that is not deactivated, with the key only in the header', async () => {
  const run = standIn([['GET', /^\/v0\/inboxes/, () => json(200, INBOXES)]]);
  const answer = await perform('find-my-mailbox', { provider: 'agentmail', connection: { connection_id: 'service_connection:agentmail' } }, run.io);
  assert.equal(answer.address, 'stand-in-one@example.com');
  assert.deepEqual(Object.keys(answer), ['address', 'cursor', 'messages_total', 'threads_total']);
  for (const request of run.asked) {
    assert.equal(new URL(request.url).hostname, 'api.agentmail.to');
    assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(!request.url.includes(KEY));
  }
});

test('list-new-mail asks every live inbox for received mail after the cursor, and a page token continues each inbox where it stopped', async () => {
  const run = standIn([
    ['GET', /^\/v0\/inboxes\?/, () => json(200, INBOXES)],
    ['GET', /^\/v0\/inboxes\/stand-in-one%40example\.com\/messages\?/, () => json(200, { count: 1, messages: [message('m1', { timestamp: '2026-11-20T10:00:00Z' })], next_page_token: 'p2' })],
    ['GET', /^\/v0\/inboxes\/stand-in-two%40example\.com\/messages\?/, () => json(200, { count: 1, messages: [message('m9', { inbox_id: 'stand-in-two@example.com', thread_id: 'th9', timestamp: '2026-11-20T11:00:00Z', labels: ['received'] })] })],
  ]);
  const first = await perform('list-new-mail', { provider: 'agentmail', since: '2026-11-19T00:00:00Z' }, run.io);
  assert.deepEqual(first.messages.map(row => row.id), ['stand-in-one@example.com/m1', 'stand-in-two@example.com/m9']);
  assert.deepEqual(first.messages[0].labels, ['inbox', 'unread']);
  assert.equal(first.cursor, '2026-11-20T11:00:00Z');
  const queries = run.asked.filter(request => request.url.includes('/messages?'));
  assert.ok(queries.every(request => request.search.getAll('labels').join() === 'received' && request.search.get('after') === '2026-11-19T00:00:00Z'));
  assert.deepEqual(decodeToken(first.next_page_token), [['stand-in-one@example.com', 'p2']]);

  const second = standIn([['GET', /^\/v0\/inboxes\/stand-in-one%40example\.com\/messages\?/, () => json(200, { count: 0, messages: [] })]]);
  const rest = await perform('list-new-mail', { provider: 'agentmail', since: '2026-11-19T00:00:00Z', page_token: first.next_page_token }, second.io);
  assert.deepEqual(rest.messages, []);
  assert.equal(second.asked.length, 1, 'the continuation asks only the inbox that has more');
  assert.equal(second.asked[0].search.get('page_token'), 'p2');
});

test('find-mail reads a folder by its label, typed words search every inbox, and a folder the row lacks is refused in words', async () => {
  const run = standIn([
    ['GET', /^\/v0\/inboxes\?/, () => json(200, { inboxes: [INBOXES.inboxes[0]] })],
    ['GET', /^\/v0\/inboxes\/stand-in-one%40example\.com\/messages\?/, () => json(200, { messages: [message('m1')] })],
    ['GET', /^\/v0\/inboxes\/stand-in-one%40example\.com\/messages\/search\?/, () => json(200, { messages: [message('s1', { labels: ['received'] })] })],
  ]);
  const inbox = await perform('find-mail', { provider: 'agentmail', folder: 'inbox' }, run.io);
  assert.deepEqual(inbox.messages, [{ id: 'stand-in-one@example.com/m1', thread_id: 'stand-in-one@example.com/thread-m1' }]);
  assert.deepEqual(run.asked.at(-1).search.getAll('labels'), ['received']);

  const typed = await perform('find-mail', { provider: 'agentmail', text: 'invoice' }, run.io);
  assert.equal(typed.messages[0].id, 'stand-in-one@example.com/s1');
  assert.equal(run.asked.at(-1).search.get('q'), 'invoice');

  await assert.rejects(perform('find-mail', { provider: 'agentmail', folder: 'starred' }, run.io), error => error instanceof Refused && /AgentMail has no folder called starred/.test(error.message));
});

test('a read answers the neutral row: a plain-text part is the text, an HTML-only message is its text with its links, attachments are listed', async () => {
  const withText = message('m1', { text: 'Pay at https://pay.example.com/x?a=1, thanks.', html: '<p>Pay</p>', attachments: [{ attachment_id: 'a1', size: 2048, filename: 'invoice.pdf', content_type: 'application/pdf' }], headers: { 'Message-ID': '<m1@example.com>', 'List-Unsubscribe': '<mailto:u@example.com>' }, calendar_event_id: null });
  const htmlOnly = message('m2', { text: null, labels: ['received'], html: '<div>Hello &amp; welcome</div><a href="https://go.example.com/start">Start</a><script>x()</script>', attachments: [] });
  const run = standIn([
    ['GET', /^\/v0\/inboxes\/stand-in-one%40example\.com\/messages\/m1$/, () => json(200, withText)],
    ['GET', /^\/v0\/inboxes\/stand-in-one%40example\.com\/messages\/m2$/, () => json(200, htmlOnly)],
  ]);
  const one = await perform('read-a-mail', { provider: 'agentmail', message_id: 'stand-in-one@example.com/m1' }, run.io);
  assert.deepEqual(Object.keys(one.headers), Object.keys(HEADER_FIELDS));
  assert.equal(one.id, 'stand-in-one@example.com/m1');
  assert.equal(one.thread_id, 'stand-in-one@example.com/thread-m1');
  assert.equal(one.headers.from, 'Laura <laura@example.com>');
  assert.equal(one.headers.message_id, '<m1@example.com>');
  assert.equal(one.headers.list_unsubscribe, '<mailto:u@example.com>');
  assert.equal(one.text, 'Pay at https://pay.example.com/x?a=1, thanks.');
  assert.deepEqual(one.links, ['https://pay.example.com/x?a=1']);
  assert.deepEqual(one.attachments, [{ attachment_id: 'a1', name: 'invoice.pdf', mime_type: 'application/pdf', size: 2048 }]);
  assert.equal(one.needs_original, true);
  assert.equal(one.date_ms, Date.parse('2026-11-20T10:00:00Z'));

  const two = await perform('read-a-mail', { provider: 'agentmail', message_id: 'stand-in-one@example.com/m2' }, run.io);
  assert.equal(two.text, 'Hello & welcome\nStart');
  assert.deepEqual(two.links, ['https://go.example.com/start']);
  assert.deepEqual(two.labels, ['inbox']);
  assert.equal(two.attachments.length, 0);
});

test('reading headers asks for the message without its body, and an id a list did not give is refused before any request', async () => {
  const run = standIn([['GET', /^\/v0\/inboxes\/stand-in-one%40example\.com\/messages\/m1$/, () => json(200, message('m1', { text: 'body', html: '<p>body</p>' }))]]);
  const headers = await perform('read-mail-headers', { provider: 'agentmail', message_id: 'stand-in-one@example.com/m1' }, run.io);
  assert.equal(headers.text, null);
  assert.deepEqual(headers.links, []);
  const none = standIn([]);
  await assert.rejects(perform('read-a-mail', { provider: 'agentmail', message_id: 'm1' }, none.io), error => error instanceof Refused && /as a list answered it/.test(error.message));
  assert.equal(none.asked.length, 0);
});

test('a conversation is every message of its thread, oldest first, with the inbox in each neutral id', async () => {
  const run = standIn([
    ['GET', /^\/v0\/inboxes\/stand-in-one%40example\.com\/threads\/thread-a\?/, () => json(200, {
      thread_id: 'thread-a', messages: [message('m2', { thread_id: 'thread-a', timestamp: '2026-11-20T12:00:00Z', labels: ['sent'], text: 'Reply' }), message('m1', { thread_id: 'thread-a', text: 'First' })],
    })],
  ]);
  const answer = await perform('read-a-conversation', { provider: 'agentmail', thread_id: 'stand-in-one@example.com/thread-a' }, run.io);
  assert.equal(answer.thread_id, 'stand-in-one@example.com/thread-a');
  assert.deepEqual(answer.messages.map(row => row.id), ['stand-in-one@example.com/m1', 'stand-in-one@example.com/m2']);
  assert.deepEqual(answer.messages[1].labels, ['sent']);
  assert.ok(answer.messages.every(row => row.thread_id === 'stand-in-one@example.com/thread-a'));
});

test('the send-as list is the live inboxes with their signature text, and an operation the row does not offer is refused in words without a request', async () => {
  const run = standIn([['GET', /^\/v0\/inboxes\?/, () => json(200, INBOXES)]]);
  const answer = await perform('list-send-as-addresses', { provider: 'agentmail' }, run.io);
  assert.deepEqual(answer.addresses, [
    { address: 'stand-in-one@example.com', is_primary: true, signature: 'Sent by the stand-in' },
    { address: 'stand-in-two@example.com', is_primary: false, signature: null },
  ]);
  const none = standIn([]);
  await assert.rejects(perform('send-a-mail-draft', { provider: 'agentmail', draft_id: 'x' }, none.io), /AgentMail does not offer this: send a mail draft\./);
  assert.equal(none.asked.length, 0);
  assert.equal(providerFor({ provider: 'agentmail' }).secret_name, 'agentmail-api-key');
});

test('a refusal from AgentMail is quoted in words, up to its first 300 characters, and the key is never in the words', async () => {
  const run = standIn([['GET', /^\/v0\/inboxes/, () => json(401, { name: 'UnauthorizedError', message: 'bad key', code: 'unauthorized' })]]);
  await assert.rejects(perform('find-my-mailbox', { provider: 'agentmail' }, run.io), error => error instanceof Refused && /AgentMail refused the request \(401\).*bad key/.test(error.message) && !error.message.includes(KEY));
});

test('keeping an attachment: the key goes to the API only, the signed download carries no key, the bytes are the kept file, and the answer names them', async () => {
  const run = standIn([
    ['GET', /^\/v0\/inboxes\/stand-in-one%40example\.com\/messages\/m1\/attachments\/a1$/, () => json(200, { attachment_id: 'a1', size: 5, download_url: 'https://downloads.example.com/att/a1?sig=stand-in', filename: 'guide.pdf', content_type: 'application/pdf' })],
    ['GET', /^\/att\/a1\?sig=stand-in$/, () => new Response('hello', { status: 200 })],
  ]);
  const out = join(mkdtempSync(join(tmpdir(), 'mail-attachment-')), 'attachment');
  const answer = await keepAMailAttachment({ provider: 'agentmail', connection: { connection_id: 'service_connection:agentmail' }, message_id: 'stand-in-one@example.com/m1', attachment_id: 'a1' }, { ...run.io, out });
  assert.deepEqual(Object.keys(answer), ['name', 'bytes', 'media_type', 'blake3']);
  assert.equal(answer.name, 'guide.pdf');
  assert.equal(answer.bytes, 5);
  assert.equal(answer.media_type, 'application/pdf');
  assert.equal(answer.blake3, Buffer.from(blake3(Buffer.from('hello'))).toString('hex'));
  assert.equal(readFileSync(out, 'utf8'), 'hello');
  const api = run.asked.find(request => request.url.startsWith('https://api.agentmail.to/'));
  const download = run.asked.find(request => request.url.startsWith('https://downloads.example.com/'));
  assert.equal(api.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(download.headers.Authorization, undefined, 'the signed download carries no key');
  assert.ok(!download.url.includes(KEY));
});

test('a download is refused in words when the address is not https, when the reply is too large, and when the attachment is too large', async () => {
  const insecure = standIn([
    ['GET', /\/attachments\/a1$/, () => json(200, { attachment_id: 'a1', size: 5, download_url: 'http://downloads.example.com/att/a1', filename: 'guide.pdf' })],
  ]);
  await assert.rejects(keepAMailAttachment({ provider: 'agentmail', message_id: 'stand-in-one@example.com/m1', attachment_id: 'a1' }, { ...insecure.io, out: join(tmpdir(), 'unused') }), error => error instanceof Refused && /not https/.test(error.message));
  assert.equal(insecure.asked.length, 1, 'nothing was fetched from the address');

  const big = standIn([
    ['GET', /\/attachments\/a1$/, () => json(200, { attachment_id: 'a1', size: 16777217, download_url: 'https://downloads.example.com/att/a1', filename: 'guide.pdf' })],
  ]);
  await assert.rejects(keepAMailAttachment({ provider: 'agentmail', message_id: 'stand-in-one@example.com/m1', attachment_id: 'a1' }, { ...big.io, out: join(tmpdir(), 'unused') }), error => error instanceof Refused && /keeps at most 16777216 bytes/.test(error.message));

  const streamed = standIn([
    ['GET', /\/attachments\/a1$/, () => json(200, { attachment_id: 'a1', size: 5, download_url: 'https://downloads.example.com/att/a2', filename: 'guide.pdf' })],
    ['GET', /\/att\/a2$/, () => new Response('x', { status: 200, headers: { 'content-length': '16777217' } })],
  ]);
  await assert.rejects(keepAMailAttachment({ provider: 'agentmail', message_id: 'stand-in-one@example.com/m1', attachment_id: 'a1' }, { ...streamed.io, out: join(tmpdir(), 'unused') }), error => error instanceof Refused && /keeps at most/.test(error.message));
});

test('Outlook does not offer keeping an attachment, and says so in words without a request', async () => {
  const none = standIn([]);
  await assert.rejects(perform('keep-a-mail-attachment', { provider: 'outlook', message_id: 'g1', attachment_id: 'a1' }, none.io), /Outlook does not offer this: keep a mail attachment\./);
  assert.equal(none.asked.length, 0);
});

test('a download that fails to connect names its host and error code in words, and never the signed query', async () => {
  const failing = standIn([
    ['GET', /\/attachments\/a1$/, () => json(200, { attachment_id: 'a1', size: 5, download_url: 'https://downloads.example.com/att/a1?sig=stand-in-secret', filename: 'guide.pdf' })],
    ['GET', /\/att\/a1\?sig=stand-in-secret$/, () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }],
  ]);
  const out = join(tmpdir(), 'unused');
  await assert.rejects(keepAMailAttachment({ provider: 'agentmail', message_id: 'stand-in-one@example.com/m1', attachment_id: 'a1' }, { ...failing.io, out }), error => error instanceof Refused
    && /downloads\.example\.com: ENOTFOUND/.test(error.message)
    && !error.message.includes('stand-in-secret') && !error.message.includes('sig='));
});
