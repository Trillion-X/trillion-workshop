// packages/group/do-work/text-style-palette.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Persist a board-surface's SAVED TEXT STYLES as DATA. A "saved style" is a named
// bundle of CSS properties (bold+italic+font+size+colour+…) the user captured from
// a selection and can reapply in one click. The whole palette for a surface lives
// in ONE label-addressed published record — read back directly (no admitted fold
// needed), written via the canonical `engine.operation.write-batch` request, exactly
// like the board graph itself (`read-group-board.ts`) and guided-overlay progress.
//
// The toolbar/engine that APPLIES a style is blind to this module — it only receives
// the composite bundles as DATA (`FormatOption.composite`) and hands new ones back
// through `onSaveComposite`. This is the persistence half of that contract.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//   - DATA, not source: a style is a record; adding/removing one is a write, never
//     a code change. The CSS bundle is opaque (the engine never inspects its keys).
//   - SSOT addressing: read and write use the SAME identity-text address.
//   - Surface-scoped: the palette id is the board-surface index id, so every board
//     on the surface shares one style palette.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '#workspace-records';

export const TEXT_STYLE_PALETTE_KIND = 'group-text-style-palette';
const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';
const PUBLISHED_RECORD_PATH = ['current-item', 'published-record'] as const;

/** The CSS properties a saved style captures from the selection — DATA, so the owner
 *  decides what "a text style" remembers. */
export const TEXT_STYLE_CAPTURE_PROPERTIES: readonly string[] = [
  'fontWeight',
  'fontStyle',
  'textDecorationLine',
  'fontFamily',
  'fontSize',
  'color',
  'backgroundColor',
];

/** One named, reusable composite text style. `composite` is an opaque CSS bundle. */
export interface SavedTextStyle {
  readonly id: string;
  readonly name: string;
  readonly composite: Record<string, string>;
}

export type PaletteSender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;

/** The single label address holding a surface's whole style palette. */
export function textStylePaletteAddress(paletteId: string): string {
  return `package::group::text-style-palette::${paletteId}`;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function isSavedTextStyle(value: unknown): value is SavedTextStyle {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && !!v.composite && typeof v.composite === 'object';
}

/** Load the surface's saved styles (empty when none persisted yet). */
export async function readTextStylePalette(
  partitionLabel: string,
  paletteId: string,
  sender: PaletteSender = sendRequestToBitfieldTarget as PaletteSender,
): Promise<SavedTextStyle[]> {
  const address = textStylePaletteAddress(paletteId);
  const reply = await sender(
    buildEngineReadCurrentRequestFromLabels(partitionLabel, address, { addressMode: 'identity-text' }) as {
      target: string;
      payload: Uint8Array;
    },
  );
  const current = decodeEngineReadCurrentReply(payloadBytesFromReply(reply));
  if (!current.found) return [];
  const value = safeJson(textDecoder.decode(current.payload));
  const styles = value && typeof value === 'object' ? (value as { styles?: unknown }).styles : undefined;
  return Array.isArray(styles) ? styles.filter(isSavedTextStyle) : [];
}

/** The engine write-batch request that overwrites the surface's whole palette. */
export function buildTextStylePaletteWriteRequest(paletteId: string, styles: readonly SavedTextStyle[]) {
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: [
        {
          address_label: textStylePaletteAddress(paletteId),
          address_mode: 'identity_text' as const,
          path_labels: [...PUBLISHED_RECORD_PATH],
          payload: { kind: TEXT_STYLE_PALETTE_KIND, styles: [...styles] },
        },
      ],
    },
  };
}

/** Persist the surface's saved styles (read-modify-write the whole palette record). */
export async function writeTextStylePalette(
  paletteId: string,
  styles: readonly SavedTextStyle[],
  sender: PaletteSender = sendRequestToBitfieldTarget as PaletteSender,
): Promise<void> {
  await sender(buildTextStylePaletteWriteRequest(paletteId, styles) as unknown as { target: string; payload: Uint8Array });
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
