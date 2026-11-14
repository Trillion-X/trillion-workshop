// packages/public-scene-share/do-work/create-capsule-target.ts
//
// T2 — the `public-scene-share.create-capsule` GENERIC ENVELOPE TARGET (converged
// Claude+Codex 2026-06-26: a self-describing package target, NOT a client-direct
// import — so ANY surface can mint a shareable copy of an arrangement by invoking
// the target, with ZERO cross-package compile coupling).
//
// This is the THIN live-I/O adapter around the proven-pure `publishSceneCapsule`
// pipeline (`create-capsule.ts`, proven live end-to-end by the mint proof). It
// wires `publishSceneCapsule`'s injected deps to the browser-side engine I/O
// (`sendRequestToBitfieldTarget` + the read-current / write-batch / hash protocol
// helpers), runs the closure→content-address→CAS-write, and returns a human-free
// machine reply `{ ok, capsuleHash, contentPath }`. Translation to human copy
// (Share / Get link) happens at the ui/ boundary, never here (L098).
//
// Injectable `sender` (defaults to the real SDK) keeps the composition unit-
// testable with a mocked engine — the live behavior is already proven by the
// mint proof; the unit test proves THIS adapter composes the pipeline correctly.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromPartitionReference,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  makeHashCodeHexFromBytes,
  type EnginePartitionReference,
} from '@bitfield/runtime-kit/protocol';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';
import { publishSceneCapsule, type ScenePublisherDeps } from './create-capsule';
import type { CapsuleTier } from '../capsule/scene-capsule';
import { pruneSceneToRoot } from '../capsule/prune-scene';

/** The materialized scene sink the studio renders (the projector output root). */
const DEFAULT_SCENE_ADDRESS = 'scene';
/** Where capsule bytes anchor in the log so the engine does not collect them. */
const DEFAULT_CAPSULE_ADDRESS_PREFIX = 'public-scene-share::capsule';
const DEFAULT_CAPSULE_PATH_LABELS = ['public-scene-share', 'capsule'] as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Decoded-level engine I/O — the BOUNDARY the deps-builder consumes (L098). The
 * SDK protocol (read-current request → decode reply; write-batch request) is a
 * thin default adapter (`sdkEngineIo`); tests inject a trivial mock instead, so
 * the closure composition is unit-testable without the live protocol layer.
 */
export interface CapsuleEngineIo {
  /** Read the current value at an address; `payload` is null when absent. */
  readonly readCurrent: (partition: EnginePartitionReference, addressLabel: string) => Promise<{ found: boolean; payload: Uint8Array | null }>;
  /** Append content bytes to the log under a content-addressed label. */
  readonly writeBytes: (partition: EnginePartitionReference, addressLabel: string, pathLabels: readonly string[], payloadBytes: Uint8Array) => Promise<void>;
}

/** Extract decodable payload bytes from a sender reply (mirrors the SDK callers). */
function payloadBytesFromReply(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (typeof reply === 'string') return textEncoder.encode(reply);
  if (reply && typeof reply === 'object' && 'payload' in reply) {
    const payload = (reply as { payload?: unknown }).payload;
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    if (typeof payload === 'string') return textEncoder.encode(payload);
  }
  throw new Error('engine.operation read-current reply did not include decodable payload bytes');
}

/** The real SDK protocol adapter: read-current + write-batch over `sendRequestToBitfieldTarget`. */
export const sdkEngineIo: CapsuleEngineIo = {
  readCurrent: async (partition, addressLabel) => {
    const reply = decodeEngineReadCurrentReply(
      payloadBytesFromReply(await sendRequestToBitfieldTarget(
        buildEngineReadCurrentRequestFromPartitionReference(partition, addressLabel),
      )),
    );
    return { found: reply.found, payload: reply.found ? reply.payload : null };
  },
  writeBytes: async (partition, addressLabel, pathLabels, payloadBytes) => {
    await sendRequestToBitfieldTarget(
      buildEngineWriteBatchRequestFromLabels([{
        ...partition,
        addressLabel,
        pathLabels: [...pathLabels],
        payloadBytes,
      }]),
    );
  },
};

/** Sanitize a content hash into an address-label segment (keeps the codec `:`). */
function addressSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, '-');
}

/** What to mint. ALL data — no instance-specific code, no Society vocabulary leak. */
export type CreateCapsuleRequest = EnginePartitionReference & {
  /** The materialized scene sink address (defaults to the projector `scene` root). */
  readonly sceneAddressLabel?: string;
  /** Scope the capsule to a single scene sub-root (the presentation `root`): only
   *  that view's subtree is frozen, not the whole scene. Absent = the whole scene.
   *  Fail-closed — an unknown id refuses to mint (never silently the whole scene). */
  readonly rootNodeId?: string;
  /** Delivery tier — drives the tier-closure validator. Defaults to public. */
  readonly tier?: CapsuleTier;
  /** The resolved subtractive ChromeVisibilityMap frozen into the capsule. */
  readonly frozenChrome?: unknown;
  /** Are the scene's components independently public on the CDN tier? */
  readonly publicReadable?: boolean;
  /** Where capsule bytes anchor in the log (defaults to the package namespace). */
  readonly capsuleAddressPrefix?: string;
};

