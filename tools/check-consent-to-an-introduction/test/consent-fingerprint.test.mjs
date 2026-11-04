import test from 'node:test';
import assert from 'node:assert/strict';
import { consentOf, changedSince, refuseChangedConsent } from '../src/consent-fingerprint.mjs';

const shown = { text: { why: ['Both run seed rounds'] }, recipients: [{ relay: 'ben', name: 'Ben' }], shared: ['contact'], expires_at: '2026-10-21T00:00:00.000Z' };

test('the same introduction gives the same consent, whatever order its keys were written in', () => {
  const again = { expires_at: shown.expires_at, shared: ['contact'], recipients: [{ name: 'Ben', relay: 'ben' }], text: { why: ['Both run seed rounds'] } };
  assert.equal(consentOf(again), consentOf(shown));
  assert.deepEqual(changedSince(consentOf(shown), shown), []);
});

test('a change to the words, the people, what is shared or the answer time each names that field', () => {
  const given = consentOf(shown);
  for (const [field, value] of [['text', { why: ['Both hire engineers'] }], ['recipients', [{ relay: 'cy', name: 'Cy' }]], ['shared', ['contact', 'phone']], ['expires_at', '2026-10-22T00:00:00.000Z']]) {
    const now = { ...shown, [field]: value };
    assert.deepEqual(changedSince(given, now), [field], field);
    assert.throws(() => refuseChangedConsent(given, now, 'This introduction changed. Look at it again.'), error => error.status === 409 && error.message === 'This introduction changed. Look at it again.' && error.changed.join() === field && error.consent === consentOf(now), field);
  }
});

test('a missing or malformed consent names every field, and a current one passes', () => {
  assert.deepEqual(changedSince(undefined, shown), ['text', 'recipients', 'shared', 'expires_at']);
  assert.deepEqual(changedSince('not-a-consent', shown), ['text', 'recipients', 'shared', 'expires_at']);
  assert.throws(() => refuseChangedConsent(undefined, shown, 'changed'), error => error.status === 409 && error.changed.length === 4);
  assert.equal(refuseChangedConsent(consentOf(shown), shown, 'changed'), undefined);
});

test('a consent is BLAKE3 identities, one per field', () => {
  const parts = consentOf(shown).split('.');
  assert.equal(parts.length, 4);
  for (const part of parts) assert.match(part, /^[0-9a-f]{32}$/);
});
