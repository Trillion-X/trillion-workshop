// tools/send-messages/test/mail-sender.test.mjs
//
// The mail rules as the older owner's test/mail-per-person-limit.test.mjs, test/mail-admission.test.mjs and
// test/mail-sender.test.mjs proved them, through the fake records door holding exactly the rights the email rows declare:
// every send written down under its address, the per-person limits, a sign-in code's subject never kept, a proof never
// handed to the provider, the day's keep-back and the provider filling it, refusals before dispatch given back and every
// other failure kept as unknown, two sends racing for the last slot, the sender from the mail row alone, the written
// email's BCC and sent copy, and subscription headers.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import lookRows from '../../screen-looks/tool-rows.json' with { type: 'json' };
import { REJECTED, SETTINGS, SETTINGS_ID, SHIPPED, bindingFor, mailSender, mailSettings, sendAnEmail } from '../do-work/mail-sender.mjs';
import { providerOf } from '../do-work/send-a-message.mjs';

const doors = [];
after(() => Promise.all(doors.map(fake => fake.close())));

// The shipped row with a sender, as an account names its own.
const settingsWith = (change = {}) => ({ ...structuredClone(SHIPPED), from: { email: 'hello@example.com', name: 'Example' }, owner: 'owner@example.com', ...change });

async function doorFor(records = []) {
  const fake = await startFakeDoor({ rights: rowOf(rows, 'tool:send-an-email').invoke.records.rights, records });
  doors.push(fake);
  return { fake, door: openRecordsDoor({ descriptor: fake.descriptor }) };
}

// A provider that takes every email (or answers `fail` for it), and keeps what it was given.
function provider(fail = null) {
  const sends = [];
  return { sends, send: async composed => { sends.push(composed); if (fail) throw fail(sends.length); return { messageId: `m${sends.length}` }; } };
}

async function senderWith(settings = settingsWith(), binding = provider(), readLook = undefined) {
  const { fake, door } = await doorFor();
  return { fake, door, binding, settings, sender: mailSender({ row: settings, door, binding, provider: 'resend', readLook }) };
}

const most = (settings, kind) => settings.per_person.limits.find(limit => (limit.kinds ? limit.kinds.includes(kind) : !limit.all_kinds_except.includes(kind))).most;
const coded = (message, code) => () => Object.assign(new Error(message), { code });

