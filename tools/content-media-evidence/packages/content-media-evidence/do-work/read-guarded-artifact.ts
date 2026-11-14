import { makeHashCodeHexFromBytes } from '@bitfield/runtime-kit/protocol';
import {
  decodeCanonicalArtifactRef,
  type CanonicalArtifactRef,
} from '../../../../record-voice-and-meetings/read-data/content-media-evidence';

export interface GuardedArtifactDecision {
  readonly allowed: boolean;
  readonly decision_ref: string;
  readonly subject_ref: string;
  readonly revision: number;
}

export interface GuardedArtifactReadDependencies {
  readonly resolveArtifactForRelation: (relationRef: string) => Promise<unknown>;
  readonly verifyDecision: (relationRef: string, proof: unknown) => Promise<GuardedArtifactDecision>;
  readonly readAddressBytes: (payloadAddress: string) => Promise<Uint8Array | null>;
}

export interface GuardedArtifactReadResult {
  readonly artifact_ref: CanonicalArtifactRef;
  readonly bytes: Uint8Array;
  readonly decision_ref: string;
}

type ChunkManifest = {
  schema: 'bitfield.addressed-chunks/v1';
  integrity_hash: string;
  byte_length: number;
  chunks: Array<{ payload_address: string; integrity_hash: string; byte_length: number }>;
};

const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_CHUNKS = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeManifest(bytes: Uint8Array): ChunkManifest | null {
  try {
    const value = JSON.parse(decoder.decode(bytes));
    if (!isRecord(value) || value.schema !== 'bitfield.addressed-chunks/v1' || !Array.isArray(value.chunks)) return null;
    if (typeof value.integrity_hash !== 'string' || !Number.isSafeInteger(value.byte_length) || value.byte_length < 0) return null;
    if (value.chunks.length > MAX_CHUNKS) return null;
    const chunks: ChunkManifest['chunks'] = [];
    for (const chunk of value.chunks) {
      if (!isRecord(chunk)
        || typeof chunk.payload_address !== 'string'
        || typeof chunk.integrity_hash !== 'string'
        || !Number.isSafeInteger(chunk.byte_length)
        || chunk.byte_length < 0) return null;
      chunks.push({
        payload_address: chunk.payload_address,
        integrity_hash: chunk.integrity_hash,
        byte_length: chunk.byte_length,
      });
    }
    return { schema: 'bitfield.addressed-chunks/v1', integrity_hash: value.integrity_hash, byte_length: value.byte_length, chunks };
  } catch {
    return null;
  }
}

function verifyBytes(bytes: Uint8Array, expectedHash: string, expectedLength: number, label: string): void {
  if (bytes.byteLength !== expectedLength) throw new Error(`${label} byte length mismatch`);
  if (makeHashCodeHexFromBytes(bytes) !== expectedHash) throw new Error(`${label} integrity mismatch`);
}

async function readArtifactBytes(
  ref: CanonicalArtifactRef,
  read: GuardedArtifactReadDependencies['readAddressBytes'],
): Promise<Uint8Array> {
  if (ref.payload_address_mode === 'address_bytes') {
    const bytes = await read(ref.payload_address);
    if (!bytes) throw new Error('artifact payload is missing');
    verifyBytes(bytes, ref.integrity_hash, ref.byte_length, 'artifact');
    return bytes;
  }
  const manifestBytes = await read(ref.payload_address);
  if (!manifestBytes) throw new Error('artifact chunk manifest is missing');
  const manifest = decodeManifest(manifestBytes);
  if (!manifest) throw new Error('artifact chunk manifest is invalid');
  if (manifest.integrity_hash !== ref.integrity_hash || manifest.byte_length !== ref.byte_length) {
    throw new Error('artifact chunk manifest does not match its reference');
  }
  const output = new Uint8Array(ref.byte_length);
  let offset = 0;
  for (const chunk of manifest.chunks) {
    if (offset + chunk.byte_length > output.byteLength) throw new Error('artifact chunks exceed the declared bound');
    const bytes = await read(chunk.payload_address);
    if (!bytes) throw new Error('artifact chunk is missing');
    verifyBytes(bytes, chunk.integrity_hash, chunk.byte_length, 'artifact chunk');
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (offset !== output.byteLength) throw new Error('artifact chunks do not fill the declared bound');
  verifyBytes(output, ref.integrity_hash, ref.byte_length, 'artifact');
  return output;
}

/** Relation possession is the only browser input. Payload addresses never grant
 * access: the current owner decision is verified before any address is read. */
export async function readGuardedArtifact(
  input: { readonly relation_ref: string; readonly decision_proof: unknown },
  dependencies: GuardedArtifactReadDependencies,
): Promise<GuardedArtifactReadResult> {
  if (!input.relation_ref.trim()) throw new Error('relation_ref is required');
  const decision = await dependencies.verifyDecision(input.relation_ref, input.decision_proof);
  if (!decision.allowed) throw new Error('artifact access denied');
  const artifact = decodeCanonicalArtifactRef(await dependencies.resolveArtifactForRelation(input.relation_ref));
  if (!artifact) throw new Error('relation does not resolve to a canonical artifact');
  const bytes = await readArtifactBytes(artifact, dependencies.readAddressBytes);
  return { artifact_ref: artifact, bytes, decision_ref: decision.decision_ref };
}
