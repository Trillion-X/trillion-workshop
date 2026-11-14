// packages/service-connections/do-work/reveal-service-connection-credential.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Owner-gated plaintext reveal for an already-connected instance's stored
// credential fields. Deliberately SEPARATE from the connect/disconnect
// write paths — those never see raw secret material, and this module does
// not change that. This is a new, explicit, user-triggered READ path: the
// owner clicks "Reveal", the vault mints a one-time handle and resolves it,
// and the plaintext is rendered for exactly as long as the owner keeps it
// visible.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Reveal is READ-ONLY. It never writes a secret, never mutates a
//    connection fact, and never goes through a workflow owner action —
//    it speaks to slot::credentials-vault directly, exactly like
//    mint-credential-handle.ts's other functions.
// 2. Every one-time handle is consumed by the single resolve call that
//    follows it (see revealCredentialSecret in mint-credential-handle.ts) —
//    a captured payload cannot be replayed.
// 3. Field labels are recovered by REVERSING the self-describing naming
//    convention already used to WRITE the secret
//    (buildServiceConnectionFieldSecretName in connect-service.ts:
//    `${prefix}-${hex(connectionId)}-field-${hex(fieldId)}`). This is L090:
//    the secret name already carries its own field identity; no new DATA,
//    no vendor/field enumeration, no schema change. Refs that do not match
//    the convention (e.g. the single acquire-path handle, which has no
//    `-field-<hex>` suffix) fall back to a generic ordinal label — the
//    decode never throws.
// 4. Callers MUST render the returned plaintext and MUST NEVER log it,
//    cache it beyond the reveal session, or forward it through any workflow
//    action input/output.
//
// =============================================================================

import { revealCredentialSecret } from '@/packages/service-connections/do-work/mint-credential-handle';

/** One decoded, plaintext-resolved credential field ready to render masked-by-default. */
export interface RevealedServiceCredentialField {
  /** The vault secret name this value was resolved from (never rendered — diagnostic only). */
  secretName: string;
  /** Recovered field id ("api_key", "client_secret") — '' when the ref predates/skips the convention. */
  fieldId: string;
  /** Human label for the field row. Falls back to an ordinal when fieldId can't be recovered. */
  label: string;
  /** Resolved plaintext. Render masked by default; caller reveals on explicit click. */
  value: string;
}

const FIELD_SUFFIX_MARKER = '-field-';

/**
 * Reverses buildServiceConnectionFieldSecretName's `-field-${hex(fieldId)}`
 * suffix back into the original field id. Returns '' (never throws) for any
 * ref that doesn't carry the convention — the caller falls back to an
 * ordinal label.
 */
export function decodeServiceConnectionFieldId(secretName: string): string {
  const markerIndex = secretName.lastIndexOf(FIELD_SUFFIX_MARKER);
  if (markerIndex === -1) return '';

  const hex = secretName.slice(markerIndex + FIELD_SUFFIX_MARKER.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return '';

  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return decoded;
  } catch {
    return '';
  }
}

function labelForField(fieldId: string, ordinal: number): string {
  if (!fieldId) return `Stored value ${ordinal}`;
  // Field ids are written as their own snake_case identity ("api_key",
  // "client_secret") — present them in plain language without hardcoding
  // any specific provider's field name (L090: the label IS the data).
  return fieldId
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Resolves every credential ref on a connection instance to plaintext, one
 * vault round-trip per ref, decoding each ref's field label along the way.
 * A single ref failing to resolve (expired secret, revoked handle) does not
 * fail the whole reveal — its row carries the error message as its value
 * so the owner can see which field needs reconnecting.
 */
export async function revealServiceConnectionCredentials(
  credentialHandleRefs: string[],
): Promise<RevealedServiceCredentialField[]> {
  return Promise.all(
    credentialHandleRefs.map(async (secretName, index) => {
      const fieldId = decodeServiceConnectionFieldId(secretName);
      const label = labelForField(fieldId, index + 1);
      try {
        const value = await revealCredentialSecret({ secretName });
        return { secretName, fieldId, label, value };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not resolve this credential';
        return { secretName, fieldId, label, value: `⚠ ${message}` };
      }
    }),
  );
}
