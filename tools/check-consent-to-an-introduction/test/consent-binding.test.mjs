// An approval bound to the exact action (src/consent-fingerprint.mjs `action`): a yes holds only while the tool, its
// version and its input are the ones the person was shown. An ask that carries no action keeps exactly its old consent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionBinding, consentOf, changedSince, refuseChangedConsent } from '../src/consent-fingerprint.mjs';

const base = { text: { why: ['Pay the invoice'] }, recipients: [{ relay: 'ben' }], shared: [], expires_at: '2026-10-21T00:00:00.000Z' };
const action = { tool_id: 'tool:send', tool_version: '1f:aaa', input: { to: 'a' } };

test('an ask without an action keeps its four-part consent; with one, a changed tool version or input needs a fresh yes', () => {
  assert.equal(consentOf(base).split('.').length, 4);
  assert.match(actionBinding(action), /^[0-9a-f]{64}$/, 'BLAKE3 hex');
  const shown = { ...base, action: actionBinding(action) };
  const given = consentOf(shown);
  assert.deepEqual(changedSince(given, shown), []);
  assert.deepEqual(changedSince(given, { ...shown, action: actionBinding({ ...action, tool_version: '1f:bbb' }) }), ['action']);
  assert.deepEqual(changedSince(given, { ...shown, action: actionBinding({ ...action, input: { to: 'b' } }) }), ['action']);
  assert.deepEqual(changedSince(given, base), ['action'], 'an action dropped is a change');
  assert.deepEqual(changedSince(consentOf(base), shown), ['action'], 'an action added is a change');
  assert.throws(() => refuseChangedConsent(given, { ...shown, action: actionBinding({ ...action, input: { to: 'c' } }) }, 'changed'), error => error.status === 409 && error.changed.join() === 'action');
});
