// tools/arrange-screens-in-panes/tests/saved-tabs-account.test.mjs
//
// Two people on one browser never share saved tabs: the host page's signed-in identity keys them, the portal session is only
// the fallback, and a page with neither keeps the shared `anonymous` key it always had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostAccountRef, savedTabsAccountRef, setHostAccountRef } from '../read-data/saved-tabs-account.mjs';

test('the host identity wins over the portal session', () => {
  assert.equal(savedTabsAccountRef('member-a@example.test', 'portal-account'), 'member-a@example.test');
});

test('with no host identity the portal session names the account', () => {
  assert.equal(savedTabsAccountRef(null, 'portal-account'), 'portal-account');
});

test('with neither, the shared anonymous account is used, as before', () => {
  assert.equal(savedTabsAccountRef(null, null), 'anonymous');
});

test('the host identity is set, trimmed, and cleared by an empty value', () => {
  setHostAccountRef('  member-b@example.test ');
  assert.equal(hostAccountRef(), 'member-b@example.test');
  setHostAccountRef('   ');
  assert.equal(hostAccountRef(), null);
  setHostAccountRef(undefined);
  assert.equal(hostAccountRef(), null);
});

test('two members on one page never share a key', () => {
  setHostAccountRef('member-a@example.test');
  const a = savedTabsAccountRef(hostAccountRef(), 'portal-account');
  setHostAccountRef('member-b@example.test');
  const b = savedTabsAccountRef(hostAccountRef(), 'portal-account');
  assert.notEqual(a, b);
  setHostAccountRef(null);
});
