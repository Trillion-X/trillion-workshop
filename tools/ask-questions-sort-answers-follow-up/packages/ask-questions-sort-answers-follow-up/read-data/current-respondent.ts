// packages/ask-questions-sort-answers-follow-up/read-data/current-respondent.ts
//
// Resolves the STABLE respondent identity for a fill session — "whose answers
// are these?". Before this file the fill surface minted a fresh random id on
// every mount, so a single student's repeated submissions never grouped under
// one respondent, and no per-student progress could fold. This resolver gives
// each respondent ONE stable id across sessions, in three layers:
//
// 1. Explicit override first — a `respondentId` the surface is DATA-bound to
//    (placeable-surface config), the identity-binding seam a host can supply.
// 2. Signed-in student second — the runner exposes the account package's
//    `account-session.browser-session` door as a PUBLIC TARGET. This file
//    invokes that door with the package's own transport call (no sibling
//    package source is imported — isolation boundary, envelope-address
//    architecture) and derives the stable `accountIdHash` from the reply. A
//    signed-in student's sessions group across every device they use.
// 3. Stable per-device fallback last — a persisted browser id (NOT a fresh
//    per-mount random), so even an anonymous respondent's sessions on one
//    device still group under one id. Generated once, reused forever.
//
// The door read is cached for the page load and bounded by a short timeout, so
// signed-out (or slow) sessions settle on the per-device id and the surface
// keeps working offline. The `respondentId` this returns is the form package's
// own opaque grouping key; the identity SOURCE is account-session (reused by
// address, never re-owned — no god package).

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

/** The account package's public door that reports the current browser session. */
const BROWSER_SESSION_TARGET = 'account-session.browser-session';
/** The account package keeps its per-browser id at this localStorage key.
 *  Reading it (never writing it) is a data convention, not a source import. */
const BROWSER_ID_STORAGE_KEY = 'bitfield.account-session.browser-id';
/** This package's own persisted per-device respondent id — the anonymous
 *  fallback that stays stable across mounts (replaces fresh-per-mount random). */
const DEVICE_RESPONDENT_STORAGE_KEY = 'bitfield.ask-questions.device-respondent-id';
/** Signed-out / slow sessions settle on the per-device id after this bound. */
const BROWSER_SESSION_TIMEOUT_MS = 1500;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — unit-testable)
// ---------------------------------------------------------------------------

export function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // A Uint8Array is `typeof 'object'` — exclude typed-array views so a raw
  // bytes reply decodes as bytes, not mis-unwrapped as a `{payload}` envelope.
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

/** Decode the door reply → the stable respondent id, or null when signed out.
 *  Reply shape: `{ session: { accountIdHash, ... } | null }` (bytes or object). */
export function respondentIdFromSessionReply(raw: unknown): string | null {
  // `ArrayBuffer.isView` is realm-safe (unlike `instanceof Uint8Array`, which
  // fails on bytes minted in another realm — e.g. a test's TextEncoder).
  let decoded: unknown = raw;
  if (isRecord(raw) && ArrayBuffer.isView(raw.payload)) {
    decoded = raw.payload; // envelope form: { payload: <bytes> }
  }
  if (ArrayBuffer.isView(decoded)) {
    const text = textDecoder.decode(decoded as ArrayBufferView);
    if (!text.trim()) return null;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(decoded) || !isRecord(decoded.session)) return null;
  return readText(decoded.session.accountIdHash) ?? readText(decoded.session.accountId);
}

/** Priority: explicit override → signed-in student → stable per-device id.
 *  Never returns empty — `deviceId` is always a non-empty fallback. */
export function pickRespondentId(
  explicit: string | null | undefined,
  signedIn: string | null | undefined,
  deviceId: string,
): string {
  return readText(explicit) ?? readText(signedIn) ?? deviceId;
}

/** A fresh respondent id — used ONCE to seed the per-device fallback, then
 *  persisted and reused (so it is stable, unlike the old per-mount mint). */
export function freshRespondentId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `r-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// I/O — the public door read + the persisted per-device id
// ---------------------------------------------------------------------------

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The account package's per-browser id, if a session was ever started here. */
function storedBrowserId(): string | null {
  return readText(localStore()?.getItem(BROWSER_ID_STORAGE_KEY) ?? null);
}

/** Read (or generate + persist once) this device's stable respondent id.
 *  When storage is unavailable, falls back to a fresh id (best effort). */
export function persistedDeviceRespondentId(): string {
  const store = localStore();
  const existing = readText(store?.getItem(DEVICE_RESPONDENT_STORAGE_KEY) ?? null);
  if (existing) return existing;
  const seeded = freshRespondentId();
  try {
    store?.setItem(DEVICE_RESPONDENT_STORAGE_KEY, seeded);
  } catch {
    /* storage may be full/blocked — the seeded id is still returned this load */
  }
  return seeded;
}

/** Invoke the public browser-session door and derive the signed-in respondent
 *  id. No stored browser id → no session to ask about → null. */
async function readSignedInRespondentId(): Promise<string | null> {
  const browserId = storedBrowserId();
  if (!browserId) return null;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), BROWSER_SESSION_TIMEOUT_MS);
  try {
    const reply = await sendRequestToBitfieldTarget(
      {
        target: BROWSER_SESSION_TARGET,
        payload: textEncoder.encode(JSON.stringify({ browser_id: browserId })),
      },
      controller.signal,
    );
    return respondentIdFromSessionReply(reply);
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

// One door read per page load, shared by every submission on the screen.
let cachedSignedInRespondentId: string | null | undefined;
let pendingSignedInRespondentId: Promise<string | null> | null = null;

function resolveSignedInRespondentId(): Promise<string | null> {
  if (cachedSignedInRespondentId !== undefined) {
    return Promise.resolve(cachedSignedInRespondentId);
  }
  pendingSignedInRespondentId ??= readSignedInRespondentId().then((id) => {
    cachedSignedInRespondentId = id;
    pendingSignedInRespondentId = null;
    return id;
  });
  return pendingSignedInRespondentId;
}

/** Resolve the stable respondent id for THIS submission, awaiting the signed-in
 *  door read so a signed-in student never falls through to the device id on a
 *  fast submit. Explicit override wins; else signed-in; else per-device. */
export async function resolveRespondentIdNow(explicit?: string): Promise<string> {
  const override = readText(explicit);
  if (override) return override;
  const signedIn = await resolveSignedInRespondentId();
  return pickRespondentId(null, signedIn, persistedDeviceRespondentId());
}

/** Test-only: reset the per-load door-read cache. */
export function __resetRespondentCacheForTest(): void {
  cachedSignedInRespondentId = undefined;
  pendingSignedInRespondentId = null;
}
