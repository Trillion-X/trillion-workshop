import test from 'node:test';
import assert from 'node:assert/strict';
import { offerFailureAction, privateLinkRequest } from '../read-data/private-link-for-one-person.mjs';

test('a link for one email address is scoped to that address', () => {
  assert.deepEqual(privateLinkRequest({ contractId: 'sales-contract:a', to: 'ana@example.test', origin: 'https://app.example.test', free: false }), {
    record: 'sales-contract:a',
    options: { scope: { kind: 'email', value: 'ana@example.test' }, expires_at: null, origin: 'https://app.example.test' },
  });
});

test('with no address the given scope is used, and an end time is kept when there is one', () => {
  const request = privateLinkRequest({ contractId: 'sales-contract:a', scope: { kind: 'phone', value: '+15550100' }, expiresAt: '2026-12-01T00:00:00Z', origin: 'https://x.example.test', free: false });
  assert.deepEqual(request.options.scope, { kind: 'phone', value: '+15550100' });
  assert.equal(request.options.expires_at, '2026-12-01T00:00:00Z');
  assert.equal('can' in request.options, false);
});

test('a free deal lets the person view and sign', () => {
  assert.deepEqual(privateLinkRequest({ contractId: 'sales-contract:a', to: 'ana@example.test', origin: 'https://x.example.test', free: true }).options.can, ['view', 'sign']);
});

test('a priced link is revoked when its offer fails, kept when it does not, and a free link is never revoked', () => {
  assert.equal(offerFailureAction({ free: false, offerFailed: true }), 'revoke');
  assert.equal(offerFailureAction({ free: false, offerFailed: false }), 'keep');
  assert.equal(offerFailureAction({ free: true, offerFailed: true }), 'none');
});
