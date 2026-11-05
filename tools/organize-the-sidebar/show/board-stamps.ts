// packages/group/show/board-stamps.ts
//
// The board's catalog of emoji stamps — pure DATA (the #155 BOARD_SHAPES pattern
// applied to reaction markers). A stamp is a chrome-less board item (`kind:'stamp'`)
// carrying its glyph in its `text`; the blind `StampItem` renderer draws whatever
// emoji it finds and never knows what a "fire" or "star" MEANS (L090). Adding a stamp
// is ONE DATA row here — zero renderer/panel edits (an unknown emoji still renders as
// itself). Society DATA in the feature package, not the ui engine.
//
// Stamps are the FigJam/Miro "reaction" primitive: drop 🔥 on the idea you love, ⭐ on
// the priority, ✅ on what's done — expressive markers a vision/brainstorm board needs.

import { mergeCatalog } from '../read-data/catalog-merge.ts';

/** One named stamp: a stable id + human label the picker shows, and the emoji glyph
 *  the item carries in its `text` and the renderer draws. */
export interface BoardStamp {
  /** Stable id stored via the variant (never the emoji — an emoji could be re-skinned). */
  readonly id: string;
  /** Human label shown in the picker flyout (aria-label). */
  readonly label: string;
  /** The emoji glyph seeded into the item's `text` and rendered by the blind StampItem. */
  readonly emoji: string;
}

/** The starting stamp catalog. Order = display order. `fire` is first (the Stamp
 *  tool's main-button default — the most common "this is hot" reaction). */
export const BOARD_STAMPS: readonly BoardStamp[] = [
  { id: 'fire', label: 'Fire', emoji: '🔥' },
  { id: 'star', label: 'Star', emoji: '⭐' },
  { id: 'heart', label: 'Heart', emoji: '❤️' },
  { id: 'check', label: 'Check', emoji: '✅' },
  { id: 'thumbsup', label: 'Thumbs up', emoji: '👍' },
  { id: 'idea', label: 'Idea', emoji: '💡' },
  { id: 'question', label: 'Question', emoji: '❓' },
  { id: 'warning', label: 'Warning', emoji: '⚠️' },
  { id: 'party', label: 'Party', emoji: '🎉' },
  { id: 'eyes', label: 'Eyes', emoji: '👀' },
] as const;

/** Resolve a stamp id → its emoji glyph. Unknown/undefined id → the first stamp's
 *  emoji (never empty, so a stale id still renders a visible marker). */
export function stampEmojiById(
  id: string | undefined,
  catalog: readonly BoardStamp[] = BOARD_STAMPS,
): string {
  if (id) {
    const found = catalog.find((s) => s.id === id);
    if (found) return found.emoji;
  }
  return catalog[0]?.emoji ?? BOARD_STAMPS[0].emoji;
}

/** The published-record payload kind carrying user-defined stamps (Society DATA). */
export const STAMP_CATALOG_KIND = 'stamp-catalog';

/** Validate one untrusted stamp DATA row (id/label/emoji all required — a stamp with no glyph
 *  is meaningless). Any unicode string is a valid emoji glyph (L090 — the renderer draws it
 *  blindly), so a user's ✦/🌈/custom glyph works with zero code. */
function stampFromData(row: Record<string, unknown>): BoardStamp | null {
  return typeof row.id === 'string' && typeof row.label === 'string' && typeof row.emoji === 'string'
    ? { id: row.id, label: row.label, emoji: row.emoji }
    : null;
}

/**
 * The EFFECTIVE stamp catalog = the built-in {@link BOARD_STAMPS} plus any user-defined stamps
 * from `stamp-catalog` published-records (Society DATA), via the generic {@link mergeCatalog}
 * primitive (same as markers/backgrounds/presets) — so "which stamps exist" is DATA. A DATA
 * row overrides a built-in by id, else appends.
 */
export function readStampCatalog(
  records: ReadonlyArray<{ payload?: unknown }>,
): BoardStamp[] {
  return mergeCatalog(records, {
    kind: STAMP_CATALOG_KIND,
    arrayKey: 'stamps',
    idOf: (s) => s.id,
    parseRow: stampFromData,
    builtins: BOARD_STAMPS,
  });
}
