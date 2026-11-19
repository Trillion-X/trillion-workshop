import test from 'node:test';
import assert from 'node:assert/strict';
import { asksNothingNew } from '../do-work/command.mjs';

test('a kept sign-in asked for less than the command asks now, or kept before what it asked was recorded, signs in again', () => {
  const now = 'openid offline_access tools:* secrets:* wake:* grants:offer grants:read-offer';
  assert.equal(asksNothingNew({ asked: now }, now), true, 'asked for all of it: kept');
  assert.equal(asksNothingNew({ asked: `${now} sharing.*` }, now), true, 'asked for more than now: kept');
  assert.equal(asksNothingNew({ asked: 'openid offline_access tools:* secrets:* wake:*' }, now), false, 'a scope added since: signs in again');
  assert.equal(asksNothingNew({ access_token: 'kept before Nov 19' }, now), false, 'nothing recorded: signs in again once');
  assert.equal(asksNothingNew(null, now), false);
});
