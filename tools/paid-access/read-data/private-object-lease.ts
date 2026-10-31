// tools/paid-access/read-data/private-object-lease.ts
//
// Private-material delivery: the access-checked, time-limited LEASE that turns a private `object_key` into a
// playable or downloadable address only for an entitled account. This is the ONE primitive behind every paid private
// file (a book PDF, an audiobook, a course video, any later file), selected purely by DATA (the file's `paid-file`
// record), never by per-file code. Ported from bitfield-packages packages/material-delivery; the decision, the
// canonical bytes and the lease check are unchanged.
//
// WHY NOT a raw public content address: a paid PDF behind an unguessable-but-PUBLIC hash is an unguarded capability.
// Anyone the address leaks to keeps it for ever, and nothing can stop a download. The correct shape is a TIME-LIMITED
// lease minted AFTER an access check and BOUND to the consuming account: a time-bounded lease, bound to one account,
// with the smallest capability.
//
// SEPARATION OF CONCERNS — this module is PURE (zero I/O, framework-agnostic):
//   - the ENTITLEMENT DECISION is the one rule in ./holds-any-required-access-ref.ts: ANY-of intersection of the
//     buyer's held access refs with the file's `required_access_refs`. It does NOT re-implement the rule.
//   - it produces the LEASE PAYLOAD and the CANONICAL BYTES a signer signs over. Signing and streaming the bytes are
//     the door's (the route a buyer opens); both the mint and the door's check build against THIS contract, so the
//     lease format has exactly one definition.
//
// MACHINE-READABLE (rule: no string-encoded compound values): every field of the
// lease is an explicit typed field. `required_access_refs` is an array, times are
// numeric epoch SECONDS, nothing is packed into a delimited string.

import { holdsAnyRequiredAccessRef } from './holds-any-required-access-ref.ts';

/** The catalog item that governs a private object: carries the access refs the
 *  viewer must hold. An item with no refs is PUBLIC (ungated). The object-store
 *  map is the only producer and it emits `required_access_refs` alone. */
export type PrivateMaterialGoverningItem = {
  content_ref?: string;
  required_access_refs?: string[];
};

/** The signed lease payload — the EXACT object that is canonicalized, signed, and
 *  later re-verified byte-for-byte by the shell route before it streams CAS bytes.
 *  Adding a field here is a deliberate contract change both sides must adopt. */
export type PrivateMaterialLease = {
  /** Schema discriminant — lets the shell reject anything that isn't a lease. */
  kind: 'private-material-lease';
  /** Logical object requested (e.g. "chapter-one.pdf"). Audit + shell resolution key. */
  object_key: string;
  /** Logical object store the key lives in (e.g. "object-store:paid-files").
   *  Backed by CAS in this deployment ("served FROM THE LOG/CAS"). */
  object_store_ref: string;
  /** Content hash the shell actually streams. Resolving object_key -> cas_hash
   *  happens at mint time so the lease itself names the immutable bytes. */
  cas_hash: string;
  /** Account the lease is BOUND to (SP7). The shell SHOULD reject a lease
   *  presented by a different session subject. Never empty (anon cannot hold one). */
  subject: string;
  /** What was checked — recorded for transparency/audit, not re-evaluated by the
   *  shell (the signature is the authority). */
  required_access_refs: string[];
  /** Epoch SECONDS the lease was minted. */
  issued_at: number;
  /** Epoch SECONDS the lease stops being valid (SP2). `> issued_at` always. */
  expires_at: number;
};

export type PrivateDeliveryInputs = {
  /** Whether the account-independent catalog that carries `governingItem` has
   *  loaded. Fail-CLOSED: until it has, the decision is `loading`, never `grant`. */
  catalogLoaded: boolean;
  /** Access refs the requesting account holds (`readAccountGrantedAccessRefs`;
   *  `[]` for an anonymous viewer). */
  grantedAccessRefs: readonly string[];
  /** The catalog item governing the requested object (matched by the caller via
   *  the media's `content_ref`). `undefined` = not found in catalog. */
  governingItem: PrivateMaterialGoverningItem | undefined;
  objectKey: string;
  objectStoreRef: string;
  /** Resolved content hash for the object. Empty/undefined = bytes not admitted
   *  to CAS yet -> `unavailable` (honest, never a false grant). */
  casHash: string | undefined;
  /** Account id the lease binds to. Empty = anonymous -> `denied`. */
  subject: string;
  /** Current time, epoch SECONDS (caller supplies — keeps this fn pure). */
  nowSeconds: number;
  /** Lease lifetime in seconds (from the media record's `delivery_ttl_seconds`). */
  ttlSeconds: number;
};

