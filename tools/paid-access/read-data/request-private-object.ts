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
// Workshop function (`fn(input, { nowMs? })`), takes the verified subject, the file's `paid-file` row and the access
// rows as input instead of reading them (the caller's AI reads them from the person's stores), works out what the
// buyer holds itself (who-holds-access.mjs), and reads the run's own clock. It keeps nothing.

import { encodeDeliveryToken } from './delivery-token.ts';
import { readMaterialDeliveryConfig } from './material-delivery-config.ts';
import { resolvePrivateDelivery, type HoldsAccess } from './resolve-private-delivery.ts';
import { heldAccessRefsOf } from './who-holds-access.mjs';

export type RequestPrivateObjectInput = {
  /** The account the door verified from the buyer's session. */
  subject?: unknown;
  /** Whether the subject's email is verified, as the door read it from the session; purchases give nothing unless it is true. */
  email_verified?: unknown;
  /** Logical key of the private object the buyer is opening. */
  object_key?: unknown;
  /** The file's `paid-file` row, as tool:seal-a-paid-file answered it. */
  paid_file?: unknown;
  /** The access rows that decide what the subject holds (see tool:see-who-holds-paid-access): payment_events, offers, grants, rules, lifecycle. */
  payment_events?: unknown;
  offers?: unknown;
  grants?: unknown;
  rules?: unknown;
  lifecycle?: unknown;
  /** The door's route base path and default lease length. */
  delivery_config?: unknown;
};

export type RequestPrivateObjectResult =
  | { status: 'loading' }
  | { status: 'denied'; reason: 'not-entitled' | 'anonymous' }
  | { status: 'unavailable'; reason: 'no-bytes' | 'governing-item-missing' | 'bad-ttl' | 'authorization-unavailable' }
  | { status: 'grant'; delivery_url: string; expires_at: number; mime: string };

/** What a run is given: its own clock and (a test's stand-in for) the question "what does this account hold now?",
 *  which is who-holds-access.mjs over the request's access rows unless a caller says otherwise. */
export type DeliveryRunContext = { nowMs?: number; holds?: HoldsAccess };

export function holdsFor(input: RequestPrivateObjectInput, context: DeliveryRunContext, nowMs: number): HoldsAccess {
  return context.holds ?? (async (subject) => heldAccessRefsOf({ ...input, subject }, { nowMs }));
}

export async function requestPrivateObject(
  input: RequestPrivateObjectInput = {},
  context: DeliveryRunContext = {},
): Promise<RequestPrivateObjectResult> {
  const nowMs = context.nowMs ?? Date.now();
  const resolution = await resolvePrivateDelivery({
    subject: input.subject,
    holds: holdsFor(input, context, nowMs),
    objectKey: input.object_key,
    paidFile: input.paid_file,
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
