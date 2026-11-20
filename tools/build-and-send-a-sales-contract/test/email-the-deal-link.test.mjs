import test from 'node:test';
import assert from 'node:assert/strict';
import { dealEmailRequest, emailedAnswer, sentFields, shareEmailRequest } from '../read-data/email-the-deal-link.mjs';

test('the share email request carries the person, the record, the share and the seller note', () => {
  const request = shareEmailRequest({
    send: { record: 'note:n1', note: 'Here is your link' },
    person: { email: 'ana@example.test', name: 'Ana' },
    shareId: 'share_1',
    origin: 'https://app.example.test',
  });
  assert.deepEqual(request, { to: 'ana@example.test', recipient: 'Ana', record: 'note:n1', share_id: 'share_1', note: 'Here is your link', origin: 'https://app.example.test' });
});

test('a send with no note carries a null note', () => {
  assert.equal(shareEmailRequest({ send: { record: 'note:n1' }, person: { email: 'a@example.test' }, shareId: 's', origin: 'o' }).note, null);
});

test('the answer names the address the email went to', () => {
  assert.deepEqual(emailedAnswer({ sent_to: 'ana@example.test' }), { sent: true, said: 'Emailed to ana@example.test.' });
});

test('a deal with no address is not emailed; with an address it is emailed with its note, else a null note', () => {
  assert.equal(dealEmailRequest({ to: null, origin: 'o', contractId: 'sales-contract:a', shareId: 's' }), null);
  assert.deepEqual(dealEmailRequest({ to: 'ana@example.test', origin: 'o', contractId: 'sales-contract:a', shareId: 's' }),
    { record: 'sales-contract:a', share_id: 's', options: { note: null, origin: 'o' } });
  assert.deepEqual(dealEmailRequest({ to: 'ana@example.test', note: 'Hi', origin: 'o', contractId: 'sales-contract:a', shareId: 's' }).options.note, 'Hi');
});

test('the sent fields are present only when an email went out', () => {
  assert.deepEqual(sentFields({ sent_to: 'ana@example.test', sent_at: '2026-11-10T09:00:00.000Z' }), { sent_to: 'ana@example.test', sent_at: '2026-11-10T09:00:00.000Z' });
  assert.deepEqual(sentFields(null), {});
});
