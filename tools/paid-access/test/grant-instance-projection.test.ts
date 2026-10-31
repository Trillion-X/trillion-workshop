import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { grantedAccessProjectionFromEffects, grantedAccessRefsFromEffects } from '../read-data/read-granted-access-refs.ts';

function licenseEffect(ref: string, extraMaterial: Record<string, unknown> = {}) {
  return {
    kind: 'license_access',
    object: ref,
    subject: 'account:abc',
    material: { capability_ref: ref, access_granted: true, ...extraMaterial },
  };
}

function terminalEffect(grantRef: string, kind: 'revoke' | 'refund' | 'supersede', revokesGrantRef = grantRef) {
  return {
    kind: 'license_access',
    material: {
      grant_ref: grantRef,
      revokes_grant_ref: revokesGrantRef,
      terminal: { kind },
    },
  };
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, candidateIndex) => candidateIndex !== index)).map((tail) => [value, ...tail]));
}

describe('grantedAccessRefsFromEffects', () => {
  it('extracts, sorts, and dedupes legacy license_access effects', () => {
    const reply = {
      effects: [
        licenseEffect('product-access:sourdough-class'),
        licenseEffect('product-access:bread-basics'),
        licenseEffect('product-access:sourdough-class'),
      ],
    };
    expect(grantedAccessRefsFromEffects(reply)).toEqual([
      'product-access:bread-basics',
      'product-access:sourdough-class',
    ]);
  });

  it('ignores non-grant effects and falls back to material capability refs', () => {
    const reply = {
      effects: [
        { kind: 'account_plan', object: 'plan:full', material: {} },
        { kind: 'quote_reservation', object: 'quote:1', material: {} },
        { kind: 'license_access', material: { capability_ref: 'product-access:z', access_granted: true } },
      ],
    };
    expect(grantedAccessRefsFromEffects(reply)).toEqual(['product-access:z']);
  });

  it('keeps paid and reward instances independent when either grant_ref is revoked', () => {
    const accessRef = 'access:bakery';
    const paid = licenseEffect(accessRef, { grant_ref: 'grant:paid' });
    const reward = licenseEffect(accessRef, { grant_ref: 'grant:reward' });

    expect(grantedAccessRefsFromEffects([paid, reward, licenseEffect(accessRef, {
      access_granted: false,
      grant_ref: 'grant:reward',
    })])).toEqual([accessRef]);
    expect(grantedAccessRefsFromEffects([paid, reward, licenseEffect(accessRef, {
      access_granted: false,
      grant_ref: 'grant:paid',
    })])).toEqual([accessRef]);
    expect(grantedAccessRefsFromEffects([
      paid,
      reward,
      terminalEffect('terminal:reward', 'refund', 'grant:reward'),
      terminalEffect('terminal:paid', 'revoke', 'grant:paid'),
    ])).toEqual([]);
  });

  it('ignores unrelated effect kinds even when their metadata resembles a revocation', () => {
    const access = 'access:shared';
    expect(grantedAccessRefsFromEffects([
      licenseEffect(access),
      { kind: 'account_plan', object: access, material: { access_granted: false } },
    ])).toEqual([access]);
    expect(grantedAccessRefsFromEffects([
      licenseEffect(access, { grant_ref: 'grant:one' }),
      { kind: 'account_plan', object: access, material: {
        terminal: { kind: 'refund', revokes_grant_ref: 'grant:one' },
      } },
    ])).toEqual([access]);
  });

  it('honors inclusive valid_from and exclusive expires_at boundaries', () => {
    const expiring = licenseEffect('product-access:week', {
      grant_ref: 'grant:week',
      valid_from_ms: 100,
      expires_at_ms: 200,
    });
    expect(grantedAccessRefsFromEffects([expiring], 99)).toEqual([]);
    expect(grantedAccessRefsFromEffects([expiring], 100)).toEqual(['product-access:week']);
    expect(grantedAccessRefsFromEffects([expiring], 199)).toEqual(['product-access:week']);
    expect(grantedAccessRefsFromEffects([expiring], 200)).toEqual([]);
  });

  it('fails closed for missing, invalid, non-finite, or inverted expiring times', () => {
    const ref = 'product-access:invalid-time';
    const cases = [
      licenseEffect(ref, { grant_ref: 'missing-start', expires_at_ms: 200 }),
      licenseEffect(ref, { grant_ref: 'string-expiry', valid_from_ms: 100, expires_at_ms: '200' }),
      licenseEffect(ref, { grant_ref: 'nan-expiry', valid_from_ms: 100, expires_at_ms: Number.NaN }),
      licenseEffect(ref, { grant_ref: 'infinite-expiry', valid_from_ms: 100, expires_at_ms: Infinity }),
      licenseEffect(ref, { grant_ref: 'inverted-window', valid_from_ms: 200, expires_at_ms: 100 }),
      licenseEffect(ref, { grant_ref: 'negative-start', valid_from_ms: -1, expires_at_ms: 200 }),
      licenseEffect(ref, { grant_ref: 'fractional-end', valid_from_ms: 100, expires_at_ms: 200.5 }),
      licenseEffect(ref, { grant_ref: 'future-start', valid_from_ms: 300, expires_at_ms: 400 }),
    ];
    for (const effect of cases) expect(grantedAccessRefsFromEffects([effect], 150)).toEqual([]);

    const otherwiseValid = licenseEffect(ref, { grant_ref: 'bad-now', valid_from_ms: 100, expires_at_ms: 200 });
    expect(grantedAccessRefsFromEffects([otherwiseValid], Number.NaN)).toEqual([]);
    expect(grantedAccessRefsFromEffects([otherwiseValid], Infinity)).toEqual([]);
    expect(grantedAccessRefsFromEffects([otherwiseValid], '150')).toEqual([]);
  });

  it('fails closed when valid_from_ms lacks expires_at_ms while preserving legacy grants', () => {
    const missingExpiry = licenseEffect('product-access:missing-expiry', {
      grant_ref: 'grant:missing-expiry',
      valid_from_ms: 100,
    });
    for (const now_ms of [undefined, Number.NaN, 0, 100, 200]) {
      expect(grantedAccessRefsFromEffects([missingExpiry], now_ms)).toEqual([]);
    }

    const legacy = licenseEffect('product-access:legacy');
    expect(grantedAccessRefsFromEffects([legacy], Number.NaN)).toEqual(['product-access:legacy']);
  });

  it('folds grant, revoke, and supersede events order-independently', () => {
    const accessRef = 'product-access:ordered';
    const events = [
      licenseEffect(accessRef, { grant_ref: 'grant:old' }),
      terminalEffect('terminal:old', 'supersede', 'grant:old'),
      licenseEffect(accessRef, { grant_ref: 'grant:new' }),
      terminalEffect('terminal:new', 'revoke', 'grant:new'),
    ];
    const projections = permutations(events).map((effects) => grantedAccessProjectionFromEffects(effects, 150));
    expect(new Set(projections.map((projection) => JSON.stringify(projection)))).toEqual(new Set([JSON.stringify(projections[0])]));
    expect(projections[0].granted_access_refs).toEqual([]);
  });

  it('keeps legacy no-expiry grants held and legacy revokes scoped to their fallback instance', () => {
    const held = licenseEffect('product-access:legacy');
    expect(grantedAccessRefsFromEffects([held], Number.NaN)).toEqual(['product-access:legacy']);
    expect(grantedAccessRefsFromEffects([
      held,
      licenseEffect('product-access:legacy', { access_granted: false }),
      licenseEffect('product-access:other'),
    ])).toEqual(['product-access:other']);
  });

  it('accepts bare arrays and empty or missing sources', () => {
    expect(grantedAccessRefsFromEffects([licenseEffect('product-access:a')])).toEqual(['product-access:a']);
    expect(grantedAccessRefsFromEffects(null)).toEqual([]);
    expect(grantedAccessRefsFromEffects({ effects: [] })).toEqual([]);
  });

  it('rejects conflicting versions of one grant and records membership changes even when access remains', () => {
    const first = licenseEffect('access:shared', { grant_ref: 'grant:first' });
    const second = licenseEffect('access:shared', { grant_ref: 'grant:second' });
    const before = grantedAccessProjectionFromEffects([first, second]);
    const after = grantedAccessProjectionFromEffects([first, second, terminalEffect('grant:first', 'revoke')]);
    expect(after.granted_access_refs).toEqual(before.granted_access_refs);
    expect(after.membership_revision_input).not.toBe(before.membership_revision_input);
    expect(grantedAccessRefsFromEffects([first, licenseEffect('access:other', { grant_ref: 'grant:first' })])).toEqual([]);
  });
});
