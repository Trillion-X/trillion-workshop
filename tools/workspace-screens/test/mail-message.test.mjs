// The mail screens' reading of one provider-neutral message row (web/src/workspace/mail-message.ts): who a reply-all goes
// to, who a conversation names, what a forward opens with, a signature round trip, a conversation's order, and a
// recipients line. The module knows no provider: every message here is the neutral row the mail tools answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../web/src/workspace/mail-message.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const mail = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const headers = (fields = {}) => ({ from: '', to: '', cc: '', bcc: '', reply_to: '', subject: '', date: '', message_id: '', references: '', in_reply_to: '', list_unsubscribe: '', ...fields });
const message = (id, fields = {}, rest = {}) => ({ id, thread_id: 't1', draft_id: null, labels: [], date_ms: null, snippet: '', headers: headers(fields), has_calendar_invite: false, text: null, links: [], attachments: [], needs_original: false, ...rest });

test('reply all keeps the sender first, everyone else once, and never this mailbox', () => {
  const row = headers({ from: 'Laura <laura@example.com>', to: 'Me <me@example.org>, "Doe, Jo" <jo@example.com>', cc: 'JO@example.com, sam@example.com' });
  assert.deepEqual(mail.replyAllRecipients(row, 'me@example.org'), { to: ['Laura <laura@example.com>'], cc: ['"Doe, Jo" <jo@example.com>', 'sam@example.com'] });
  assert.deepEqual(mail.replyAllRecipients(headers({ reply_to: 'r@example.com', from: 'f@example.com' }), 'me@example.org').to, ['r@example.com']);
});

test('a recipients line is checked address by address', () => {
  assert.deepEqual(mail.mailRecipients('a@example.com; Jo <j@example.com>'), ['a@example.com', 'Jo <j@example.com>']);
  assert.equal(mail.mailRecipients('a@example.com, nope'), null);
  assert.equal(mail.mailRecipients('a@example.com\r\nBcc: x@example.com'), null);
  assert.deepEqual(mail.splitEmailAddresses('"Doe, Jo" <jo@example.com>, sam@example.com'), ['"Doe, Jo" <jo@example.com>', 'sam@example.com']);
  assert.equal(mail.mailName('"Doe, Jo" <jo@example.com>'), 'Doe, Jo');
  assert.equal(mail.mailAddress('Laura <laura@example.com>'), 'laura@example.com');
});

test('participants are named once each in the order first named, and a forward opens with the original\'s lines', () => {
  const row = message('m1', { from: 'Laura <laura@example.com>', to: 'me@example.org', cc: 'laura@example.com, sam@example.com', date: 'Tue, 14 Nov 2023', subject: 'Invoice' }, { text: 'Pay soon.' });
  assert.deepEqual(mail.mailParticipants([row, undefined]).map(person => person.address), ['laura@example.com', 'me@example.org', 'sam@example.com']);
  assert.equal(mail.forwardBody(row, { marker: '--- Forwarded ---', from: 'From', date: 'Date', subject: 'Subject', to: 'To' }),
    '\n\n--- Forwarded ---\nFrom: Laura <laura@example.com>\nDate: Tue, 14 Nov 2023\nSubject: Invoice\nTo: me@example.org\n\nPay soon.');
});

test('a signature round-trips through plain lines and says when formatting would be lost', () => {
  assert.deepEqual(mail.signatureText('Jo<br>Ethos &amp; Co<div>+1 555</div>'), { text: 'Jo\nEthos & Co\n+1 555', lossy: false });
  assert.equal(mail.signatureText('<b>Jo</b><br><a href="https://x.com">site</a>').lossy, true);
  assert.equal(mail.signatureHtml('A & B\n<c>'), 'A &amp; B<br>&lt;c&gt;');
});

test('the primary address is the one the provider declares, and only one', () => {
  assert.equal(mail.primaryMailAddress([{ address: 'a@example.org', is_primary: false, signature: null }, { address: 'me@example.org', is_primary: true, signature: 'Jo' }], 'Provider').address, 'me@example.org');
  assert.throws(() => mail.primaryMailAddress([], 'Provider'), /Provider returned no primary address/);
  assert.throws(() => mail.primaryMailAddress([{ address: 'a', is_primary: true, signature: null }, { address: 'b', is_primary: true, signature: null }], 'Provider'), /more than one primary/);
  assert.throws(() => mail.primaryMailAddress(undefined, 'Provider'), /did not return the addresses/);
});

test('a conversation is oldest first, without its drafts, and a long one keeps only its latest messages', () => {
  const row = (id, at, labels = []) => message(id, {}, { date_ms: at, labels });
  const view = mail.mailThreadView('t1', [row('c', 300), row('draft', 400, ['draft']), row('a', 100), row('b', 200)], 10);
  assert.deepEqual(view.messages.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(view.earlier, 0);
  const cut = mail.mailThreadView('t1', [row('c', 300), row('a', 100), row('b', 200)], 2);
  assert.deepEqual(cut.messages.map(item => item.id), ['b', 'c']);
  assert.equal(cut.earlier, 1);
  assert.deepEqual(mail.mailThreadView('t1', undefined, 5), { threadId: 't1', messages: [], earlier: 0 });
});

test('a provider\'s web page for a message is written from its row\'s template', () => {
  assert.equal(mail.mailWebLink('https://mail.example/?u={mailbox}#all/{id}', 'second@example.org', 'm 1'), 'https://mail.example/?u=second%40example.org#all/m%201');
});
