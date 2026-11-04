// packages/group/do-work/attribute-bundle-palette.ts
//
// =============================================================================
// PURPOSE — P3: a Portable Attribute Bundle palette (named, reusable, OPAQUE)
// =============================================================================
//
// Persist a board-surface's SAVED BUNDLES as DATA, keyed by an opaque `kind`
// string. A "bundle" is any reusable attribute payload the user captured and can
// re-apply in one click: a composite text style (#88), a visual-layer stack
// (copy-the-layers-as-a-preset), a frame, a future thing nobody has invented.
// The palette never inspects inside a bundle — it is opaque JSON. The whole
// palette for one (surface, kind) lives in ONE label-addressed published record,
// read back directly (no admitted fold) and written via the canonical
// `engine.operation.write-batch`, exactly like the board graph itself.
//
// This is the GENERALIZATION of text-style-palette.ts: that file is the first
// (legacy-addressed) instance — saved TEXT styles — kept on its own address so
// already-persisted #88 styles are never orphaned. Every NEW saved-bundle kind
// (layer stacks, presets) uses THIS generic primitive: a new kind is a new
// `kind` string + DATA rows, ZERO new persistence code (L069/L090). The thing
// that APPLIES a bundle is blind to this module — it receives bundles as DATA
// and hands new ones back.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//   - DATA, not source: a saved bundle is a record; adding/removing one is a
//     write, never a code change. The bundle is OPAQUE (never inspected here).
//   - SSOT addressing: read and write use the SAME identity-text address, keyed
//     by (paletteId, kind) so kinds never collide.
//   - Surface-scoped: paletteId is the board-surface index id, so every board on
//     the surface shares one palette per kind.
//   - ZERO closed enum of kinds. `kind` is a plain string the caller chooses.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '#workspace-records';

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';
const PUBLISHED_RECORD_PATH = ['current-item', 'published-record'] as const;
const BUNDLE_PALETTE_RECORD_KIND = 'group-attribute-bundle-palette';

/** One named, reusable bundle. `bundle` is opaque DATA (this module never reads it). */
export interface SavedBundle<TBundle = unknown> {
  readonly id: string;
  readonly name: string;
  /** The opaque payload the consumer alone interprets (a CSS map, a layer stack…). */
  readonly bundle: TBundle;
}

export type PaletteSender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;

/** The single label address holding a surface's whole palette for one kind. */
export function bundlePaletteAddress(paletteId: string, kind: string): string {
  return `package::group::bundle-palette::${kind}::${paletteId}`;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function isSavedBundle(value: unknown): value is SavedBundle {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && 'bundle' in v;
}

/** Load the surface's saved bundles for one kind (empty when none persisted yet). */
export async function readBundlePalette<TBundle = unknown>(
  partitionLabel: string,
  paletteId: string,
  kind: string,
  sender: PaletteSender = sendRequestToBitfieldTarget as PaletteSender,
): Promise<SavedBundle<TBundle>[]> {
  const address = bundlePaletteAddress(paletteId, kind);
  const reply = await sender(
    buildEngineReadCurrentRequestFromLabels(partitionLabel, address, { addressMode: 'identity-text' }) as {
      target: string;
      payload: Uint8Array;
    },
  );
  const current = decodeEngineReadCurrentReply(payloadBytesFromReply(reply));
  if (!current.found) return [];
  const value = safeJson(textDecoder.decode(current.payload));
  const entries = value && typeof value === 'object' ? (value as { entries?: unknown }).entries : undefined;
  return Array.isArray(entries) ? (entries.filter(isSavedBundle) as SavedBundle<TBundle>[]) : [];
}

/** The engine write-batch request that overwrites the surface's whole palette for one kind. */
export function buildBundlePaletteWriteRequest(
  paletteId: string,
  kind: string,
  entries: readonly SavedBundle[],
) {
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: [
        {
          address_label: bundlePaletteAddress(paletteId, kind),
          address_mode: 'identity_text' as const,
          path_labels: [...PUBLISHED_RECORD_PATH],
          payload: { kind: BUNDLE_PALETTE_RECORD_KIND, bundle_kind: kind, entries: [...entries] },
        },
      ],
    },
  };
}

/** Persist the surface's saved bundles for one kind (read-modify-write the whole record). */
export async function writeBundlePalette(
  paletteId: string,
  kind: string,
  entries: readonly SavedBundle[],
  sender: PaletteSender = sendRequestToBitfieldTarget as PaletteSender,
): Promise<void> {
  await sender(
    buildBundlePaletteWriteRequest(paletteId, kind, entries) as unknown as { target: string; payload: Uint8Array },
  );
}

function payloadBytesFromReply(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (typeof reply === 'string') return textEncoder.encode(reply);
  if (reply && typeof reply === 'object') {
    const payload = (reply as { payload?: unknown }).payload;
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    if (typeof payload === 'string') return textEncoder.encode(payload);
  }
  throw new Error('engine.operation read-current reply did not include decodable payload bytes');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