describe('the mail rules (older owner: mail-sender.mjs, mail-admission.mjs)', () => {
  it('messages to one person stop at the daily limit, and every send is listed', async () => {
    const { sender, binding, settings } = await senderWith();
    const results = [];
    for (let i = 0; i <= most(settings, 'message'); i += 1) results.push(await sender.sendMail(null, { to: 'Proof@Example.com', subject: `Note ${i}`, text: 'hi' }));
    assert.equal(binding.sends.length, most(settings, 'message'));
    assert.equal(results.at(-1).sent, false);
    assert.equal(results.at(-1).limited, true);
    const listed = await sender.sentTo('proof@example.com');
    assert.deepEqual(listed.map(row => row.subject), binding.sends.map(message => message.subject));
    assert.ok(listed.every(row => row.kind === settings.per_person.default_kind && row.at));
  });

  it('sign-in codes have their own hourly limit, are not stopped by the daily one, and keep no subject', async () => {
    const { sender, binding, settings, fake } = await senderWith();
    for (let i = 0; i < most(settings, 'message'); i += 1) await sender.sendMail(null, { to: 'proof@example.com', subject: `Note ${i}`, text: 'hi' });
    const codes = [];
    for (let i = 0; i <= most(settings, 'sign-in-code'); i += 1) codes.push(await sender.sendMail(null, { to: 'proof@example.com', kind: 'sign-in-code', subject: `Your code: 12345${i}`, text: 'code' }));
    assert.equal(codes.filter(result => result.sent).length, most(settings, 'sign-in-code'));
    assert.equal(codes.at(-1).limited, true);
    assert.equal(codes.at(-1).error, settings.per_person.limits[0].says);
    assert.equal(binding.sends.length, most(settings, 'message') + most(settings, 'sign-in-code'));
    const listed = await sender.sentTo('proof@example.com');
    assert.ok(listed.filter(row => row.kind === 'sign-in-code').every(row => !('subject' in row)));
    assert.ok([...fake.kept.values()].every(record => !JSON.stringify(record.value).includes('12345')), 'a code is never kept in a record');
  });

  it('a limit counts only sends inside its window', async () => {
    const { sender, settings } = await senderWith();
    const now = Date.parse('2026-10-01T12:00:00Z');
    const old = Array.from({ length: most(settings, 'message') }, () => ({ at: '2026-09-29T12:00:00Z', kind: 'message' }));
    assert.equal(sender.limitReached(old, 'message', now), null);
    const fresh = old.map(row => ({ ...row, at: '2026-10-01T11:00:00Z' }));
    assert.ok(sender.limitReached(fresh, 'message', now));
  });

  it('a proof account\'s own address never reaches the provider, is still written down, and spends none of the day', async () => {
    const { sender, binding, settings, fake } = await senderWith();
    const code = await sender.sendMail(null, { to: 'proof-1791090000000@example.test', kind: 'sign-in-code', subject: 'Your code: 424242', text: 'Your code is 424242' });
    const other = await sender.sendMail(null, { to: 'Proof-1791090000001@Example.test', subject: 'Your trial has started', text: 'hi' });
    assert.equal(binding.sends.length, 0, 'the provider was never asked');
    assert.deepEqual([code.sent, code.kept_for_proof], [true, settings.held_for_proofs.not_kept]);
    assert.deepEqual([other.sent, other.kept_for_proof], [true, settings.held_for_proofs.not_kept]);
    assert.equal((await sender.sentTo('proof-1791090000000@example.test')).length, 1, 'still listed under the address');
    assert.equal([...fake.kept.values()].some(record => record.type === 'mail-day'), false, 'a proof spends none of the day');
  });

  it('the day keeps room for sign-in codes, its most stops every kind, and the provider saying the day is full fills it', async () => {
    const settings = settingsWith({ daily: { ...SHIPPED.daily, most: 4, keep_back: 2 } });
    const { sender, binding } = await senderWith(settings);
    assert.equal((await sender.sendMail(null, { to: 'a@example.com', subject: 'One', text: 'hi' })).sent, true);
    assert.equal((await sender.sendMail(null, { to: 'b@example.com', subject: 'Two', text: 'hi' })).sent, true);
    const held = await sender.sendMail(null, { to: 'c@example.com', subject: 'Three', text: 'hi' });
    assert.deepEqual([held.sent, held.limited, held.error], [false, true, settings.daily.says]);
    assert.equal((await sender.sendMail(null, { to: 'c@example.com', kind: 'sign-in-code', subject: 'Your code: 1', text: 'code' })).sent, true, 'a sign-in code still goes');
    assert.equal((await sender.sendMail(null, { to: 'd@example.com', kind: 'sign-in-code', subject: 'Your code: 2', text: 'code' })).sent, true);
    assert.equal((await sender.sendMail(null, { to: 'e@example.com', kind: 'sign-in-code', subject: 'Your code: 3', text: 'code' })).limited, true, 'the absolute most stops every kind');
    assert.equal(binding.sends.length, 4);

    const full = await senderWith(settingsWith(), provider(coded('Resend 429 daily_quota_exceeded: You have reached your daily email sending quota.', 'daily_quota_exceeded')));
    assert.equal((await full.sender.sendMail(null, { to: 'f@example.com', subject: 'Four', text: 'hi' })).sent, false);
    const day = [...full.fake.kept.values()].find(record => record.type === 'mail-day');
    assert.equal(day.value.used, SHIPPED.daily.most, 'the day is full');
    assert.equal((await full.sender.sendMail(null, { to: 'g@example.com', kind: 'sign-in-code', subject: 'Your code: 5', text: 'code' })).error, SHIPPED.daily.says, 'nothing else knocks once the day is full');
    assert.equal(full.binding.sends.length, 1);
  });

  it('refusals before dispatch release their allowance, unknown outcomes keep it, and nothing that may have gone is sent again blindly', async () => {
    const refusing = provider(coded('Resend 422 invalid_from_address: Invalid `from` field.', 'invalid_from_address'));
    const { sender, door, settings, fake } = await senderWith(settingsWith(), refusing);
    const address = 'recovery@example.com';
    for (let n = 0; n < 4; n += 1) {
      const answer = await sender.sendMail(null, { to: address, subject: 'Quota test', text: 'Only the test provider sees this.' });
      assert.deepEqual([answer.sent, answer.limited, answer.unknown], [false, undefined, undefined]);
    }
    assert.equal([...fake.kept.values()].find(record => record.type === 'mail-day').value.used, 0, 'every refusal gave its day back');
    const lost = mailSender({ row: settings, door, binding: provider(coded('Resend 500 application_error: Something went wrong.', 'application_error')), provider: 'resend' });
    for (let n = 0; n < most(settings, 'message'); n += 1) assert.equal((await lost.sendMail(null, { to: address, subject: 's', text: 'hi' })).unknown, true);
    const taking = provider();
    const later = mailSender({ row: settings, door, binding: taking, provider: 'resend' });
    assert.equal((await later.sendMail(null, { to: address, subject: 's', text: 'hi' })).limited, true, 'a send that may have gone keeps counting');
    assert.equal(taking.sends.length, 0);
    const reset = mailSender({ row: settings, door, binding: provider(() => new Error('connection reset')), provider: 'resend' });
    assert.equal((await reset.sendMail(null, { to: 'other@example.com', subject: 's', text: 'hi' })).unknown, true, 'no provider code: unknown');
    const rejected = mailSender({ row: settings, door, binding: provider(coded('html is required.', REJECTED)), provider: 'resend' });
    const answer = await rejected.sendMail(null, { to: 'third@example.com', subject: 's', text: 'hi' });
    assert.deepEqual([answer.sent, answer.unknown], [false, undefined], 'a request the sending seam refused before any provider was asked is a refusal');
  });

  it('two sends racing for the last slot: one is admitted, the other limited, before either provider answers', async () => {
    const { door, settings } = await senderWith();
    const address = 'recipient-quota@example.test';
    const first = mailSender({ row: settings, door, binding: provider(), provider: 'resend' });
    for (let i = 0; i < most(settings, 'message') - 1; i += 1) await first.sendMail(null, { to: address, subject: `${i}`, text: 'hi' });
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const slow = { sends: 0, send: async () => { slow.sends += 1; await wait; return { messageId: 'last' }; } };
    const racing = mailSender({ row: settings, door, binding: slow, provider: 'resend' });
    const one = racing.sendMail(null, { to: address, subject: 'one', text: 'hi' });
    const two = racing.sendMail(null, { to: address, subject: 'two', text: 'hi' });
    const settled = await Promise.race([two, one.then(() => null)]);
    assert.equal(settled?.limited ?? (await two).limited, true);
    release();
    assert.equal((await one).sent, true);
    assert.equal(slow.sends, 1);
  });

  it('the sender comes from the mail row alone, and an account with none sends nothing', async () => {
    const { sender, binding, settings } = await senderWith();
    await sender.sendMail({ from: { email: 'user-76664ba3@example.com', name: 'Someone' } }, { to: 'a@example.com', from: 'Else <else@example.com>', subject: 's', text: 'hi' });
    assert.deepEqual(binding.sends[0].from, settings.from);
    const none = await senderWith(settingsWith({ from: null }));
    const answer = await none.sender.sendMail(null, { to: 'a@example.com', subject: 's', text: 'hi' });
    assert.deepEqual([answer.sent, answer.error, none.binding.sends.length], [false, SHIPPED.no_sender, 0]);
  });

  it('a written email goes from the owner\'s own sender row, BCCs the owner once, and answers what the provider was given', async () => {
    const settings = settingsWith({ senders: { rows: [{ owner: 'Owner@example.com', from: { email: 'owner-mail@example.com', name: 'Owner Mail' } }] } });
    const { sender, binding } = await senderWith(settings);
    const own = await sender.sendWrittenEmail({ to: 'reader@example.test', subject: 'Hello', markdown: 'Hi.' });
    assert.deepEqual(binding.sends[0].from, { email: 'owner-mail@example.com', name: 'Owner Mail' });
    assert.deepEqual(binding.sends[0].bcc, ['owner@example.com']);
    assert.equal(own.said, 'Emailed reader@example.test from owner-mail@example.com.');
    assert.deepEqual([own.sent_copy.from, own.sent_copy.bcc, own.sent_copy.markdown], ['Owner Mail <owner-mail@example.com>', ['owner@example.com'], 'Hi.']);
    await sender.sendWrittenEmail({ to: 'owner@example.com', subject: 'To myself', markdown: 'Hi.' });
    assert.equal(binding.sends[1].bcc, undefined, 'never twice to the same person');
    const other = await sender.sendWrittenEmail({ to: 'reader@example.test', subject: 'Hello again', markdown: 'Hi.' }, { owner: 'someone-else@example.test' });
    assert.deepEqual([binding.sends[2].from, other.sent], [settings.from, true], 'an owner with no row sends from the one sender');
    await assert.rejects(sender.sendWrittenEmail({ to: 'not an address', subject: 's', markdown: 'm' }), /is not an email address/);
    await assert.rejects(sender.sendWrittenEmail({ to: 'reader@example.test', subject: 's', markdown: ' ' }), /needs its words/);
  });

  it('subscription email keeps its one-click headers and visible consent footer, and bad ones fail before delivery', async () => {
    const { sender, binding } = await senderWith(settingsWith({ postal_address: '1 Example Street, Example City' }));
    const answer = await sender.sendWrittenEmail({ to: 'reader@example.test', subject: 'Issue 1', markdown: 'News.',
      subscription: { unsubscribe_url: 'https://example.com/unsubscribe?t=abc', list_id: 'News <news.example.com>', reason: 'You signed up for the news.' } });
    assert.equal(answer.sent, true);
    assert.deepEqual(binding.sends[0].headers, { 'List-Unsubscribe': '<https://example.com/unsubscribe?t=abc>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'List-ID': 'News <news.example.com>' });
    for (const words of ['You signed up for the news.', 'Example, 1 Example Street, Example City', 'Unsubscribe']) assert.ok(binding.sends[0].text.includes(words), words);
    assert.match(binding.sends[0].html, /example\.com\/unsubscribe\?t=abc/);
    await assert.rejects(sender.sendWrittenEmail({ to: 'reader@example.test', subject: 'Issue 2', markdown: 'News.',
      subscription: { unsubscribe_url: 'http://example.com/u', list_id: 'News <news.example.com>', reason: 'r' } }), /HTTPS one-click/);
    const noAddress = await senderWith();
    await assert.rejects(noAddress.sender.sendWrittenEmail({ to: 'reader@example.test', subject: 'Issue 3', markdown: 'News.',
      subscription: { unsubscribe_url: 'https://example.com/u', list_id: 'News <news.example.com>', reason: 'r' } }), /postal address/);
    assert.equal(binding.sends.length, 1);
  });
});

describe('the mail row and the email rows', () => {
  it('the account\'s mail row is copied from the shipped row once and then only the account\'s own is read', async () => {
    const { door, fake } = await doorFor();
    assert.deepEqual(await mailSettings(door), SHIPPED);
    const changed = { ...SHIPPED, from: { email: 'hello@example.com', name: 'Example' } };
    await door.write([{ id: SETTINGS_ID, type: SETTINGS, value: changed }], { key: 'edit' });
    assert.deepEqual(await mailSettings(door), changed, 'the owner\'s edit is what is read');
    assert.equal([...fake.kept.values()].filter(record => record.type === SETTINGS).length, 1);
  });

  it('each email row runs the mail rules with the records it needs and its keys after the door\'s descriptor', () => {
    for (const id of ['tool:send-an-email']) {
      const row = rowOf(rows, id);
      assert.equal(row.invoke.argv[1], '/opt/send-messages/do-work/mail-sender.mjs', id);
      assert.deepEqual(row.invoke.records.rights.filter(right => right.kind !== '@own-records').map(right => right.kind).sort(), ['mail-day', 'mail-sent', 'mail-settings'], id);
      // The worn look every email is drawn in is read with exactly the rights tool:read-current-worn-look holds.
      assert.deepEqual(row.invoke.records.rights.filter(right => right.kind === '@own-records'), rowOf(lookRows, 'tool:read-current-worn-look').invoke.records.rights, id);
      assert.equal(row.invoke.records.fd, 3, id);
      assert.ok(row.invoke.credential_mounts.every(mount => mount.fd >= 4), id);
      assert.equal(row.input_schema.properties.from, undefined, `${id}: the request never chooses the sender`);
    }
  });

  it('a provider\'s own error name decides refused or unknown, and each recipient is answered on its own', async () => {
    const { door } = await doorFor();
    const settings = settingsWith();
    const run = async (row, input) => ({ code: 1, stdout: JSON.stringify({ sent: input.recipients.map(recipient => (recipient.startsWith('bad')
      ? { recipient, error: 'Resend 422 validation_error: The to field is invalid.' }
      : { recipient, error: 'Resend 500 application_error: Something went wrong.' })) }), stderr: '' });
    const binding = bindingFor(providerOf('resend'), { RESEND_API_KEY: 'test-key' }, settings, { run });
    const sender = mailSender({ row: settings, door, binding, provider: 'resend' });
    const answer = await sendAnEmail({ recipients: ['bad@example.com', 'lost@example.com'], subject: 'Hi', text: 'hi', html: '<p>hi</p>' }, { provider: 'resend', sender });
    assert.deepEqual(answer.sent.map(item => [item.recipient, Boolean(item.unknown)]), [['bad@example.com', false], ['lost@example.com', true]]);
    assert.match(answer.said, /Sent to 0 of 2/);
  });
});

describe('every email is drawn in the look (older owner: test/mail-sender.test.mjs)', () => {
  // A dark look, as a worn look's palette carries it (synthetic values).
  const dark = { '--bg-primary': '#000000', '--bg-surface': '#111111', '--text-primary': '#f5f5f5', '--accent-primary': '#ff3b3b',
    '--text-tertiary': 'rgba(245, 245, 245, 0.7)', '--border-secondary': 'rgba(245, 245, 245, 0.2)', '--button-primary-bg': '#ff3b3b',
    '--button-primary-text': '#ffffff', '--font-primary': 'system-ui, sans-serif', '--font-display': 'Georgia, serif',
    '--font-mono': 'ui-monospace, monospace', '--radius-control': '10px', '--radius-card': '14px', '--radius-pill': '999px',
    '--button-sheen': 'linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(0, 0, 0, 0.1))',
    '--button-highlight': 'inset 0 0 0 1px rgba(0, 0, 0, 0.22)', '--button-shadow': '0 1px 1px rgba(0, 0, 0, 0.3)' };
  const marked = settingsWith({ brand: { name: 'Example', image: 'https://example.com/brand/wordmark.png' },
    made_with: { label: 'Made with', href: 'https://example.com/', image: 'https://example.com/brand/wordmark.png', alt: 'Example' } });

  it('the sent email uses the worn dark look, shared button depth and Made with wordmark', async () => {
    const { sender, binding } = await senderWith(marked, provider(), async () => ({ palette: dark }));
    const result = await sender.sendWrittenEmail({ to: 'dark-proof@example.org', subject: 'Worn look', markdown: 'A message.', action: { label: 'Open', href: 'https://example.com/' } });
    assert.equal(result.sent, true);
    const [sent] = binding.sends;
    assert.match(sent.html, /background:#000000/);
    assert.match(sent.html, /name="color-scheme" content="dark"/);
    assert.match(sent.html, /background-image:linear-gradient/);
    assert.match(sent.html, /Made with/);
    assert.match(sent.html, /brand\/wordmark\.png/);
  });

  it('an email whose brand cannot be read is not sent in other colours, and one sent before any brand is published is drawn in the shipped brand', async () => {
    const unread = await senderWith(marked, provider(), async () => { throw new Error('the look owner is busy'); });
    const refused = await unread.sender.sendWrittenEmail({ to: 'brand-proof@example.org', subject: 'Brand', markdown: 'A message.' });
    assert.equal(refused.sent, false);
    assert.match(refused.error, /could not be read, so it was not sent/);
    assert.equal(unread.binding.sends.length, 0, 'nothing went out in colours other than the look\'s');
    const early = await senderWith(marked, provider(), async () => null);
    const sent = await early.sender.sendWrittenEmail({ to: 'brand-proof@example.org', subject: 'Brand', markdown: 'A message.' });
    assert.equal(sent.sent, true, 'no email waits for the first publication');
    assert.match(early.binding.sends[0].html, /background:#f4f0e8/, 'drawn in the shipped look');
  });

  it('an email draws every kind of block the markdown reader makes, rules and code included', async () => {
    const { sender, binding } = await senderWith(marked);
    const markdown = '## Heading\n\nWords with **bold**.\n\n- one\n- two\n\n1. first\n\n> a quote\n\n---\n\n```\ncode line\n```\n\nThe end.';
    const result = await sender.sendWrittenEmail({ to: 'a@example.org', subject: 's', markdown });
    assert.equal(result.sent, true);
    assert.match(binding.sends[0].html, /<hr style=/);
    assert.match(binding.sends[0].html, /<pre style="[^"]*">code line<\/pre>/);
    assert.match(binding.sends[0].text, /---/);
  });

  it('a sign-in code given as plain words reaches the provider drawn, with its words as text', async () => {
    const { sender, binding } = await senderWith(marked);
    const result = await sender.sendMail(null, { kind: 'sign-in-code', to: 'code-proof@example.org', subject: 'Your sign-in code', text: 'Your sign-in code is 123456\n\nType it within 10 minutes.', idempotencyKey: 'k1' });
    assert.equal(result.sent, true);
    const [sent] = binding.sends;
    assert.match(sent.html, /^<!doctype html>/);
    assert.match(sent.html, /Your sign-in code is 123456/);
    assert.match(sent.text, /Your sign-in code is 123456/);
    assert.equal(sent.idempotencyKey, 'k1');
    assert.equal(sent.markdown, undefined, 'the provider is given the drawn email, not its markdown');
  });

  it('a caller\'s own html goes as it is', async () => {
    const { sender, binding } = await senderWith(marked);
    await sender.sendMail(null, { to: 'own@example.org', subject: 'Own', html: '<p>Own</p>', text: 'Own' });
    assert.equal(binding.sends[0].html, '<p>Own</p>');
    assert.equal(binding.sends[0].text, 'Own');
  });
});
