import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { grantedAccessRefsFromEffects } from '../read-data/read-granted-access-refs.ts';

// Effect shape mirrors signed-event-authority projection of a `capability.access` grant:
// { kind: 'license_access', object: <accessRef>, material: { capability_ref, access_granted } }
function licenseEffect(ref: string, extraMaterial: Record<string, unknown> = {}) {
  return {
    kind: 'license_access',
    object: ref,
    subject: 'account:abc',
    material: { capability_ref: ref, access_granted: true, ...extraMaterial },
  };
}

describe('grantedAccessRefsFromEffects', () => {
  it('extracts refs from license_access effects', () => {
    const reply = {
      effects: [licenseEffect('product-access:bread-basics'), licenseEffect('product-access:sourdough-class')],
    };
    expect(grantedAccessRefsFromEffects(reply).sort()).toEqual([
      'product-access:bread-basics',
      'product-access:sourdough-class',
    ]);
  });

  it('ignores non-grant effects (account_plan, quote_reservation, activation_count)', () => {
    const reply = {
      effects: [
        { kind: 'account_plan', object: 'plan:full', material: {} },
        { kind: 'quote_reservation', object: 'quote:1', material: {} },
        { kind: 'activation_count', material: { active_activation_count: '1' } },
        licenseEffect('product-access:y'),
      ],
    };
    expect(grantedAccessRefsFromEffects(reply)).toEqual(['product-access:y']);
  });

  it('drops effects explicitly marked access_granted false', () => {
    const reply = { effects: [licenseEffect('product-access:revoked', { access_granted: false }), licenseEffect('product-access:live')] };
    expect(grantedAccessRefsFromEffects(reply)).toEqual(['product-access:live']);
  });

  it('REVOCATION COLLAPSES PER REF: grant + negative event for the same ref = NOT held (refund reversal)', () => {
    // the real post-refund effect list: the original grant effect AND the
    // checkout.revoke-hosted negative effect coexist for the same ref
    const reply = { effects: [
      licenseEffect('product-access:refunded'),
      licenseEffect('product-access:refunded', { access_granted: false }),
      licenseEffect('product-access:kept'),
    ] };
    expect(grantedAccessRefsFromEffects(reply)).toEqual(['product-access:kept']);
    // order-independent: negative first, grant second — still revoked
    const reversed = { effects: [
      licenseEffect('product-access:refunded', { access_granted: false }),
      licenseEffect('product-access:refunded'),
    ] };
    expect(grantedAccessRefsFromEffects(reversed)).toEqual([]);
  });

  it('falls back to material.capability_ref when object is absent', () => {
    const reply = { effects: [{ kind: 'license_access', material: { capability_ref: 'product-access:z', access_granted: true } }] };
    expect(grantedAccessRefsFromEffects(reply)).toEqual(['product-access:z']);
  });

  it('dedupes repeated grants', () => {
    const reply = { effects: [licenseEffect('product-access:dup'), licenseEffect('product-access:dup')] };
    expect(grantedAccessRefsFromEffects(reply)).toEqual(['product-access:dup']);
  });

  it('accepts a bare effects array and an empty/missing source', () => {
    expect(grantedAccessRefsFromEffects([licenseEffect('product-access:a')])).toEqual(['product-access:a']);
    expect(grantedAccessRefsFromEffects(null)).toEqual([]);
    expect(grantedAccessRefsFromEffects({ effects: [] })).toEqual([]);
  });
});