export type PrivateDeliveryDecision =
  | { status: 'loading' }
  | { status: 'denied'; reason: 'not-entitled' | 'anonymous' }
  | { status: 'unavailable'; reason: 'no-bytes' | 'governing-item-missing' | 'bad-ttl' }
  | { status: 'grant'; lease: PrivateMaterialLease };

/**
 * Decide whether to mint a private-delivery lease — FAIL-CLOSED at every gap.
 * Returns the lease PAYLOAD to sign (the door signs it); it
 * never signs, never does I/O. The ordering matters: catalog-load before
 * entitlement (an unloaded catalog must not look "ungoverned" and fail open).
 */
export function decidePrivateDelivery(input: PrivateDeliveryInputs): PrivateDeliveryDecision {
  if (!input.catalogLoaded) return { status: 'loading' };

  // No governing item in a LOADED catalog: we cannot prove the object is public,
  // and a private object reaching this path is gated by definition -> fail closed.
  if (!input.governingItem) return { status: 'unavailable', reason: 'governing-item-missing' };

  // Authenticate before authorizing: a lease MUST bind to an account (SP7), so a
  // request with no subject is `anonymous` regardless of grants. Checking this
  // BEFORE entitlement also lets callers distinguish "sign in" (anonymous) from
  // "purchase" (signed-in but not entitled) — a real no-session viewer holds no
  // grants, so without this it would mis-read as `not-entitled`.
  if (!input.subject) return { status: 'denied', reason: 'anonymous' };

  if (!holdsAnyRequiredAccessRef(input.grantedAccessRefs, acceptedRefs(input.governingItem))) {
    return { status: 'denied', reason: 'not-entitled' };
  }

  if (!input.casHash) return { status: 'unavailable', reason: 'no-bytes' };

  if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
    return { status: 'unavailable', reason: 'bad-ttl' };
  }

  const issued_at = Math.floor(input.nowSeconds);
  const lease: PrivateMaterialLease = {
    kind: 'private-material-lease',
    object_key: input.objectKey,
    object_store_ref: input.objectStoreRef,
    cas_hash: input.casHash,
    subject: input.subject,
    required_access_refs: acceptedRefs(input.governingItem),
    issued_at,
    expires_at: issued_at + Math.floor(input.ttlSeconds),
  };
  return { status: 'grant', lease };
}

/** The refs the governing item requires, normalized to a sorted unique array
 *  (deterministic for canonical signing). Empty for a public item. */
function acceptedRefs(item: PrivateMaterialGoverningItem): string[] {
  const refs = new Set<string>();
  for (const ref of item.required_access_refs ?? []) if (ref) refs.add(ref);
  return [...refs].sort();
}

/**
 * Canonical bytes of a lease (SP4) — the deterministic, sorted-key serialization
 * that is signed at mint time and re-serialized for verification. BOTH the minting
 * target and the verifying shell route MUST produce identical bytes for an
 * identical lease, so this is the one canonicalizer. (Detached signature: the
 * signature is carried alongside, never embedded in the signed object.)
 */
export function canonicalLeaseBytes(lease: PrivateMaterialLease): string {
  // Keys emitted in a fixed order; arrays already deterministic via acceptedRefs.
  return JSON.stringify({
    kind: lease.kind,
    object_key: lease.object_key,
    object_store_ref: lease.object_store_ref,
    cas_hash: lease.cas_hash,
    subject: lease.subject,
    required_access_refs: lease.required_access_refs,
    issued_at: lease.issued_at,
    expires_at: lease.expires_at,
  });
}

export type LeaseValidity = 'valid' | 'expired' | 'malformed' | 'subject-mismatch';

/**
 * Pure structural + temporal validation of a lease the shell received (the shell
 * adds SIGNATURE verification on top — that is the authority; this catches the
 * cheap failures first and is mirrored in tests on both sides). `presentedSubject`
 * is the session account presenting the lease; a mismatch is rejected (SP7).
 */
export function checkLease(
  lease: Partial<PrivateMaterialLease> | null | undefined,
  nowSeconds: number,
  presentedSubject: string,
): LeaseValidity {
  if (!lease || lease.kind !== 'private-material-lease') return 'malformed';
  if (
    typeof lease.object_key !== 'string' || lease.object_key.length === 0 ||
    typeof lease.cas_hash !== 'string' || lease.cas_hash.length === 0 ||
    typeof lease.subject !== 'string' || lease.subject.length === 0 ||
    typeof lease.issued_at !== 'number' || typeof lease.expires_at !== 'number' ||
    lease.expires_at <= lease.issued_at
  ) {
    return 'malformed';
  }
  if (presentedSubject !== lease.subject) return 'subject-mismatch';
  if (nowSeconds >= lease.expires_at) return 'expired';
  return 'valid';
}
