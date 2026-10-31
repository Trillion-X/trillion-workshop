// tools/paid-access/read-data/request-private-object.ts
//
// tool:give-a-buyer-a-paid-file-link — the MINT step, called when a buyer opens a paid file. It checks entitlement
// (via the shared brain) and, on grant, returns a time-limited delivery URL pointing at the door's guarded byte
// route. It returns NO bytes and NO key: only a URL the buyer's browser can GET.
//
// The URL's token is an opaque reference (object_key + window); the real gate is re-applied at the byte route's
// authorize step (tool:open-a-paid-file-for-a-buyer). So this "grant" is a fast answer ("show the player"), not the
// security boundary.
//
// Ported from bitfield-packages packages/material-delivery do-work/request-private-object.ts. Changed: it runs as a
// Workshop function (`fn(input, { door })` through tools/records-door), takes the verified subject as input instead
// of a browser session id, works out what the buyer holds itself (who-holds-access.mjs), and reads the run's own clock.

import { encodeDeliveryToken } from './delivery-token.ts';
import { readMaterialDeliveryConfig } from './material-delivery-config.ts';
import { resolvePrivateDelivery, type HoldsAccess, type PaidFileRecords } from './resolve-private-delivery.ts';
import { heldAccessRefsOf } from './who-holds-access.mjs';

export type RequestPrivateObjectInput = {
  /** The account the door verified from the buyer's session. */
  subject?: unknown;
  /** Logical key of the private object the buyer is opening. */
  object_key?: unknown;
  /** The door's route base path and default lease length. */
  delivery_config?: unknown;
};

export type RequestPrivateObjectResult =
  | { status: 'loading' }
  | { status: 'denied'; reason: 'not-entitled' | 'anonymous' }
  | { status: 'unavailable'; reason: 'no-bytes' | 'governing-item-missing' | 'bad-ttl' | 'authorization-unavailable' }
  | { status: 'grant'; delivery_url: string; expires_at: number; mime: string };

/** What a run is given: the records door, its own clock, and (a test's stand-in for) the question "what does this
 *  account hold now?", which is who-holds-access.mjs over the door unless a caller says otherwise. */
/** The door as who-holds-access.mjs uses it too: one read, and a list by kind. */
export type PaidAccessDoor = PaidFileRecords & { list(query: { type: string }): AsyncIterable<{ value?: unknown }> };

export type DeliveryRunContext = { door: PaidAccessDoor; nowMs?: number; holds?: HoldsAccess };

export function holdsFor(context: DeliveryRunContext, nowMs: number): HoldsAccess {
  return context.holds ?? ((subject) => heldAccessRefsOf(subject, { door: context.door, nowMs }));
}

export async function requestPrivateObject(
  input: RequestPrivateObjectInput = {},
  context: DeliveryRunContext,
): Promise<RequestPrivateObjectResult> {
  const nowMs = context.nowMs ?? Date.now();
  const resolution = await resolvePrivateDelivery({
    subject: input.subject,
    holds: holdsFor(context, nowMs),
    objectKey: input.object_key,
    records: context.door,
    deliveryConfig: input.delivery_config,
    nowSeconds: Math.floor(nowMs / 1000),
  });

  if (resolution.status !== 'grant') return resolution;

  const config = readMaterialDeliveryConfig(input.delivery_config);
  const token = encodeDeliveryToken({
    object_key: resolution.entry.object_key,
    issued_at: resolution.lease.issued_at,
    expires_at: resolution.lease.expires_at,
  });
  return {
    status: 'grant',
    delivery_url: `${config.deliveryBasePath}/${token}`,
    expires_at: resolution.lease.expires_at,
    mime: resolution.entry.mime ?? 'application/octet-stream',
  };
}