/** Machine reply. The ui/ layer translates this into human copy — never the reverse. */
export type CreateCapsuleReply =
  | { readonly ok: true; readonly capsuleHash: string; readonly contentPath: string; readonly byteLength: number }
  | { readonly ok: false; readonly failureReason: string };

/**
 * Build the live `ScenePublisherDeps` from the injected engine sender. Factored out
 * so the wiring (read-current scene, read-current component bytes → hash, write-batch
 * capsule bytes → CAS) is one place and the composition is unit-testable.
 */
export function buildScenePublisherDeps(
  request: CreateCapsuleRequest,
  io: CapsuleEngineIo,
): ScenePublisherDeps {
  const partition = capsulePartitionReference(request);
  const sceneAddress = request.sceneAddressLabel ?? DEFAULT_SCENE_ADDRESS;
  const casPrefix = request.capsuleAddressPrefix ?? DEFAULT_CAPSULE_ADDRESS_PREFIX;

  return {
    readScene: async () => {
      const current = await io.readCurrent(partition, sceneAddress);
      if (!current.found || current.payload == null) {
        throw new Error(`scene sink not found at ${partitionDescription(partition)}/${sceneAddress}`);
      }
      const sceneTree = JSON.parse(textDecoder.decode(current.payload));
      // Scope to the chosen sub-root (presentation `root`); fail-closed on a miss.
      if (request.rootNodeId) {
        const pruned = pruneSceneToRoot(sceneTree, request.rootNodeId);
        if (pruned == null) throw new Error(`scene root "${request.rootNodeId}" not found in ${sceneAddress}`);
        return pruned;
      }
      return sceneTree;
    },
    resolveComponentHash: async (source) => {
      const current = await io.readCurrent(
        source.partition ? { partitionLabel: source.partition } : partition,
        source.address,
      );
      if (!current.found || current.payload == null) return '';
      return makeHashCodeHexFromBytes(Uint8Array.from(current.payload));
    },
    storeBytes: async (bytes) => {
      const hash = makeHashCodeHexFromBytes(bytes);
      await io.writeBytes(
        partition,
        `${casPrefix}::${addressSegment(hash)}`,
        DEFAULT_CAPSULE_PATH_LABELS,
        bytes,
      );
    },
    hashBytes: makeHashCodeHexFromBytes,
  };
}

function capsulePartitionReference(request: CreateCapsuleRequest): EnginePartitionReference {
  const partitionLabel = typeof request.partitionLabel === 'string'
    ? request.partitionLabel.trim()
    : '';
  const partitionMultihashCodeHex = typeof request.partitionMultihashCodeHex === 'string'
    ? request.partitionMultihashCodeHex.trim()
    : '';
  if ((partitionLabel.length > 0) === (partitionMultihashCodeHex.length > 0)) {
    throw new TypeError(
      'create capsule requires exactly one of partitionLabel or partitionMultihashCodeHex',
    );
  }
  if (partitionLabel) return { partitionLabel };
  makeMultihashEncodedBytesFromCodeHex(partitionMultihashCodeHex);
  return { partitionMultihashCodeHex };
}

function partitionDescription(partition: EnginePartitionReference): string {
  return 'partitionLabel' in partition
    ? partition.partitionLabel
    : partition.partitionMultihashCodeHex;
}

/**
 * The `public-scene-share.create-capsule` target export. Freezes the live scene
 * into an immutable, content-addressed capsule in CAS and returns its hash + path.
 * On an incomplete/tier-invalid closure it writes nothing and returns a structured
 * failure (fail-closed — never a blank capsule).
 */
export async function createCapsuleTarget(
  request: CreateCapsuleRequest,
  _context?: { packageData?: unknown },
  io: CapsuleEngineIo = sdkEngineIo,
): Promise<CreateCapsuleReply> {
  let result;
  try {
    const deps = buildScenePublisherDeps(request, io);
    result = await publishSceneCapsule(deps, {
      tier: request.tier ?? 'public',
      frozenChrome: request.frozenChrome ?? null,
      publicReadable: request.publicReadable,
    });
  } catch (error) {
    // Fail-closed (L083): a live-I/O error (scene missing, engine unreachable)
    // returns a structured failure — never a thrown crash into the caller.
    return { ok: false, failureReason: error instanceof Error ? error.message : 'capsule mint failed' };
  }
  if (result.ok) {
    return { ok: true, capsuleHash: result.capsuleHash, contentPath: result.contentPath, byteLength: result.byteLength };
  }
  const refIssues = result.validation?.referenceIssues ?? [];
  const tierIssues = result.validation?.tierIssues ?? [];
  return {
    ok: false,
    failureReason: refIssues.length > 0
      ? `incomplete closure: ${refIssues.length} unresolved reference(s)`
      : tierIssues.length > 0
        ? `tier-closure violation: ${tierIssues.length} non-public subresource(s)`
        : 'capsule closure failed validation',
  };
}
