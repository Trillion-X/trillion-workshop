// PORTED FROM: bitfield-packages/packages/chat/read-data/read-message-annotation-palette.ts @ e99ac5976
// packages/chat/read-data/read-message-annotation-palette.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Read the LIVE, DATA-driven message-annotation palette from the global
// published-records projection. The palette is the set of reaction symbols the
// picker offers (❤️ 👍 👎 😂 ‼️ ❓ ...) plus the message actions the menu offers
// (React, Pin, Star, Bookmark, ...). It is Society DATA — a new reaction symbol
// or a new durable annotation kind is ONE palette row and ZERO code (L090 /
// enum-dissolution). The surface renders EXACTLY the rows the DATA supplies.
//
// FAIL-CLOSED: if no palette record is published (or it is empty), the reader
// returns empty arrays, and MessageAnnotations renders NO affordance. The
// annotation UI only appears once the platform has admitted a palette DATA
// record — the picker never invents symbols the DATA did not authorize.
//
// This mirrors read-chat-prompt-assembly.ts exactly (one fixed address, read by
// recordId, one shared parser) so the live palette has a single source of truth.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure function — no React, no I/O. Unit-testable with plain data.
// 2. Self-describing rows (L090): a reaction is any row with a non-empty string
//    `symbol` + `glyph`; an action is any row with a non-empty `intentKind` +
//    `glyph` + `label`. The reader NEVER enumerates which symbols/kinds exist.
// 3. Returns empty arrays (never throws) on any malformed input — fail-closed.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { PublishedRecord } from '../../ui/show/placeable-surface-intent';
import type {
  ReactionPaletteEntry,
  MessageActionDescriptor,
} from './chat-message-types';

/** The canonical address of the DATA-driven message-annotation palette record. */
export const CHAT_MESSAGE_ANNOTATION_PALETTE_ADDRESS =
  'package::chat::message-annotation-palette::default';

/** The reader's result: the reaction symbols and message actions the UI offers. */
export interface MessageAnnotationPalette {
  reactionPalette: ReactionPaletteEntry[];
  messageActions: MessageActionDescriptor[];
}

const EMPTY: MessageAnnotationPalette = { reactionPalette: [], messageActions: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** A palette reaction row is self-describing: it carries a symbol AND a glyph. */
function readReactionEntry(value: unknown): ReactionPaletteEntry | null {
  if (!isRecord(value)) return null;
  const symbol = readString(value.symbol);
  const glyph = readString(value.glyph);
  if (!symbol || !glyph) return null;
  const label = readString(value.label);
  return label ? { symbol, glyph, label } : { symbol, glyph };
}

/** An action row is self-describing: intentKind + glyph + label. */
function readActionEntry(value: unknown): MessageActionDescriptor | null {
  if (!isRecord(value)) return null;
  const intentKind = readString(value.intentKind);
  const glyph = readString(value.glyph);
  const label = readString(value.label);
  if (!intentKind || !glyph || !label) return null;
  const descriptor: MessageActionDescriptor = { intentKind, glyph, label };
  if (value.opensPalette === true) descriptor.opensPalette = true;
  return descriptor;
}

function parsePalettePayload(payload: unknown): MessageAnnotationPalette {
  if (!isRecord(payload)) return EMPTY;
  const rawReactions = Array.isArray(payload.reactions) ? payload.reactions : [];
  const rawActions = Array.isArray(payload.actions) ? payload.actions : [];
  const reactionPalette = rawReactions
    .map(readReactionEntry)
    .filter((entry): entry is ReactionPaletteEntry => entry !== null);
  const messageActions = rawActions
    .map(readActionEntry)
    .filter((entry): entry is MessageActionDescriptor => entry !== null);
  return { reactionPalette, messageActions };
}

/**
 * Find the live message-annotation palette record in the published-records
 * catalog and parse it. Returns empty arrays when none is published or the
 * payload is malformed (fail-closed → no affordance renders).
 */
export function readMessageAnnotationPalette(
  records: readonly PublishedRecord[],
): MessageAnnotationPalette {
  for (const record of records) {
    if (record.recordId !== CHAT_MESSAGE_ANNOTATION_PALETTE_ADDRESS) continue;
    const payload =
      record.payload && typeof record.payload === 'object' ? record.payload : record.row;
    return parsePalettePayload(payload);
  }
  return EMPTY;
}
