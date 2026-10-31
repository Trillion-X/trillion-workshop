// tools/paid-access/test/private-object-lease.test.ts
//
// Gauntlet for the private-material lease contract. Proves the fail-CLOSED
// ordering, the SP7 account binding, the SP2 expiry, and that the canonicalizer
// is deterministic + order-independent (so mint and verify always agree).

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  canonicalLeaseBytes,
  checkLease,
  decidePrivateDelivery,
  type PrivateDeliveryInputs,
  type PrivateMaterialLease,
} from '../read-data/private-object-lease.ts';

const BOOK_REF = 'access:course-a';

function baseInputs(over: Partial<PrivateDeliveryInputs> = {}): PrivateDeliveryInputs {
  return {
    catalogLoaded: true,
    grantedAccessRefs: [BOOK_REF],
    governingItem: { content_ref: 'content:course-a', required_access_refs: [BOOK_REF] },
    objectKey: 'chapter-one.pdf',
    objectStoreRef: 'object-store:paid-files',
    casHash: 'cas:abc123',
    subject: 'account-buyer-1',
    nowSeconds: 1_000_000,
    ttlSeconds: 3600,
    ...over,
  };
}

describe('decidePrivateDelivery — fail-closed ordering', () => {
  it('grants an entitled, account-bound request with admitted bytes', () => {
    const d = decidePrivateDelivery(baseInputs());
    expect(d.status).toBe('grant');
    if (d.status !== 'grant') throw new Error('unreachable');
    expect(d.lease.kind).toBe('private-material-lease');
    expect(d.lease.subject).toBe('account-buyer-1');
    expect(d.lease.cas_hash).toBe('cas:abc123');
    expect(d.lease.required_access_refs).toEqual([BOOK_REF]);
    expect(d.lease.issued_at).toBe(1_000_000);
    expect(d.lease.expires_at).toBe(1_003_600);
  });

  it('returns loading BEFORE checking entitlement when catalog has not loaded', () => {
    // Even with everything else present, an unloaded catalog must never grant —
    // and must not fall through to a fail-open "ungoverned" path.
    const d = decidePrivateDelivery(baseInputs({ catalogLoaded: false, governingItem: undefined }));
    expect(d.status).toBe('loading');
  });

  it('fails CLOSED (unavailable) when the governing item is missing in a loaded catalog', () => {
    const d = decidePrivateDelivery(baseInputs({ governingItem: undefined }));
    expect(d).toEqual({ status: 'unavailable', reason: 'governing-item-missing' });
  });

  it('denies a viewer who lacks the required access ref', () => {
    const d = decidePrivateDelivery(baseInputs({ grantedAccessRefs: [] }));
    expect(d).toEqual({ status: 'denied', reason: 'not-entitled' });
  });

  it('denies an anonymous (empty subject) request even if entitled', () => {
    // Anonymous cannot be granted product access in the first place, but guard
    // the binding explicitly: a lease with no subject cannot be bound (SP7).
    const d = decidePrivateDelivery(baseInputs({ subject: '' }));
    expect(d).toEqual({ status: 'denied', reason: 'anonymous' });
  });

  it('reports unavailable (not a false grant) when bytes are not admitted to CAS yet', () => {
    const d = decidePrivateDelivery(baseInputs({ casHash: undefined }));
    expect(d).toEqual({ status: 'unavailable', reason: 'no-bytes' });
  });

  it('rejects a non-positive or non-finite ttl', () => {
    expect(decidePrivateDelivery(baseInputs({ ttlSeconds: 0 }))).toEqual({ status: 'unavailable', reason: 'bad-ttl' });
    expect(decidePrivateDelivery(baseInputs({ ttlSeconds: -5 }))).toEqual({ status: 'unavailable', reason: 'bad-ttl' });
    expect(decidePrivateDelivery(baseInputs({ ttlSeconds: Number.NaN }))).toEqual({ status: 'unavailable', reason: 'bad-ttl' });
  });

  it('floors fractional now/ttl into integer epoch seconds', () => {
    const d = decidePrivateDelivery(baseInputs({ nowSeconds: 1_000_000.9, ttlSeconds: 3600.9 }));
    if (d.status !== 'grant') throw new Error('expected grant');
    expect(d.lease.issued_at).toBe(1_000_000);
    expect(d.lease.expires_at).toBe(1_003_600);
  });

  it('dedupes and sorts required refs deterministically', () => {
    const d = decidePrivateDelivery(baseInputs({
      grantedAccessRefs: ['z', 'a'],
      governingItem: { required_access_refs: ['z', 'a', 'a'] },
    }));
    if (d.status !== 'grant') throw new Error('expected grant');
    expect(d.lease.required_access_refs).toEqual(['a', 'z']);
  });
});

describe('canonicalLeaseBytes — deterministic SP4 canonical form', () => {
  const lease: PrivateMaterialLease = {
    kind: 'private-material-lease',
    object_key: 'k', object_store_ref: 's', cas_hash: 'h', subject: 'acct',
    required_access_refs: ['a', 'z'], issued_at: 1, expires_at: 2,
  };

  it('is independent of source key insertion order', () => {
    const shuffled: PrivateMaterialLease = {
      expires_at: 2, subject: 'acct', kind: 'private-material-lease', cas_hash: 'h',
      issued_at: 1, object_store_ref: 's', required_access_refs: ['a', 'z'], object_key: 'k',
    } as PrivateMaterialLease;
    expect(canonicalLeaseBytes(shuffled)).toBe(canonicalLeaseBytes(lease));
  });

  it('round-trips a minted lease byte-identically (mint side == verify side)', () => {
    const d = decidePrivateDelivery(baseInputs());
    if (d.status !== 'grant') throw new Error('expected grant');
    const reparsed = JSON.parse(canonicalLeaseBytes(d.lease)) as PrivateMaterialLease;
    expect(canonicalLeaseBytes(reparsed)).toBe(canonicalLeaseBytes(d.lease));
  });
});

describe('checkLease — structural + temporal + SP7 binding (shell mirror)', () => {
  const good: PrivateMaterialLease = {
    kind: 'private-material-lease',
    object_key: 'k', object_store_ref: 's', cas_hash: 'h', subject: 'acct',
    required_access_refs: [BOOK_REF], issued_at: 100, expires_at: 200,
  };

  it('accepts a valid, unexpired, correctly-bound lease', () => {
    expect(checkLease(good, 150, 'acct')).toBe('valid');
  });

  it('rejects an expired lease (now >= expires_at)', () => {
    expect(checkLease(good, 200, 'acct')).toBe('expired');
    expect(checkLease(good, 999, 'acct')).toBe('expired');
  });

  it('rejects a lease presented by a different account (SP7)', () => {
    expect(checkLease(good, 150, 'someone-else')).toBe('subject-mismatch');
  });

  it('rejects malformed / non-lease / inverted-window inputs', () => {
    expect(checkLease(null, 150, 'acct')).toBe('malformed');
    expect(checkLease({ ...good, kind: 'nope' as never }, 150, 'acct')).toBe('malformed');
    expect(checkLease({ ...good, cas_hash: '' }, 150, 'acct')).toBe('malformed');
    expect(checkLease({ ...good, subject: '' }, 150, 'acct')).toBe('malformed');
    expect(checkLease({ ...good, expires_at: 100 }, 150, 'acct')).toBe('malformed');
  });
});
