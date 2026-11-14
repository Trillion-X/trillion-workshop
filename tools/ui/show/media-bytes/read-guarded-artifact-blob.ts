import { makeHashCodeHexFromBytes } from '#workspace-records';

export type GuardedArtifactDelivery = {
  bytes_base64: string;
  byte_length: number;
  integrity_hash: string;
  media_type: string;
  display_name: string;
  decision_ref: string;
};

export type GuardedArtifactObjectUrl = {
  bytes: Uint8Array;
  blob: Blob;
  displayName: string;
  mediaType: string;
  url: string;
  revoke(): void;
};

export type GuardedArtifactDispatch = (request: {
  target: string;
  payload: Record<string, unknown>;
}) => Promise<unknown>;

const MAX_BROWSER_DELIVERY_BYTES = 16 * 1024 * 1024;
const MAX_DELIVERY_REPLY_BYTES = Math.ceil(MAX_BROWSER_DELIVERY_BYTES / 3) * 4 + 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function decodeBase64(value: string): Uint8Array {
  let decoded: string;
  try { decoded = atob(value); } catch { throw new Error('guarded artifact bytes are not canonical base64'); }
  if (btoa(decoded) !== value) throw new Error('guarded artifact bytes are not canonical base64');
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function decodeGuardedArtifactDelivery(value: unknown): GuardedArtifactDelivery & { bytes: Uint8Array } {
  const raw = isRecord(value) && 'payload' in value ? value.payload : value;
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    const bytes = raw instanceof ArrayBuffer
      ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (bytes.byteLength > MAX_DELIVERY_REPLY_BYTES) throw new Error('guarded artifact reply exceeds the browser bound');
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  if (!isRecord(value)) throw new Error('guarded artifact delivery is invalid');
  const byteLength = value.byte_length;
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0 || (byteLength as number) > MAX_BROWSER_DELIVERY_BYTES) throw new Error('guarded artifact delivery exceeds the browser bound');
  const bytesBase64 = requiredText(value.bytes_base64, 'bytes_base64');
  if (bytesBase64.length !== Math.ceil((byteLength as number) / 3) * 4) throw new Error('guarded artifact base64 byte length mismatch');
  const bytes = decodeBase64(bytesBase64);
  if (bytes.byteLength !== byteLength) throw new Error('guarded artifact byte length mismatch');
  const integrityHash = requiredText(value.integrity_hash, 'integrity_hash');
  if (makeHashCodeHexFromBytes(bytes) !== integrityHash) throw new Error('guarded artifact integrity mismatch');
  const displayName = requiredText(value.display_name, 'display_name');
  if (/[\\/\u0000-\u001f\u007f]/.test(displayName) || displayName === '.' || displayName === '..') throw new Error('guarded artifact display name is unsafe');
  return {
    bytes_base64: bytesBase64,
    byte_length: byteLength as number,
    integrity_hash: integrityHash,
    media_type: requiredText(value.media_type, 'media_type').toLowerCase(),
    display_name: displayName,
    decision_ref: requiredText(value.decision_ref, 'decision_ref'),
    bytes,
  };
}

/** Convert one admitted owner delivery into an ephemeral browser URL. Persisted
 * records keep only relation identities; every caller must revoke the URL. */
export async function readGuardedArtifactObjectUrl(
  relationRef: string,
  dispatch: GuardedArtifactDispatch,
): Promise<GuardedArtifactObjectUrl> {
  if (!relationRef.trim()) throw new Error('relation_ref is required');
  // This selects the transport only. The native carrier and the fixed media
  // owner still verify the caller and current permission rule independently.
  const surface = (globalThis as typeof globalThis & {
    __BITFIELD_BROWSING_SURFACE__?: { mode?: string };
  }).__BITFIELD_BROWSING_SURFACE__;
  const local = surface?.mode === 'native-browsing-surface';
  let reply = await dispatch(local ? {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: 'action:content-media-evidence:read-local-guarded-artifact',
      input: { relation_ref: relationRef.trim() },
      include_output: true,
    },
  } : {
    target: 'content-media-evidence.read-guarded-artifact',
    payload: { relation_ref: relationRef.trim() },
  });
  if (local) {
    const raw = isRecord(reply) && 'payload' in reply ? reply.payload : reply;
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw)
        : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      if (bytes.byteLength > MAX_DELIVERY_REPLY_BYTES) throw new Error('guarded artifact reply exceeds the browser bound');
      reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } else reply = raw;
    if (!isRecord(reply) || !isRecord(reply.output)) throw new Error('The video could not be opened.');
    reply = reply.output;
  }
  const delivered = decodeGuardedArtifactDelivery(reply);
  const blob = new Blob([delivered.bytes], { type: delivered.media_type });
  const url = URL.createObjectURL(blob);
  let revoked = false;
  return {
    bytes: delivered.bytes,
    blob,
    displayName: delivered.display_name,
    mediaType: delivered.media_type,
    url,
    revoke() {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
    },
  };
}
