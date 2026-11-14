// product-access/do-work/read-account-granted-access-refs.ts
//
// Async read path: given a signed-in account id, return the capability access refs it holds.
// Queries the signed-event-authority effect ledger (`list-effects` with { subject }) and
// reduces the `license_access` effects to a flat ref list via the pure
// grantedAccessRefsFromEffects reader.
//
// This is the runtime door the customer-library entitlement gate calls. The browser cannot
// read the EEAF fact store directly; it asks the authority for this account's effects.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { makeHashCodeHexFromBytes, makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';
import { grantedAccessProjectionFromEffects } from '../read-data/read-granted-access-refs';

const LIST_EFFECTS_TARGET = 'signed-event-authority.list-effects';

export class GrantedAccessProjectionUnavailableError extends Error {
  constructor(readonly retry_class: 'transport' | 'invalid_response' | 'authorization_clock') {
    super('Access could not be checked.');
    this.name = 'GrantedAccessProjectionUnavailableError';
  }
}

export async function readAuthorizationTimeForRef(ownerRef: string): Promise<number> {
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: 'permission-lease.read-authorization-time',
      payload: { request_ref: `product-access:${makeHashCodeHexFromBytes(new TextEncoder().encode(ownerRef))}` },
    });
    let value = (reply as { payload?: unknown } | null)?.payload;
    if (value instanceof ArrayBuffer) value = new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      if (value.byteLength > 4096) throw new Error('oversized time response');
      value = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    if (typeof value === 'string') {
      if (value.length > 4096) throw new Error('oversized time response');
      value = JSON.parse(value);
    }
    const time = value as { now_ms?: unknown; observation_ref?: unknown; observation_hash?: unknown } | null;
    if (!time || !Number.isSafeInteger(time.now_ms) || Number(time.now_ms) < 0
      || time.observation_ref !== 'package::permission-lease::authorization-time'
      || typeof time.observation_hash !== 'string') throw new Error('invalid time response');
    makeMultihashEncodedBytesFromCodeHex(time.observation_hash);
    return Number(time.now_ms);
  } catch {
    throw new GrantedAccessProjectionUnavailableError('authorization_clock');
  }
}

function checkedReply(value: unknown): { effects: Record<string, unknown>[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GrantedAccessProjectionUnavailableError('invalid_response');
  }
  const effects = (value as { effects?: unknown }).effects;
  if (!Array.isArray(effects) || !effects.every((effect) => (
    effect !== null && typeof effect === 'object' && !Array.isArray(effect)
  ))) throw new GrantedAccessProjectionUnavailableError('invalid_response');
  return { effects: effects as Record<string, unknown>[] };
}

function parseReply(payload: unknown): { effects: Record<string, unknown>[] } {
  if (payload && typeof payload === 'object' && !ArrayBuffer.isView(payload) && !(payload instanceof ArrayBuffer)) {
    return checkedReply(payload);
  }
  let bytes: Uint8Array;
  if (payload instanceof Uint8Array) {
    bytes = payload;
  } else if (payload instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload);
  } else if (ArrayBuffer.isView(payload)) {
    bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  } else if (typeof payload === 'string') {
    bytes = new TextEncoder().encode(payload);
  } else {
    throw new GrantedAccessProjectionUnavailableError('invalid_response');
  }
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1_024 * 1_024) {
    throw new GrantedAccessProjectionUnavailableError('invalid_response');
  }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return checkedReply(parsed);
  } catch {
    throw new GrantedAccessProjectionUnavailableError('invalid_response');
  }
}

/**
 * Active capability access refs held by `accountId` (empty for no account / no grants).
 * Transport and malformed replies throw; unavailable access is not confirmed empty access.
 */
export async function readAccountGrantedAccessRefs(accountId: string | null | undefined): Promise<string[]> {
  return (await readAccountGrantedAccessProjection(accountId)).granted_access_refs;
}

/**
 * Current entitlement projection plus a deterministic revision. Any grant or
 * revocation that changes effective access refs changes this revision, so an
 * admitted owner action can fail closed when membership changes.
 */
export async function readAccountGrantedAccessProjection(accountId: string | null | undefined): Promise<{ granted_access_refs: string[]; membership_revision: string }> {
  const subject = typeof accountId === 'string' ? accountId.trim() : '';
  const project = (source: { effects: Record<string, unknown>[] }, nowMs?: number) => {
    const projection = grantedAccessProjectionFromEffects(source, nowMs);
    return {
      granted_access_refs: projection.granted_access_refs,
      membership_revision: makeHashCodeHexFromBytes(new TextEncoder().encode(projection.membership_revision_input)),
    };
  };
  if (!subject) return project({ effects: [] });
  let reply: unknown;
  try {
    reply = await sendRequestToBitfieldTarget({ target: LIST_EFFECTS_TARGET, payload: { subject } });
  } catch {
    throw new GrantedAccessProjectionUnavailableError('transport');
  }
  const source = parseReply((reply as { payload?: unknown } | null)?.payload);
  const needsTime = source.effects.some((effect) => {
    const material = effect.material;
    return effect.kind === 'license_access' && material !== null && typeof material === 'object'
      && (Object.prototype.hasOwnProperty.call(material, 'valid_from_ms')
        || Object.prototype.hasOwnProperty.call(material, 'expires_at_ms'));
  });
  return project(source, needsTime ? await readAuthorizationTimeForRef(subject) : undefined);
}
