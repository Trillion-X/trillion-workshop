// tools/paid-access/read-data/authorize-private-object.ts
//
// tool:open-a-paid-file-for-a-buyer — the AUTHORITY the door's guarded byte route calls ONCE per stream-open. It is
// where the lease and entitlement knowledge lives, so the route stays a plain byte plumber. Given the opaque token the
// browser presented and the PRESENTER (the account the door verified from the presenting session), it RE-DERIVES
// entitlement from that account's access now and, on grant, returns the bytes' content hash and how they are sealed,
// so the route can stream (decrypting when `enc_alg` is set).
//
// A re-check at every open is instant revocation: a refunded or ended purchase denies the very next open. The
// subject is the PRESENTER, not anything in the token, so a leaked URL replayed by a different account is denied
// (that account lacks the access).
//
// Ported from bitfield-packages packages/material-delivery do-work/authorize-private-object.ts. Changed: it runs as a
// Workshop function, takes the presenter as input, works out what they hold itself (who-holds-access.mjs), reads the
// run's own clock, and answers the NAME of the decryption key (`enc_key_ref`) where the package answered the key
// itself: a tool's answer goes to an AI, and the key reaches only the door that decrypts, from the person's held
// values, on a private pipe.

import { decodeDeliveryToken } from './delivery-token.ts';
import { resolvePrivateDelivery } from './resolve-private-delivery.ts';
import { holdsFor, type DeliveryRunContext } from './request-private-object.ts';

export type AuthorizePrivateObjectInput = {
  /** Opaque token from the delivery URL path segment. */
  token?: unknown;
  /** The account the door verified from the PRESENTING session. */
  subject?: unknown;
  delivery_config?: unknown;
};

export type AuthorizePrivateObjectResult =
  | { authorized: false }
  | {
      authorized: true;
      cas_hash: string;
      /** The name of the at-rest decryption key in the person's held values (empty → bytes are plaintext). */
      enc_key_ref: string;
      /** Cipher nonce/IV needed to decrypt the authorized object. */
      enc_nonce: string;
      /** DATA-selected cipher capability id (empty → plaintext). */
      enc_alg: string;
      mime: string;
      expires_at: number;
    };

function str(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export async function authorizePrivateObject(
  input: AuthorizePrivateObjectInput = {},
  context: DeliveryRunContext,
): Promise<AuthorizePrivateObjectResult> {
  const token = decodeDeliveryToken(str(input.token));
  if (!token) return { authorized: false };

  const nowMs = context.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);

  // URL-hygiene upper bound: a stale URL is rejected without even asking for the access.
  if (nowSeconds >= token.expires_at) return { authorized: false };

  const resolution = await resolvePrivateDelivery({
    subject: input.subject,
    holds: holdsFor(context, nowMs),
    objectKey: token.object_key,
    records: context.door,
    deliveryConfig: input.delivery_config,
    nowSeconds,
  });
  if (resolution.status !== 'grant') return { authorized: false };

  return {
    authorized: true,
    cas_hash: resolution.entry.cas_hash,
    enc_key_ref: resolution.entry.enc_key_ref ?? '',
    enc_nonce: resolution.entry.enc_nonce ?? '',
    enc_alg: resolution.entry.enc_alg ?? '',
    mime: resolution.entry.mime ?? 'application/octet-stream',
    expires_at: resolution.lease.expires_at,
  };
}
