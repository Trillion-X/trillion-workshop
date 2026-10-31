// tools/paid-access/read-data/resolve-private-delivery.ts
//
// The shared brain both delivery tools call: it produces the SAME fail-closed entitlement decision for a private
// object.
//   - `request-private-object` calls it to decide whether to hand back a delivery URL.
//   - `authorize-private-object` (called by the door's byte route) calls it again, per stream-open, so entitlement is
//     RE-CHECKED at every open (instant revocation).
//
// Ported from bitfield-packages packages/material-delivery do-work/resolve-private-delivery.ts. Changed: the old engine
// sends are gone.
//   - The subject came from an `account-session.browser-session` send. It is now the `subject` the caller hands in,
//     which must be the account the door verified from the buyer's own session, never a name the buyer typed.
//   - Access came from a `product-access` send. It is now `holds`, a function that answers the access refs the
//     buyer holds at this moment (who-holds-access.mjs) or null when it cannot be worked out. It is asked only when
//     there is a sealed file and a subject, and a null is never read as "holds nothing" or "holds everything": it
//     answers unavailable.
//   - The object-store map came from an engine read. It is now the person's `paid-file` record, id = the object key,
//     read through the records door. The object's required refs come from that record (the OBJECT's property), never
//     from the caller.
// The decision itself is the unchanged pure leaf `decidePrivateDelivery`.

import { decidePrivateDelivery, type PrivateMaterialLease } from './private-object-lease.ts';
import { findObjectStoreEntry, type ObjectStoreEntry } from './object-store-map.ts';
import { readMaterialDeliveryConfig } from './material-delivery-config.ts';

export const PAID_FILE_TYPE = 'paid-file';

export type PrivateDeliveryResolution =
  | { status: 'loading' }
  | { status: 'denied'; reason: 'not-entitled' | 'anonymous' }
  | { status: 'unavailable'; reason: 'no-bytes' | 'governing-item-missing' | 'bad-ttl' | 'authorization-unavailable' }
  | { status: 'grant'; entry: ObjectStoreEntry; subject: string; lease: PrivateMaterialLease };

/** The records door, as tools/records-door's client gives it: only `read` is used. */
export type PaidFileRecords = { read(type: string, id: string): Promise<unknown> };

/** The access refs a subject holds now, or null when that cannot be worked out. Never throws into the decision. */
export type HoldsAccess = (subject: string) => Promise<string[] | null>;

export type ResolvePrivateDeliveryInput = {
  /** The account the door verified from the buyer's session ('' = anonymous). */
  subject: unknown;
  holds: HoldsAccess;
  objectKey: unknown;
  /** The person's records, holding the `paid-file` rows. */
  records: PaidFileRecords;
  /** The door's `delivery_config` (route base path, default lease length). */
  deliveryConfig?: unknown;
  /** Whole seconds from the run's own clock: a caller never chooses the time. */
  nowSeconds: number;
};

function str(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** The `paid-file` row for one object key; `loaded: false` when the records cannot be read (never a guess). */
async function readPaidFile(records: PaidFileRecords, objectKey: string): Promise<{ loaded: boolean; entry: ObjectStoreEntry | undefined }> {
  if (!objectKey) return { loaded: true, entry: undefined };
  try {
    const value = await records.read(PAID_FILE_TYPE, objectKey);
    return { loaded: true, entry: value == null ? undefined : findObjectStoreEntry([value], objectKey) };
  } catch {
    return { loaded: false, entry: undefined };
  }
}

/**
 * Resolve the private-delivery decision for `objectKey` for `subject`. Fail-closed at every gap (no subject, no held
 * list, no access, no bytes, no row). On `grant` it returns the object authority row + the minted lease.
 */
export async function resolvePrivateDelivery(input: ResolvePrivateDeliveryInput): Promise<PrivateDeliveryResolution> {
  const config = readMaterialDeliveryConfig(input.deliveryConfig);
  const objectKey = str(input.objectKey);
  if (typeof input.nowSeconds !== 'number' || !Number.isFinite(input.nowSeconds)) {
    throw new Error('resolvePrivateDelivery requires nowSeconds from the run\'s clock');
  }
  const subject = str(input.subject);
  const { loaded, entry } = await readPaidFile(input.records, objectKey);
  let held: string[] | null = [];
  if (loaded && entry && subject) {
    try { held = await input.holds(subject); } catch { held = null; }
    if (held === null) return { status: 'unavailable', reason: 'authorization-unavailable' };
  }

  const decision = decidePrivateDelivery({
    catalogLoaded: loaded,
    grantedAccessRefs: held,
    governingItem: entry ? { required_access_refs: entry.required_access_refs } : undefined,
    objectKey,
    objectStoreRef: entry?.object_store_ref ?? '',
    casHash: entry?.cas_hash,
    subject,
    nowSeconds: input.nowSeconds,
    ttlSeconds: entry?.ttl_seconds ?? config.defaultTtlSeconds,
  });

  if (decision.status === 'grant') {
    return { status: 'grant', entry: entry as ObjectStoreEntry, subject, lease: decision.lease };
  }
  return decision;
}
