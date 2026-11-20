import test from 'node:test';
import assert from 'node:assert/strict';
import { contractLinkRequest, isPricedDeal, linkRouteOf, linkWordsOf, recordLinkRequest, scopeOfPerson } from '../read-data/send-deal-to-a-list.mjs';

test('a person gets an email scope, else a phone scope, else a public one', () => {
  assert.deepEqual(scopeOfPerson({ email: 'ana@example.test', phone: '+15550100' }), { kind: 'email', value: 'ana@example.test' });
  assert.deepEqual(scopeOfPerson({ phone: '+15550100' }), { kind: 'phone', value: '+15550100' });
  assert.deepEqual(scopeOfPerson({}), { kind: 'public' });
});

test('the words are the note or else the title, then the link on its own line', () => {
  assert.equal(linkWordsOf({ note: 'Hello', title: 'Deal' }, 'https://example.test/s/1'), 'Hello\nhttps://example.test/s/1');
  assert.equal(linkWordsOf({ title: 'Deal' }, 'https://example.test/s/1'), 'Deal\nhttps://example.test/s/1');
  assert.equal(linkWordsOf({ note: '', title: 'Deal' }, 'https://example.test/s/1'), 'https://example.test/s/1', 'an empty note is kept as the note, so only the link is left');
});

test('a sales contract record takes the contract road, anything else the record share road', () => {
  assert.equal(linkRouteOf('sales-contract:a1'), 'sales-contract');
  assert.equal(linkRouteOf('note:n1'), 'record-share');
});

test('a free contract is not priced, a contract that asks for money is, and other records never are', () => {
  const isFree = contract => contract.free === true;
  assert.equal(isPricedDeal({ record: 'sales-contract:a1', contract: { free: true }, isFree }), false);
  assert.equal(isPricedDeal({ record: 'sales-contract:a1', contract: { free: false }, isFree }), true);
  assert.equal(isPricedDeal({ record: 'note:n1', contract: { free: false }, isFree }), false);
});

test('a contract link carries the arm price only when a price test sent it', () => {
  const person = { email: 'ana@example.test' };
  assert.deepEqual(contractLinkRequest({ send: { record: 'sales-contract:a1' }, person, arm: { arm: 'b', amount_cents: 4900 } }),
    { contract_id: 'sales-contract:a1', scope: { kind: 'email', value: 'ana@example.test' }, amount_cents: 4900 });
  assert.deepEqual(contractLinkRequest({ send: { record: 'sales-contract:a1' }, person, arm: null }),
    { contract_id: 'sales-contract:a1', scope: { kind: 'email', value: 'ana@example.test' } });
});

test('a record link takes the send end time and permissions only when it has them', () => {
  const person = {};
  assert.deepEqual(recordLinkRequest({ send: { record: 'note:n1', until: '2026-12-01T00:00:00Z', can: ['view'] }, person, origin: 'https://example.test' }).options,
    { scope: { kind: 'public' }, origin: 'https://example.test', expires_at: '2026-12-01T00:00:00Z', can: ['view'] });
  assert.deepEqual(recordLinkRequest({ send: { record: 'note:n1' }, person, origin: 'https://example.test' }).options,
    { scope: { kind: 'public' }, origin: 'https://example.test' });
});
