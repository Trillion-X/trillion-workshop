import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { grantedAccessRefsFromEffects } from '../read-data/read-granted-access-refs.ts';

// A grant is a license_access effect. A revoke names the grant it ends in material.revokes_grant_ref.
const lasting = { kind: 'license_access', object: 'product-access:lasting', subject: 'account:a', material: { grant_ref: 'g-lasting' } };
const ended = { kind: 'license_access', object: 'product-access:ended', subject: 'account:a', material: { grant_ref: 'g-ended' } };
const endedBy = { kind: 'revoke', subject: 'account:a', material: { revokes_grant_ref: 'g-ended' } };
const timed = { kind: 'license_access', object: 'product-access:timed', subject: 'account:a',
  material: { grant_ref: 'g-timed', valid_from_ms: 0, expires_at_ms: 4102444800000 } };

describe('paid access reads each grant\'s own state, with no clock', () => {
  it('holds a lasting grant that no effect ends', () => {
    expect(grantedAccessRefsFromEffects({ effects: [lasting] })).toEqual(['product-access:lasting']);
  });

  it('does not hold a grant that a later revoke ends', () => {
    expect(grantedAccessRefsFromEffects({ effects: [ended, endedBy, lasting] })).toEqual(['product-access:lasting']);
  });

  it('does not hold a timed grant when no clock is given (fails closed until a tool ends it)', () => {
    expect(grantedAccessRefsFromEffects({ effects: [timed] })).toEqual([]);
  });

  it('still holds the timed grant inside its window when a caller gives a clock (who-holds-access)', () => {
    expect(grantedAccessRefsFromEffects({ effects: [timed] }, 1000)).toEqual(['product-access:timed']);
  });
});
