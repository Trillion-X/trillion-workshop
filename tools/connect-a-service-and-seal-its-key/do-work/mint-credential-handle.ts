// packages/service-connections/do-work/mint-credential-handle.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Thin browser-side client for the `slot::credentials-vault` Envelope target.
// Raw credential material goes directly to the secret owner slot here, never
// through workflow action input/output state.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Raw secret material never goes through workflow owner actions
// 2. This module speaks only the slot::credentials-vault payload shape
// 3. Returned values are opaque handles or structured errors — never raw secrets
// 4. No durable storage or feed logic lives here
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const CREDENTIALS_VAULT_SLOT = 'slot::credentials-vault';

interface VaultQueryPayload {
  operation: string;
  key: string;
  value?: string;
  handle?: string;
  actor_id?: string;
  handle_ttl_seconds?: number;
  one_time?: boolean;
}

interface VaultQueryResponse {
  success?: unknown;
  handle?: unknown;
  value?: unknown;
  error?: unknown;
}

function decodeVaultReply(reply: unknown): VaultQueryResponse {
  if (!reply || typeof reply !== 'object') return {};
  const payload = (reply as { payload?: unknown }).payload;
  // Duck-type instead of `instanceof Uint8Array`: a byte view crossing a
  // realm boundary (a worker, an iframe, a jsdom test window vs. Node's
  // global) is a real Uint8Array with a different prototype object, so
  // `instanceof` false-negatives on it. `ArrayBuffer.isView` checks the
  // internal typed-array slot rather than the prototype chain, so it is
  // realm-independent and still rejects everything that isn't a byte view.
  if (!ArrayBuffer.isView(payload)) return {};
  const bytes = payload as Uint8Array;
  return JSON.parse(new TextDecoder().decode(bytes)) as VaultQueryResponse;
}

function parseVaultError(response: VaultQueryResponse, fallback: string): string {
  return typeof response.error === 'string' && response.error.length > 0
    ? response.error
    : fallback;
}

async function invokeCredentialsVault(
  payload: VaultQueryPayload,
): Promise<VaultQueryResponse> {
  const reply = await sendRequestToBitfieldTarget({
    target: CREDENTIALS_VAULT_SLOT,
    payload,
  });

  return decodeVaultReply(reply);
}

export async function writeCredentialSecret(input: {
  secretName: string;
  secretValue: string;
}): Promise<void> {
  const writeResponse = await invokeCredentialsVault({
    operation: 'write',
    key: input.secretName,
    value: input.secretValue,
  });

  if (writeResponse.success !== true) {
    throw new Error(parseVaultError(writeResponse, 'Failed to store credential'));
  }
}

export async function mintCredentialHandle(input: {
  secretName: string;
  secretValue: string;
  handleTtlSeconds?: number;
  oneTime?: boolean;
}): Promise<string> {
  const writeResponse = await invokeCredentialsVault({
    operation: 'write',
    key: input.secretName,
    value: input.secretValue,
  });

  if (writeResponse.success !== true) {
    throw new Error(parseVaultError(writeResponse, 'Failed to store credential'));
  }

  const readResponse = await invokeCredentialsVault({
    operation: 'read',
    key: input.secretName,
    handle_ttl_seconds: input.handleTtlSeconds,
    one_time: input.oneTime,
  });

  if (readResponse.success !== true) {
    throw new Error(parseVaultError(readResponse, 'Failed to mint credential handle'));
  }

  if (typeof readResponse.handle !== 'string' || readResponse.handle.length === 0) {
    throw new Error('slot::credentials-vault returned no opaque handle');
  }

  return readResponse.handle;
}

/**
 * Owner-gated plaintext reveal for an ALREADY-SEALED secret.
 *
 * This is a deliberate, separate read path — it never writes. It mints a
 * fresh one-time handle for the existing secret (`operation: "read"`) then
 * immediately resolves that handle to plaintext (`operation: "resolve_handle"`).
 * The one-time handle is consumed by this single resolve call, so a captured
 * network payload cannot be replayed to read the secret again.
 *
 * NON-NEGOTIABLE: the caller MUST use the returned plaintext immediately
 * (render it, let the user copy it) and MUST NEVER log it, persist it, or
 * pass it through workflow owner-action input/output state. This function
 * does not weaken the vault's sealing invariant — connect/disconnect still
 * never see raw secret material; only this explicit, user-triggered reveal
 * path does, and only for the instant it takes to render.
 */
export async function revealCredentialSecret(input: {
  secretName: string;
  actorId?: string;
}): Promise<string> {
  const readResponse = await invokeCredentialsVault({
    operation: 'read',
    key: input.secretName,
    one_time: true,
  });

  if (readResponse.success !== true) {
    throw new Error(parseVaultError(readResponse, 'Could not mint a reveal handle for this credential'));
  }

  if (typeof readResponse.handle !== 'string' || readResponse.handle.length === 0) {
    throw new Error('slot::credentials-vault returned no opaque handle');
  }

  const resolveResponse = await invokeCredentialsVault({
    operation: 'resolve_handle',
    key: input.secretName,
    handle: readResponse.handle,
    actor_id: input.actorId ?? 'service-connections-reveal-credential',
  });

  if (resolveResponse.success !== true) {
    throw new Error(parseVaultError(resolveResponse, 'Could not resolve this credential'));
  }

  if (typeof resolveResponse.value !== 'string') {
    throw new Error('slot::credentials-vault returned no value for this handle');
  }

  return resolveResponse.value;
}
