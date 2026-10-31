// tools/paid-access/read-data/delivery-token.ts
//
// The opaque handle that travels in a delivery URL path segment. It is a REFERENCE,
// not a bearer secret: it names the object and an upper-bound window. It carries NO
// entitlement and NO bytes — the guarded route's authorize step re-derives live
// entitlement from the presenter's session every time (live revocation, SSOT). A
// forged token can only name an `object_key`; the authority denies it unless the
// PRESENTER live-holds that object's required access. So the token needs no signature.
//
// Encoding is hex over UTF-8 JSON: deterministic, URL-safe, dependency-free (no
// Buffer/btoa — works identically in Node and the JSCore package runtime).

export type DeliveryToken = {
  /** The private object this URL addresses. */
  object_key: string;
  /** Epoch SECONDS the URL was minted. */
  issued_at: number;
  /** Epoch SECONDS after which the URL is stale (route may 410 before even asking). */
  expires_at: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hexEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function hexDecode(hex: string): string | null {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** Deterministic encode of a token to a URL path segment. */
export function encodeDeliveryToken(token: DeliveryToken): string {
  return hexEncode(JSON.stringify({
    object_key: token.object_key,
    issued_at: token.issued_at,
    expires_at: token.expires_at,
  }));
}

/** Decode a path segment back to a token, or null if malformed. Never throws. */
export function decodeDeliveryToken(segment: string | null | undefined): DeliveryToken | null {
  if (typeof segment !== 'string' || !segment) return null;
  const json = hexDecode(segment.trim());
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const objectKey = typeof parsed.object_key === 'string' ? parsed.object_key.trim() : '';
  const issuedAt = typeof parsed.issued_at === 'number' ? parsed.issued_at : NaN;
  const expiresAt = typeof parsed.expires_at === 'number' ? parsed.expires_at : NaN;
  if (!objectKey || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
  return { object_key: objectKey, issued_at: issuedAt, expires_at: expiresAt };
}
