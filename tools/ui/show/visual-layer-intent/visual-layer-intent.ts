// packages/ui/show/visual-layer-intent/visual-layer-intent.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Drop-to-layer authoring: turn a dropped browser file into a VisualLayer
// descriptor that paints it as region wallpaper. Reuses the EXISTING opaque
// subject admission (placeable-surface-subject) — the same blob-handle path a
// dropped file already uses to open a preview — so a file dropped onto a region
// becomes a wallpaper layer with zero new byte plumbing.
//
// The capability is chosen GENERICALLY: the caller passes its capability pack
// and this module asks each capability `accepts(probe)` — it never hardcodes
// `image`/`video` ids. New visual kinds become droppable by registering a
// capability with an `accepts`, zero edits here.
// =============================================================================

import {
  admitPlaceableSurfaceSubject,
  readPlaceableSurfaceSubject,
} from '../placeable-surface-intent/placeable-surface-subject';
import { readPlaceableSurfaceEntryDescriptor } from '../placeable-surface-intent/placeable-surface-entry';
import type { AddressRef, VisualLayerDescriptor } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';
import type { VisualLayerCapability } from '../visual-layer-stack/visual-layer-registry';

const SUBJECT_FAMILY = 'placeable-surface-subject';
const DEFAULT_REGISTRY: AddressRef = { family: 'visual-layer.capabilities', parts: {} };
const WALLPAPER_Z = -1; // wallpaper sits behind content (content is z 0)

/** An AddressRef pointing at an admitted browser-local subject by its address. */
export function subjectAddressRef(address: string): AddressRef {
  return { family: SUBJECT_FAMILY, parts: { address } };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function makeLayerId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  return typeof randomUUID === 'function' ? `layer-${randomUUID.call(globalThis.crypto)}` : `layer-${Date.now().toString(36)}`;
}

/**
 * Ask the provided capability pack which capability paints this content type
 * (generic — iterates the pack, calls each `accepts`; no hardcoded ids).
 */
function pickCapabilityId(
  capabilities: Readonly<Record<string, VisualLayerCapability>>,
  contentType: string,
): string | null {
  for (const [id, capability] of Object.entries(capabilities)) {
    const accepts = capability.accepts;
    if (accepts && accepts({
      id: 'probe',
      paint: { capability: { registry: DEFAULT_REGISTRY, capabilityId: id }, input: { contentType } },
    })) {
      return id;
    }
  }
  return null;
}

export interface VisualLayerDrop {
  readonly descriptor: VisualLayerDescriptor;
  readonly subjectAddress: string;
}

/**
 * Read a browser drop into a wallpaper layer descriptor, or null if it isn't a
 * file we can paint. Admits the dropped blob as an opaque subject and references
 * it from the descriptor's input.
 */
export function readVisualLayerDrop(
  dataTransfer: DataTransfer,
  capabilities: Readonly<Record<string, VisualLayerCapability>>,
): VisualLayerDrop | null {
  const entry = readPlaceableSurfaceEntryDescriptor(dataTransfer);
  if (!entry || entry.handle === undefined) return null;
  const contentType = readString(entry.items[0]?.content_type) ?? 'application/octet-stream';
  const capabilityId = pickCapabilityId(capabilities, contentType);
  if (!capabilityId) return null; // nothing paints this kind → not a wallpaper drop

  const subject = admitPlaceableSurfaceSubject({
    origin: { source: entry.source, items: entry.items },
    display: { name: entry.title, content_type: contentType },
    content: { items: entry.items },
    handle: entry.handle,
  });

  const descriptor: VisualLayerDescriptor = {
    id: makeLayerId(),
    order: { z: WALLPAPER_Z },
    paint: {
      capability: { registry: DEFAULT_REGISTRY, capabilityId },
      input: { subject: subjectAddressRef(subject.ref.address), contentType, label: entry.title, fit: 'cover' },
    },
  };
  return { descriptor, subjectAddress: subject.ref.address };
}

/**
 * Dragover-safe paintability probe: can ANY visual-layer capability paint what
 * this drag is carrying? `readVisualLayerDrop` needs the dropped bytes
 * (`getData`/`files`), which the DnD API BLOCKS during `dragover` — so it cannot
 * decide a drop-zone's visibility while the user is still dragging. This reads
 * ONLY `DataTransferItem.kind`/`.type`, which ARE exposed during `dragover`, so a
 * drop-intent `accepts` can honestly offer a "set as background" zone EXACTLY
 * when the drop can actually become wallpaper — never a zone that no-ops.
 *
 * Internal structured app drags (`application/x-*` — tabs, records, placeable
 * surfaces, anything future) never carry external paintable bytes, so they are
 * excluded by the same one rule the entry-descriptor reader uses. Paintability
 * itself is decided by the injected capability pack (no hardcoded image/video).
 */
export function canPaintDataTransfer(
  dataTransfer: DataTransfer,
  capabilities: Readonly<Record<string, VisualLayerCapability>>,
): boolean {
  const types = Array.from(dataTransfer.types ?? []);
  if (types.some((type) => type.startsWith('application/x-'))) return false;
  return Array.from(dataTransfer.items ?? []).some(
    (item) => item.kind === 'file' && !!pickCapabilityId(capabilities, item.type),
  );
}

/**
 * Build a subject resolver for VisualLayerStack: turns a subject AddressRef back
 * into a browser object URL (memoized per address). Capabilities call this via
 * `ctx.resolveSubject`. Object URLs live for the session (matching the in-memory
 * blob-handle model dropped files already use).
 */
export function createVisualLayerSubjectResolver(): (ref: AddressRef) => string | null {
  const urlByAddress = new Map<string, string>();
  return (ref: AddressRef): string | null => {
    if (ref.family !== SUBJECT_FAMILY) return null;
    const address = ref.parts.address;
    if (!address) return null;
    const cached = urlByAddress.get(address);
    if (cached) return cached;
    const snapshot = readPlaceableSurfaceSubject(address);
    const handle = snapshot?.handle;
    if (!(handle instanceof Blob)) return null;
    const url = URL.createObjectURL(handle);
    urlByAddress.set(address, url);
    return url;
  };
}
