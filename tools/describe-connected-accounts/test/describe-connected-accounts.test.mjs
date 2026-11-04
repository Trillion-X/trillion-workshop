import test from 'node:test';
import assert from 'node:assert/strict';
import { describeConnectedAccounts } from '../do-work/describe-connected-accounts.mjs';

test('the row tags the earliest of two accounts primary, says its allowed groups and its card words', () => {
  const at = (id, when) => ({ connection_id: id, vendor: 'google', service: 'Google', status: 'connected', connected_at: when, can_send: true, grant_scopes_known: true, grant_scopes: ['https://www.googleapis.com/auth/calendar'] });
  const out = describeConnectedAccounts({ connections: [at('g-new', '2026-10-02'), at('g-old', '2026-09-01')], arriving: { google: ['New mail in a Gmail inbox'] } });
  assert.deepEqual(out.primary, { google: 'g-old' });
  assert.deepEqual(out.accounts.map(account => account.primary), [false, true]);
  assert.equal(out.accounts[0].allowed_groups.find(group => group.label === 'Calendar').allowed, true);
  assert.match(out.accounts[0].words.copied, /Copied as it arrives: New mail in a Gmail inbox/);
  assert.throws(() => describeConnectedAccounts({}), /Give connections/);
});
